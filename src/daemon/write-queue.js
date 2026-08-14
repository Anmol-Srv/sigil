/**
 * One writer at a time, daemon-wide.
 *
 * THE PROBLEM
 * The embedded engine (PGlite) is single-process AND single-connection: knex is
 * configured with a pool of exactly 1, because PGlite is one session and
 * BEGIN/COMMIT are session-global. Model work now happens before transactions,
 * but admission, fact commits, pod writes, and durable-job state transitions
 * still need a single global ordering boundary.
 *
 * Nothing serialized writes ACROSS RPC calls. Two saves arriving close together
 * — a `remember` while an `ingest` is mid-flight, or a Stop hook's `ingestTurn`
 * landing during either — produced this, from a real session:
 *
 *   [4/6] Extracting facts...          <- save #1 holds the transaction
 *   [0/6] Classifying input...         <- save #2 starts concurrently
 *   [1/6] Checking for changes...      <- save #2 needs a connection
 *   [llm-log] write failed: Knex: Timeout acquiring a connection
 *   periodic checkpoint failed: Knex: Timeout acquiring a connection
 *   [sigil:pods] resolveActiveScope failed: Knex: Timeout acquiring a connection
 *   [trace-store] persist failed: Knex: Timeout acquiring a connection
 *
 * The caller saw a 30s RPC timeout and then "pool is probably full" — which
 * reads like database corruption but is plain starvation. Worse, the collateral
 * damage hit every unrelated subsystem: checkpoints, traces and pod resolution
 * all failed for the duration.
 *
 * THE FIX
 * Funnel short mutation sections through one queue, so preparation can run in
 * parallel while commits never fight for the connection or interleave.
 *
 * ponytail: a promise chain, not a semaphore library. Depth is the only knob
 * worth having and it's observable; if writes ever need to run concurrently the
 * DB has to stop being single-connection first.
 *
 * NOT re-entrant. Nothing inside a locked section may call withWriteLock again
 * — the handlers each call the ingest pipeline directly rather than dispatching
 * to another RPC, so no nesting exists today. Keep it that way.
 */

let tail = Promise.resolve();
let depth = 0;
let running = 0;
let sequence = 0;
let totalStarted = 0;
let totalWaitMs = 0;
let maxWaitMs = 0;
let lastWaitMs = 0;
const waiting = new Map();

/**
 * Run `fn` once every previously-queued writer has finished. Returns fn's
 * result and propagates its errors; a rejecting writer never breaks the chain
 * for the writers behind it.
 */
export function withWriteLock(fn) {
  depth += 1;
  const ticket = sequence++;
  const enqueuedAt = Date.now();
  waiting.set(ticket, enqueuedAt);
  const invoke = async () => {
    waiting.delete(ticket);
    running += 1;
    lastWaitMs = Date.now() - enqueuedAt;
    totalWaitMs += lastWaitMs;
    maxWaitMs = Math.max(maxWaitMs, lastWaitMs);
    totalStarted += 1;
    try {
      return await fn();
    } finally {
      running -= 1;
    }
  };
  const run = tail.then(invoke, invoke);
  // Swallow rejections on the CHAIN only (the caller still gets the real
  // rejection via `run`), otherwise one failed write would reject every
  // subsequent one and stall the queue permanently.
  tail = run.then(() => {}, () => {});
  return run.finally(() => { depth -= 1; });
}

/** Writers currently queued or running — surfaced by `status` for diagnosis. */
export function writeQueueDepth() {
  return depth;
}

/** Detailed queue latency without changing the legacy numeric depth field. */
export function writeQueueStats() {
  const now = Date.now();
  const oldestEnqueuedAt = waiting.size ? Math.min(...waiting.values()) : null;
  return {
    depth,
    running,
    queued: waiting.size,
    oldestWaitMs: oldestEnqueuedAt == null ? 0 : now - oldestEnqueuedAt,
    lastWaitMs,
    maxWaitMs,
    averageWaitMs: totalStarted ? Math.round(totalWaitMs / totalStarted) : 0,
    totalStarted,
  };
}
