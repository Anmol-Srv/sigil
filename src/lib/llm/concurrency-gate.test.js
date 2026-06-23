// Concurrency gate — the hard cap that makes the 1600-`claude`-process blowup
// structurally impossible. Tests use a controllable "work" fn (a Promise the
// test resolves by hand) so concurrency is deterministic with zero timers and
// zero real processes — same DI-over-mocks style as manager.test.js.

import { describe, it, expect } from 'vitest';

import { createSemaphore } from './concurrency-gate.js';

/**
 * A task whose completion the test controls. `start` resolves when the gate
 * actually invokes the work fn (i.e. a slot was admitted); call `finish()` to
 * let it complete and release its slot.
 */
function deferredTask() {
  let resolveWork;
  let signalStarted;
  const started = new Promise((r) => { signalStarted = r; });
  const work = () => {
    signalStarted();
    return new Promise((r) => { resolveWork = r; });
  };
  return { work, started, finish: (v) => resolveWork(v) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createSemaphore', () => {
  it('admits up to the limit immediately and queues the rest (saturation)', async () => {
    const gate = createSemaphore(() => 2);
    const t1 = deferredTask();
    const t2 = deferredTask();
    const t3 = deferredTask();

    gate.run(t1.work);
    gate.run(t2.work);
    const p3 = gate.run(t3.work); // over the limit → must queue

    await Promise.all([t1.started, t2.started]);
    await tick();

    // Exactly 2 running, the 3rd parked in the queue — NOT spawned.
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(1);

    // The 3rd task's work fn has not been called yet.
    let t3Started = false;
    t3.started.then(() => { t3Started = true; });
    await tick();
    expect(t3Started).toBe(false);

    // Free a slot → the queued task is admitted (FIFO).
    t1.finish();
    await t3.started;
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(0);

    t2.finish();
    t3.finish('done');
    await expect(p3).resolves.toBe('done');
    expect(gate.active).toBe(0);
  });

  it('admits queued waiters in FIFO order', async () => {
    const gate = createSemaphore(() => 1);
    const order = [];
    const a = deferredTask();
    const b = deferredTask();
    const c = deferredTask();

    gate.run(async () => { order.push('a'); return a.work(); });
    gate.run(async () => { order.push('b'); return b.work(); });
    gate.run(async () => { order.push('c'); return c.work(); });

    await a.started;
    expect(order).toEqual(['a']); // only the first ran

    a.finish();
    await b.started;
    expect(order).toEqual(['a', 'b']);

    b.finish();
    await c.started;
    expect(order).toEqual(['a', 'b', 'c']);
    c.finish();
  });

  it('releases the slot even when the task throws', async () => {
    const gate = createSemaphore(() => 1);
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gate.active).toBe(0);

    // Slot was freed, so the next task runs.
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('honors a live limit change between admissions', async () => {
    let max = 1;
    const gate = createSemaphore(() => max);
    const t1 = deferredTask();
    const t2 = deferredTask();

    gate.run(t1.work);
    gate.run(t2.work); // queued under limit 1

    await t1.started;
    await tick();
    expect(gate.active).toBe(1);
    expect(gate.waiting).toBe(1);

    // Raise the cap, then free a slot → pump admits using the NEW limit.
    max = 2;
    t1.finish();
    await t2.started;
    expect(gate.limit).toBe(2);
    t2.finish();
  });

  it('clamps a bad limit to >= 1 so it can never deadlock', async () => {
    const gate = createSemaphore(() => 0);
    expect(gate.limit).toBe(1);
    await expect(gate.run(async () => 'ran')).resolves.toBe('ran');
  });
});
