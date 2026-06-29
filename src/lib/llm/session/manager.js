/**
 * SessionManager — the driver-agnostic core of the managed-session engine.
 *
 * Problem it solves: the one-shot `claude -p` provider spawns a fresh agentic
 * process per LLM call. An ingest fires 5–20 calls, so that's 5–20 cold starts —
 * the RAM + subscription-usage bloat. This keeps a small set of WARM workers
 * (one pool per source type, default size 1) alive in tmux and streams tasks to
 * them. Workers return results out-of-band over MCP, so we never parse a flaky
 * TUI pane.
 *
 * ── Data flow ───────────────────────────────────────────────────────────────
 *   caller → submit({sourceType, prompt}) ─┐  returns a Promise<result>
 *                                           ▼
 *     queue[sourceType] ── dispatch() ── pick a READY worker ── driver.nudge()
 *                                           │ worker: get_task() over MCP
 *                                           │ worker: …extract…
 *                                           ▼ worker: submit_result(reqId) over MCP
 *     submitResult() ── correlate reqId ── resolve the Promise ── worker READY
 *
 * ── Guarantees ────────────────────────────────────────────────────────────
 *  • Correlation: every task carries a reqId; submit_result echoes it back.
 *  • Idempotent: a duplicate/late submit_result is ignored (resolve-once).
 *  • Dead-man timeout: if a worker never calls back (wedged on an auth/trust
 *    dialog, crashed, or just forgot the tool call) the task runs via the
 *    one-shot fallback so the caller ALWAYS completes, and the worker is
 *    recycled. The system can never be worse than the one-shot path.
 *  • Bounded context bleed: workers recycle on a token budget (per plan D4);
 *    the driver's system prompt orders strict per-task independence.
 *  • Bounded RAM: at most poolSize live processes per source type.
 *
 * Every side-effecting dependency is injected (tmux, driver, fallback, timers,
 * clock, fs) so the whole state machine unit-tests with no real processes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

import { estimateTokens } from '../log.js';

const DEFAULTS = {
  poolSize: 1,
  tokenBudget: 60_000,        // recycle a worker once it has processed ~this many tokens
  taskTimeoutMs: 120_000,     // dead-man timeout per task → fallback + recycle
  firstTaskTimeoutMs: 10_000, // boot handshake window: re-nudge once, then recycle
  maxBootFailures: 3,         // consecutive boot failures before yielding to one-shot
};

// Worker lifecycle states. Recycle is only ever entered from READY (never
// mid-BUSY), so a token-budget trip can't kill a worker with a live task.
//
// ── Boot handshake ──────────────────────────────────────────────────────────
//   spawnWorker ── tmux launch + warm-up nudge ──▶ BOOTING (NOT dispatchable)
//        │  boot timer (firstTaskTimeoutMs): silent? re-nudge once, then recycle
//        ▼  worker's FIRST get_task() lands  ── proof the pane is live ──
//   READY ──▶ dispatch real work. We never nudge a task into a pane that has
//   not finished booting (finding-1 fix: a lost cold-boot nudge no longer costs
//   a full dead-man timeout — it costs one ~10s boot retry).
const STATE = { BOOTING: 'booting', READY: 'ready', BUSY: 'busy', UNHEALTHY: 'unhealthy' };

export class SessionManager {
  /**
   * @param {object} deps
   *   tmux        — createTmux() handle
   *   getDriver   — (sourceType) => driver
   *   fallback    — (task) => Promise<{text,inputTokens?,outputTokens?,model?,cost?}>
   *   scratchDir  — where per-worker mcp configs are written
   *   pools       — { [sourceType]: poolSize } (default {} → 0; see ensureSource)
   *   tokenBudget, taskTimeoutMs — overrides for DEFAULTS
   *   timers      — { set(ms,cb)=>h, clear(h) } (default global; tests inject)
   *   now         — () => ms (default Date.now)
   *   log         — (msg) => void
   *   writeFileFn, mkdirFn — fs seams (default node:fs/promises)
   */
  constructor(deps = {}) {
    this.tmux = deps.tmux;
    this.getDriver = deps.getDriver;
    this.fallback = deps.fallback || (async () => { throw new Error('no fallback configured'); });
    this.scratchDir = deps.scratchDir || '/tmp/sigil-sessions';
    this.workerServer = deps.workerServer || null; // { command, args } for the worker MCP server
    this.pools = { ...(deps.pools || {}) };
    this.tokenBudget = deps.tokenBudget ?? DEFAULTS.tokenBudget;
    this.taskTimeoutMs = deps.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs;
    this.firstTaskTimeoutMs = deps.firstTaskTimeoutMs ?? DEFAULTS.firstTaskTimeoutMs;
    this.maxBootFailures = deps.maxBootFailures ?? DEFAULTS.maxBootFailures;
    this.timers = deps.timers || {
      set: (ms, cb) => setTimeout(cb, ms),
      clear: (h) => clearTimeout(h),
    };
    this.now = deps.now || Date.now;
    this.log = deps.log || (() => {});
    // onEvent — best-effort structured telemetry hook (dispatch/result/fallback/
    // recycle/ready). The daemon wires it to recordTrace(kind:'engine') so the
    // warm engine shows up in the Activity feed; tests omit it. Never throws.
    this.onEvent = deps.onEvent || null;
    this.writeFileFn = deps.writeFileFn || writeFile;
    this.mkdirFn = deps.mkdirFn || mkdir;

    this.workers = new Map();      // workerId → worker
    this.queues = new Map();       // sourceType → [task]
    this.pending = new Map();      // reqId → pending
    this.bootFailures = new Map(); // sourceType → consecutive boot-failure count
    this.seq = 0;                  // monotonic worker-id counter
    this.started = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Boot all configured pools. Reconciles orphaned sessions from a prior daemon first. */
  async start() {
    if (this.started) return;
    this.started = true;
    try { await this.mkdirFn(this.scratchDir, { recursive: true }); } catch { /* best-effort */ }
    await this.reconcileOrphans();
    for (const [sourceType, size] of Object.entries(this.pools)) {
      for (let i = 0; i < size; i++) {
        await this.spawnWorker(sourceType).catch((e) => this.log(`spawn ${sourceType} failed: ${e.message}`));
      }
    }
  }

  /** Kill every worker session and cancel pending timers. Best-effort. */
  async stop() {
    this.started = false;
    for (const w of this.workers.values()) {
      if (w.bootTimer) { this.timers.clear(w.bootTimer); w.bootTimer = null; }
      const driver = this.safeDriver(w.sourceType);
      const name = driver ? driver.sessionName(w.id) : `sigil-${w.id}`;
      await this.tmux.killSession(name);
    }
    for (const p of this.pending.values()) {
      if (p.timer) this.timers.clear(p.timer);
    }
    this.workers.clear();
  }

  /**
   * Kill any `sigil-*` tmux session not owned by a current worker — a daemon
   * restart must not leak warm processes from its previous life.
   */
  async reconcileOrphans() {
    const live = new Set(
      [...this.workers.values()].map((w) => {
        const d = this.safeDriver(w.sourceType);
        return d ? d.sessionName(w.id) : null;
      }).filter(Boolean),
    );
    const sessions = await this.tmux.listSessions();
    for (const name of sessions) {
      if (name.startsWith('sigil-') && !live.has(name)) {
        this.log(`reconcile: killing orphaned session ${name}`);
        await this.tmux.killSession(name);
      }
    }
  }

  // ── Public API used by the provider ────────────────────────────────────────

  /** Are there any workers (booting/ready/busy) for this source type? */
  hasWorkers(sourceType) {
    for (const w of this.workers.values()) if (w.sourceType === sourceType) return true;
    return false;
  }

  /**
   * Submit one task. Resolves with a uniform result shape regardless of whether
   * a warm worker or the fallback produced it. If no worker exists for the
   * source type (engine disabled / not started), runs the fallback directly so
   * the caller never hangs.
   */
  submit({ sourceType, prompt, model, schema, caller } = {}) {
    const reqId = randomUUID();
    const task = { reqId, sourceType, prompt, model, schema, caller: caller ?? null, enqueuedAt: this.now() };

    if (!this.hasWorkers(sourceType)) {
      return this.runFallback(task, 'no-workers');
    }

    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { task, resolve, reject, timer: null, workerId: null, settled: false });
      this.enqueue(task);
      this.dispatch(sourceType);
    });
  }

  // ── Worker-facing API (called by the worker MCP tools via daemon RPC) ───────

  /**
   * The worker pulls its assigned task. Empty when it has none (idle nudge).
   *
   * This call doubles as the BOOT HANDSHAKE: the very first get_task from a
   * BOOTING worker is proof its pane is live, so we flip it READY, cancel the
   * boot timer, reset the source type's boot-failure streak, and dispatch any
   * queued work to it now (which may set currentReqId before we return below —
   * so a freshly-booted worker can get real work on this very poll).
   */
  getTask(workerId) {
    const w = this.workers.get(workerId);
    if (w && w.state === STATE.BOOTING) {
      if (w.bootTimer) { this.timers.clear(w.bootTimer); w.bootTimer = null; }
      w.state = STATE.READY;
      this.bootFailures.set(w.sourceType, 0);
      this.log(`worker ${w.id} booted (get_task handshake) — ready`);
      this.emit({ type: 'worker-ready', workerId: w.id, sourceType: w.sourceType, session: this.sessionNameOf(w) });
      this.dispatch(w.sourceType);
    }
    if (!w || !w.currentReqId) return { empty: true };
    const p = this.pending.get(w.currentReqId);
    if (!p || p.settled) return { empty: true };
    return { reqId: p.task.reqId, prompt: p.task.prompt };
  }

  /** The worker returns a result. Idempotent: a second/late call is ignored. */
  submitResult(workerId, reqId, result) {
    const p = this.pending.get(reqId);
    if (!p || p.settled) return { ok: true, duplicate: true }; // resolve-once

    const inputTokens = estimateTokens(p.task.prompt);
    const outputTokens = estimateTokens(String(result ?? ''));
    this.settle(p, {
      text: String(result ?? ''),
      inputTokens,
      outputTokens,
      model: p.task.model || null,
      cost: 0,
      viaFallback: false,
      workerId,
      reqId,
    });

    const w = this.workers.get(workerId);
    this.emit({
      type: 'result', workerId, reqId, sourceType: p.task.sourceType, caller: p.task.caller,
      session: this.sessionNameOf(workerId), inputTokens, outputTokens,
      tokensUsed: w ? w.tokensUsed + inputTokens + outputTokens : null,
      durationMs: p.task.dispatchedAt ? this.now() - p.task.dispatchedAt : null,
    });

    if (w) {
      w.tokensUsed += inputTokens + outputTokens;
      this.releaseWorker(w); // → READY or RECYCLE if over budget
    }
    return { ok: true };
  }

  // ── Internal machinery ──────────────────────────────────────────────────────

  enqueue(task) {
    if (!this.queues.has(task.sourceType)) this.queues.set(task.sourceType, []);
    this.queues.get(task.sourceType).push(task);
  }

  /** Assign queued tasks of a source type to any READY workers of that type. */
  dispatch(sourceType) {
    const queue = this.queues.get(sourceType);
    if (!queue || !queue.length) return;

    for (const w of this.workers.values()) {
      if (!queue.length) break;
      if (w.sourceType !== sourceType || w.state !== STATE.READY) continue;

      const task = queue.shift();
      const p = this.pending.get(task.reqId);
      if (!p || p.settled) continue; // task already settled (e.g. via no-worker fallback race)

      w.state = STATE.BUSY;
      w.currentReqId = task.reqId;
      p.workerId = w.id;
      task.dispatchedAt = this.now();
      p.timer = this.timers.set(this.taskTimeoutMs, () => this.onTimeout(task.reqId));
      this.emit({
        type: 'dispatch', workerId: w.id, reqId: task.reqId, sourceType,
        caller: task.caller, session: this.sessionNameOf(w),
      });

      const driver = this.getDriver(sourceType);
      Promise.resolve(driver.nudge(this.tmux, driver.sessionName(w.id)))
        .catch((err) => {
          // Nudge failed (session dead / tmux gone) → treat as an immediate miss.
          this.log(`nudge ${w.id} failed: ${err.message}`);
          this.onTimeout(task.reqId);
        });
    }
  }

  /** Dead-man timeout: worker never called back. Fall back + recycle the worker. */
  async onTimeout(reqId) {
    const p = this.pending.get(reqId);
    if (!p || p.settled) return;

    const w = p.workerId ? this.workers.get(p.workerId) : null;
    if (w) {
      // Surface WHY for the daemon log — a wedged auth/trust dialog vs a silent miss.
      const driver = this.safeDriver(w.sourceType);
      if (driver) {
        const h = await driver.healthcheck(this.tmux, driver.sessionName(w.id)).catch(() => ({ healthy: true, reason: null }));
        this.log(`task ${reqId} timed out on worker ${w.id}${h.reason ? ` (${h.reason})` : ''} — falling back`);
      }
      w.state = STATE.UNHEALTHY;
    }

    this.emit({
      type: 'fallback', reqId, reason: 'timeout', sourceType: p.task.sourceType,
      caller: p.task.caller, workerId: w ? w.id : null, session: w ? this.sessionNameOf(w) : null,
    });
    const fb = await this.runFallbackRaw(p.task);
    if (!p.settled) this.settle(p, fb);
    if (w) {
      this.emit({ type: 'recycle', workerId: w.id, sourceType: w.sourceType, reason: 'timeout', session: this.sessionNameOf(w) });
      await this.recycle(w);
    }
  }

  /**
   * Active health sweep — recycle any BUSY worker wedged on a blocking dialog
   * BEFORE its dead-man timeout fires (the failure-mode the plan flags as a
   * silent-stall risk). The daemon schedules this on an interval; tests call it
   * directly. Each wedged worker's task falls back immediately.
   */
  async probeHealth() {
    for (const w of [...this.workers.values()]) {
      if (w.state !== STATE.BUSY) continue;
      const driver = this.safeDriver(w.sourceType);
      if (!driver) continue;
      const h = await driver.healthcheck(this.tmux, driver.sessionName(w.id)).catch(() => ({ healthy: true }));
      if (h.healthy) continue;
      this.log(`health probe: worker ${w.id} wedged (${h.reason}) — recycling early`);
      if (w.currentReqId) await this.onTimeout(w.currentReqId);
    }
  }

  /** Resolve a pending task once and clear its timer. */
  settle(p, result) {
    if (p.settled) return;
    p.settled = true;
    if (p.timer) { this.timers.clear(p.timer); p.timer = null; }
    this.pending.delete(p.task.reqId);
    p.resolve(result);
  }

  /** Return a worker to READY, or recycle it if it has burned its token budget. */
  releaseWorker(w) {
    w.currentReqId = null;
    if (w.tokensUsed >= this.tokenBudget) {
      this.log(`worker ${w.id} hit token budget (${w.tokensUsed} ≥ ${this.tokenBudget}) — recycling`);
      this.emit({ type: 'recycle', workerId: w.id, sourceType: w.sourceType, reason: 'token-budget', tokensUsed: w.tokensUsed, session: this.sessionNameOf(w) });
      this.recycle(w).catch((e) => this.log(`recycle ${w.id} failed: ${e.message}`));
    } else {
      w.state = STATE.READY;
      this.dispatch(w.sourceType);
    }
  }

  /** Kill + respawn a worker of the same source type. */
  async recycle(w) {
    const driver = this.safeDriver(w.sourceType);
    if (driver) await this.tmux.killSession(driver.sessionName(w.id));
    this.workers.delete(w.id);
    if (this.started) {
      await this.spawnWorker(w.sourceType).catch((e) => this.log(`respawn ${w.sourceType} failed: ${e.message}`));
    }
  }

  /** Spawn one warm worker for a source type. Stays BOOTING until it handshakes. */
  async spawnWorker(sourceType) {
    const driver = this.getDriver(sourceType);
    const id = `${sourceType}-${this.seq++}`;
    const worker = { id, sourceType, state: STATE.BOOTING, currentReqId: null, tokensUsed: 0, bootTimer: null, bootRetried: false };
    this.workers.set(id, worker);

    const model = this.pools[`${sourceType}:model`] || undefined;
    const { argv, files } = driver.buildLaunch({
      workerId: id, sourceType, model, scratchDir: this.scratchDir, workerServer: this.workerServer,
    });
    for (const f of files) {
      await this.writeFileFn(f.path, f.content, { mode: f.mode ?? 0o600 });
    }
    await this.tmux.newSession(driver.sessionName(id), argv);

    // Boot handshake: nudge once so a cold `claude` boots and calls get_task,
    // and arm a short boot timer. We do NOT mark READY or dispatch here — the
    // worker proves its pane is live by calling get_task (see getTask). If the
    // boot nudge was swallowed by a still-booting pane, onBootDeadline re-nudges
    // once before giving up, so a lost cold-boot keystroke costs ~one boot
    // window, never a full dead-man timeout.
    worker.bootTimer = this.timers.set(this.firstTaskTimeoutMs, () => this.onBootDeadline(id));
    Promise.resolve(driver.nudge(this.tmux, driver.sessionName(id)))
      .catch((err) => { this.log(`boot nudge ${id} failed: ${err.message}`); this.onBootDeadline(id); });
    return worker;
  }

  /**
   * Boot timer fired: the worker has not called get_task yet. Re-nudge once (the
   * boot keystroke was likely swallowed by a still-booting pane), then on a
   * second miss give up on this worker and recycle it.
   */
  async onBootDeadline(workerId) {
    const w = this.workers.get(workerId);
    if (!w || w.state !== STATE.BOOTING) return; // booted (or gone) in the meantime
    if (w.bootTimer) { this.timers.clear(w.bootTimer); w.bootTimer = null; }

    if (!w.bootRetried) {
      w.bootRetried = true;
      this.log(`worker ${w.id} silent after ${this.firstTaskTimeoutMs}ms — re-nudging once`);
      const driver = this.safeDriver(w.sourceType);
      if (driver) {
        Promise.resolve(driver.nudge(this.tmux, driver.sessionName(w.id))).catch(() => {});
      }
      w.bootTimer = this.timers.set(this.firstTaskTimeoutMs, () => this.onBootDeadline(workerId));
      return;
    }
    this.log(`worker ${w.id} failed to boot — recycling`);
    await this.recycleBoot(w);
  }

  /**
   * Recycle a worker that never booted, with a circuit breaker: after
   * maxBootFailures consecutive boot failures for a source type, STOP
   * respawning so a broken `claude` can't become a tight respawn storm. With no
   * worker left, submit() sees hasWorkers()===false and uses the one-shot path —
   * the engine yields cleanly to the proven fallback instead of thrashing.
   */
  async recycleBoot(w) {
    const driver = this.safeDriver(w.sourceType);
    if (driver) await this.tmux.killSession(driver.sessionName(w.id));
    this.workers.delete(w.id);

    const fails = (this.bootFailures.get(w.sourceType) || 0) + 1;
    this.bootFailures.set(w.sourceType, fails);

    if (this.started && fails < this.maxBootFailures) {
      await this.spawnWorker(w.sourceType).catch((e) => this.log(`respawn ${w.sourceType} failed: ${e.message}`));
    } else if (fails >= this.maxBootFailures) {
      this.log(`managed-session: ${w.sourceType} worker failed to boot ${fails}× — staying on one-shot for this source type`);
      this.emit({ type: 'boot-failure', workerId: w.id, sourceType: w.sourceType, fails });
    }
  }

  /** Run the fallback and wrap into the uniform result shape (no pending entry). */
  async runFallback(task, reason) {
    this.log(`task ${task.reqId} → fallback (${reason})`);
    this.emit({ type: 'fallback', reqId: task.reqId, reason, sourceType: task.sourceType, caller: task.caller, workerId: null });
    return this.runFallbackRaw(task);
  }

  async runFallbackRaw(task) {
    // Errors propagate to the caller untouched: a pending task with a promise
    // rejects, and the no-worker path returns this rejected promise directly.
    const r = await this.fallback(task);
    return {
      text: r.text,
      inputTokens: r.inputTokens ?? estimateTokens(task.prompt),
      outputTokens: r.outputTokens ?? estimateTokens(r.text || ''),
      model: r.model || task.model || null,
      cost: r.cost || 0,
      viaFallback: true,
      // No warm worker produced this result — the call took the one-shot path.
      workerId: null,
      reqId: task.reqId,
    };
  }

  safeDriver(sourceType) {
    try { return this.getDriver(sourceType); } catch { return null; }
  }

  /** tmux session name for a worker (e.g. 'sigil-claude-0'), driver-defined. */
  sessionNameOf(workerOrId) {
    const w = typeof workerOrId === 'string' ? this.workers.get(workerOrId) : workerOrId;
    if (!w) return null;
    const d = this.safeDriver(w.sourceType);
    return d ? d.sessionName(w.id) : `sigil-${w.id}`;
  }

  /** Fire a structured telemetry event. Best-effort: a bad hook never breaks work. */
  emit(ev) {
    if (!this.onEvent) return;
    try { this.onEvent(ev); } catch { /* telemetry must never throw */ }
  }

  /** Snapshot for diagnostics / `status`. */
  stats() {
    const workers = [...this.workers.values()].map((w) => ({
      id: w.id, sourceType: w.sourceType, state: w.state, tokensUsed: w.tokensUsed,
    }));
    const queued = {};
    for (const [k, q] of this.queues) queued[k] = q.length;
    return { workers, queued, pending: this.pending.size };
  }
}

export { DEFAULTS, STATE };
