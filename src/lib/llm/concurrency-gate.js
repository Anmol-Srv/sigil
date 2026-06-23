/**
 * Concurrency gate — a tiny FIFO semaphore that bounds how many async tasks run
 * at once. The managed-session engine bounds only its WARM worker pool; this is
 * the hard cap on the OTHER path — every direct `claude` CLI spawn.
 *
 * Why it exists: a user once hit 1600+ live `claude` processes because an ingest
 * fan-out (5–20 LLM calls per document, ×N concurrent documents, plus fallback
 * storms when a warm worker wedged) spawned one process per call with no bound,
 * pinning RAM and burning subscription tokens. Routing every spawn through one
 * semaphore turns "fork 1600 processes" into "run `limit` at a time, queue the
 * rest" — structurally impossible to blow up, whether the managed engine is on,
 * off, or degraded.
 *
 *   acquire ─┬─ active < limit → admit immediately (active++)
 *            └─ else            → FIFO-queue until a release frees a slot
 *
 * The limit is read LIVE per admission decision (`getLimit()`), so a config /
 * env change — or a test tweaking it — takes effect without rebuilding the gate.
 *
 * Queue wait is deliberately UNBOUNDED here: callers layer their own deadline
 * (the one-shot spawn has a per-process timeout that starts only AFTER a slot is
 * acquired; the managed manager has its dead-man timeout). Worst-case wait is
 * therefore bounded by (queueDepth / limit) × that per-call timeout — slower,
 * but never a RAM blowup. That trade (latency under load over unbounded forking)
 * is the whole point.
 */

/**
 * @param {() => number} getLimit  Max concurrent admits. Read on every decision,
 *                                 so a live config/env change is honored. Clamped
 *                                 to >= 1 so a bad value can't deadlock the gate.
 * @returns {{ run<T>(fn: () => Promise<T>): Promise<T>, active: number, waiting: number, limit: number }}
 */
export function createSemaphore(getLimit) {
  let active = 0;
  const waiters = []; // FIFO queue of resolve fns awaiting a slot

  const limit = () => Math.max(1, getLimit() || 1);

  // Admit as many queued waiters as the current limit allows. Each admission
  // takes a slot (active++) before resolving, so the freed slot can't be
  // double-claimed by the fast path of a concurrent acquire().
  function pump() {
    while (active < limit() && waiters.length > 0) {
      active += 1;
      waiters.shift()();
    }
  }

  function acquire() {
    if (active < limit()) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => { waiters.push(resolve); });
  }

  function release() {
    active = Math.max(0, active - 1);
    pump();
  }

  /** Run `fn` once a slot is free; always release the slot, even if `fn` throws. */
  async function run(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    run,
    get active() { return active; },
    get waiting() { return waiters.length; },
    get limit() { return limit(); },
  };
}
