// SessionManager — the driver-agnostic core. Fakes for tmux/driver/fallback and
// MANUAL timers make the full state machine deterministic with zero processes.
// This file is also the fake-worker E2E (T10): the test plays the worker by
// calling getTask()/submitResult() the way the real worker MCP tools would.

import { describe, it, expect } from 'vitest';

import { SessionManager } from './manager.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

function fakeTmux() {
  return {
    created: [], killed: [], _sessions: [], _pane: '',
    async newSession(name) { this.created.push(name); this._sessions.push(name); },
    async killSession(name) { this.killed.push(name); this._sessions = this._sessions.filter((s) => s !== name); },
    async listSessions() { return [...this._sessions]; },
    async capturePane() { return this._pane; },
  };
}

// Driver whose nudge + healthcheck are observable/controllable from the test.
function fakeDriver() {
  const d = {
    id: 'claude',
    nudges: [],
    health: { healthy: true, reason: null },
    sessionName: (id) => `sigil-${id}`,
    buildLaunch: ({ workerId }) => ({ argv: ['claude', '--bare'], files: [{ path: `/tmp/${workerId}.json`, content: '{}' }] }),
    async nudge(_tmux, name) { d.nudges.push(name); },
    async healthcheck() { return d.health; },
  };
  return d;
}

// Manual timer scheduler — test fires the dead-man timer by calling fire().
function manualTimers() {
  const handles = [];
  return {
    handles,
    set(ms, cb) { const h = { ms, cb, cancelled: false }; handles.push(h); return h; },
    clear(h) { if (h) h.cancelled = true; },
    // Fire the most recent live timer (the one a just-dispatched task armed).
    async fireLast() {
      const h = [...handles].reverse().find((x) => !x.cancelled);
      if (h) { h.cancelled = true; await h.cb(); }
    },
  };
}

function makeManager(overrides = {}) {
  const tmux = overrides.tmux || fakeTmux();
  const driver = overrides.driver || fakeDriver();
  const timers = overrides.timers || manualTimers();
  const fallbackCalls = [];
  const fallback = overrides.fallback || (async (task) => { fallbackCalls.push(task); return { text: 'FALLBACK', model: 'haiku' }; });

  const events = [];
  const mgr = new SessionManager({
    tmux,
    getDriver: () => driver,
    fallback,
    pools: overrides.pools || { claude: 1 },
    tokenBudget: overrides.tokenBudget ?? 60_000,
    firstTaskTimeoutMs: overrides.firstTaskTimeoutMs ?? 10_000,
    maxBootFailures: overrides.maxBootFailures ?? 3,
    timers,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
    log: () => {},
    onEvent: (ev) => events.push(ev),
  });
  return { mgr, tmux, driver, timers, fallbackCalls, events };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Tests ─────────────────────────────────────────────────────────────────

describe('SessionManager — warm path (fake-worker E2E)', () => {
  it('correlates a result back to its submit() promise by reqId', async () => {
    const { mgr, driver } = makeManager();
    await mgr.start();
    const wid = mgr.stats().workers[0].id;

    const p = mgr.submit({ sourceType: 'claude', prompt: 'extract facts from X', model: 'haiku' });
    expect(driver.nudges).toHaveLength(1); // worker was nudged

    // Play the worker: pull the task, then submit the result.
    const task = mgr.getTask(wid);
    expect(task).toEqual({ reqId: expect.any(String), prompt: 'extract facts from X' });
    mgr.submitResult(wid, task.reqId, '{"facts":["a"]}');

    const r = await p;
    expect(r.text).toBe('{"facts":["a"]}');
    expect(r.viaFallback).toBe(false);
    expect(mgr.stats().workers[0].state).toBe('ready'); // returned to the pool
  });

  it('getTask reports empty when the worker has no assigned task', async () => {
    const { mgr } = makeManager();
    await mgr.start();
    const wid = mgr.stats().workers[0].id;
    expect(mgr.getTask(wid)).toEqual({ empty: true });
  });

  it('is idempotent: a duplicate/late submit_result is ignored (resolve-once)', async () => {
    const { mgr } = makeManager();
    await mgr.start();
    const wid = mgr.stats().workers[0].id;

    const p = mgr.submit({ sourceType: 'claude', prompt: 'x' });
    const { reqId } = mgr.getTask(wid);
    expect(mgr.submitResult(wid, reqId, 'first').ok).toBe(true);
    const dup = mgr.submitResult(wid, reqId, 'second');
    expect(dup.duplicate).toBe(true);
    await expect(p).resolves.toMatchObject({ text: 'first' }); // first wins
  });
});

describe('SessionManager — failure envelope', () => {
  it('dead-man timeout falls back to one-shot AND recycles the worker', async () => {
    const { mgr, tmux, driver, timers, fallbackCalls } = makeManager();
    await mgr.start();
    const wid0 = mgr.stats().workers[0].id;

    const p = mgr.submit({ sourceType: 'claude', prompt: 'never answered' });
    mgr.getTask(wid0); // worker pulled it but will "never" call back

    await timers.fireLast(); // dead-man fires
    const r = await p;
    expect(r.viaFallback).toBe(true);
    expect(r.text).toBe('FALLBACK');
    expect(fallbackCalls).toHaveLength(1);

    await tick();
    // old session killed, a fresh worker respawned (different id)
    expect(tmux.killed).toContain(`sigil-${wid0}`);
    expect(driver.nudges.length).toBeGreaterThanOrEqual(1);
    const ids = mgr.stats().workers.map((w) => w.id);
    expect(ids).not.toContain(wid0);
    expect(ids).toHaveLength(1);
  });

  it('a late real result after a fallback does not double-resolve', async () => {
    const { mgr, timers } = makeManager();
    await mgr.start();
    const wid = mgr.stats().workers[0].id;
    const p = mgr.submit({ sourceType: 'claude', prompt: 'slow' });
    const { reqId } = mgr.getTask(wid);

    await timers.fireLast();            // fallback settles the promise
    const r = await p;
    expect(r.viaFallback).toBe(true);
    // worker calls back late — must be a no-op, not a throw
    expect(() => mgr.submitResult(wid, reqId, 'late')).not.toThrow();
  });

  it('falls back directly when there are no workers for the source type', async () => {
    const { mgr, fallbackCalls } = makeManager({ pools: {} });
    await mgr.start();
    const r = await mgr.submit({ sourceType: 'claude', prompt: 'x' });
    expect(r.viaFallback).toBe(true);
    expect(fallbackCalls).toHaveLength(1);
  });
});

describe('SessionManager — recycle + health', () => {
  it('recycles a worker once it crosses the token budget', async () => {
    const { mgr, tmux } = makeManager({ tokenBudget: 1 }); // any work trips it
    await mgr.start();
    const wid0 = mgr.stats().workers[0].id;

    const p = mgr.submit({ sourceType: 'claude', prompt: 'some prompt' });
    const { reqId } = mgr.getTask(wid0);
    mgr.submitResult(wid0, reqId, 'done');
    await p;
    await tick();

    expect(tmux.killed).toContain(`sigil-${wid0}`);
    expect(mgr.stats().workers.map((w) => w.id)).not.toContain(wid0);
  });

  it('probeHealth recycles a worker wedged on a blocking dialog before timeout', async () => {
    const { mgr, tmux, driver, fallbackCalls } = makeManager();
    await mgr.start();
    const wid0 = mgr.stats().workers[0].id;

    const p = mgr.submit({ sourceType: 'claude', prompt: 'will wedge' });
    mgr.getTask(wid0);
    driver.health = { healthy: false, reason: 'blocking prompt: trust the files' };

    await mgr.probeHealth(); // sweep finds the wedge, recycles early
    const r = await p;
    expect(r.viaFallback).toBe(true);      // task still completed via fallback
    expect(fallbackCalls).toHaveLength(1);
    await tick();
    expect(tmux.killed).toContain(`sigil-${wid0}`);
  });
});

describe('SessionManager — pool + boot', () => {
  it('dispatches concurrent tasks across a pool of N workers', async () => {
    const { mgr } = makeManager({ pools: { claude: 2 } });
    await mgr.start();
    expect(mgr.stats().workers).toHaveLength(2);
    const ids = mgr.stats().workers.map((w) => w.id);

    // Workers boot (handshake) shortly after daemon start, BEFORE ingest tasks
    // arrive — their first get_task readies them.
    for (const id of ids) expect(mgr.getTask(id)).toEqual({ empty: true });
    expect(mgr.stats().workers.every((w) => w.state === 'ready')).toBe(true);

    const p1 = mgr.submit({ sourceType: 'claude', prompt: 'one' });
    const p2 = mgr.submit({ sourceType: 'claude', prompt: 'two' });
    expect(mgr.stats().workers.filter((w) => w.state === 'busy')).toHaveLength(2); // both busy at once

    // each worker holds one task; resolve via its assigned worker
    for (const id of ids) {
      const t = mgr.getTask(id);
      if (!t.empty) mgr.submitResult(id, t.reqId, `r:${t.prompt}`);
    }
    expect((await p1).text).toMatch(/^r:/);
    expect((await p2).text).toMatch(/^r:/);
  });

  it('queues a second task when the single worker is busy, then drains it', async () => {
    const { mgr } = makeManager({ pools: { claude: 1 } });
    await mgr.start();
    const wid = mgr.stats().workers[0].id;

    const p1 = mgr.submit({ sourceType: 'claude', prompt: 'first' });
    const p2 = mgr.submit({ sourceType: 'claude', prompt: 'second' });

    // The worker boots on its first get_task, which dispatches `first` to it and
    // leaves `second` queued behind the now-busy worker.
    const t1 = mgr.getTask(wid);
    expect(t1.prompt).toBe('first');
    expect(mgr.stats().queued.claude).toBe(1); // second waits

    mgr.submitResult(wid, t1.reqId, 'r1');
    await p1;
    // releasing the worker dispatches the queued task to the same worker
    const t2 = mgr.getTask(wid);
    expect(t2.prompt).toBe('second');
    mgr.submitResult(wid, t2.reqId, 'r2');
    expect((await p2).text).toBe('r2');
  });

  it('reconciles orphaned sigil-* sessions on boot but leaves foreign ones', async () => {
    const tmux = fakeTmux();
    tmux._sessions = ['sigil-stale-9', 'my-editor'];
    const { mgr } = makeManager({ tmux });
    await mgr.start();
    expect(tmux.killed).toContain('sigil-stale-9');
    expect(tmux.killed).not.toContain('my-editor');
  });
});

describe('SessionManager — boot handshake (finding-1 fix)', () => {
  it('starts a worker BOOTING and does not dispatch real work until its first get_task', async () => {
    const { mgr, driver } = makeManager();
    await mgr.start();
    const wid = mgr.stats().workers[0].id;

    // Booting: a warm-up nudge was sent, but the worker is NOT dispatchable yet.
    expect(mgr.stats().workers[0].state).toBe('booting');
    expect(driver.nudges).toEqual([`sigil-${wid}`]); // the boot nudge only

    // A task submitted now just queues — we never nudge it into a cold pane.
    mgr.submit({ sourceType: 'claude', prompt: 'extract' });
    expect(mgr.stats().queued.claude).toBe(1);
    expect(mgr.stats().workers[0].state).toBe('booting');

    // The handshake: the worker's first get_task flips it READY and the queued
    // task is dispatched on this very poll.
    const t = mgr.getTask(wid);
    expect(t.prompt).toBe('extract');
    expect(mgr.stats().workers[0].state).toBe('busy');
  });

  it('re-nudges once when the boot keystroke is swallowed, then recovers on get_task', async () => {
    const { mgr, driver, timers, tmux } = makeManager();
    await mgr.start();
    const wid = mgr.stats().workers[0].id;
    expect(driver.nudges).toHaveLength(1); // boot nudge

    await timers.fireLast(); // boot timer fires: worker still silent → re-nudge once
    expect(driver.nudges).toHaveLength(2);     // re-nudged
    expect(tmux.killed).toHaveLength(0);       // not recycled yet
    expect(mgr.stats().workers[0].state).toBe('booting');

    // The re-nudge lands: the worker handshakes and is usable.
    expect(mgr.getTask(wid)).toEqual({ empty: true });
    expect(mgr.stats().workers[0].state).toBe('ready');
  });

  it('recycles a worker that never boots after one retry', async () => {
    const { mgr, tmux, timers } = makeManager();
    await mgr.start();
    const wid0 = mgr.stats().workers[0].id;

    await timers.fireLast(); // 1st boot deadline → re-nudge
    await timers.fireLast(); // 2nd boot deadline → give up + recycle

    expect(tmux.killed).toContain(`sigil-${wid0}`);
    const ids = mgr.stats().workers.map((w) => w.id);
    expect(ids).not.toContain(wid0);
    expect(ids).toHaveLength(1); // a fresh worker respawned
  });

  it('stops respawning after maxBootFailures, yielding to the one-shot path', async () => {
    const { mgr, timers, fallbackCalls } = makeManager({ maxBootFailures: 1 });
    await mgr.start();

    await timers.fireLast(); // re-nudge
    await timers.fireLast(); // give up → recycleBoot: fails=1, not < 1 → no respawn

    expect(mgr.hasWorkers('claude')).toBe(false); // pool yielded
    const r = await mgr.submit({ sourceType: 'claude', prompt: 'x' });
    expect(r.viaFallback).toBe(true); // one-shot path
    expect(fallbackCalls).toHaveLength(1);
  });
});

describe('SessionManager — telemetry events (attribution)', () => {
  it('emits dispatch + result events carrying workerId/reqId/caller for the Activity feed', async () => {
    const { mgr, events } = makeManager();
    await mgr.start();
    const wid = mgr.stats().workers[0].id;
    events.length = 0; // ignore worker-ready from boot handshake below

    const p = mgr.submit({ sourceType: 'claude', prompt: 'extract', model: 'haiku', caller: 'extractor' });
    const task = mgr.getTask(wid); // boots+ready (worker-ready) then dispatch
    mgr.submitResult(wid, task.reqId, '{"facts":[]}');
    const r = await p;

    // Result carries correlation back to the caller → flows into llm_log.
    expect(r).toMatchObject({ workerId: wid, reqId: task.reqId, viaFallback: false });

    const dispatch = events.find((e) => e.type === 'dispatch');
    expect(dispatch).toMatchObject({ workerId: wid, reqId: task.reqId, caller: 'extractor', session: `sigil-${wid}` });
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ workerId: wid, reqId: task.reqId, caller: 'extractor', session: `sigil-${wid}` });
    expect(result.durationMs).not.toBeNull();
  });

  it('emits a fallback event (no-workers) with the reason', async () => {
    const { mgr, events } = makeManager({ pools: {} });
    await mgr.start();
    await mgr.submit({ sourceType: 'claude', prompt: 'x', caller: 'audm' });
    const fb = events.find((e) => e.type === 'fallback');
    expect(fb).toMatchObject({ reason: 'no-workers', caller: 'audm', workerId: null });
  });

  it('emits fallback + recycle on a dead-man timeout', async () => {
    const { mgr, timers, events } = makeManager();
    await mgr.start();
    const wid = mgr.stats().workers[0].id;
    const p = mgr.submit({ sourceType: 'claude', prompt: 'never', caller: 'synth' });
    mgr.getTask(wid);
    await timers.fireLast(); // dead-man fires
    await p;
    expect(events.find((e) => e.type === 'fallback')).toMatchObject({ reason: 'timeout', caller: 'synth' });
    expect(events.find((e) => e.type === 'recycle')).toMatchObject({ reason: 'timeout', workerId: wid });
  });
});
