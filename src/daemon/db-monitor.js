/**
 * Proactive embedded-DB health monitor + recovery (S1).
 *
 * The embedded store is PGlite — Postgres compiled to WASM, running in-process.
 * When its Emscripten heap `abort()`s ("Aborted()"), the module is dead for the
 * rest of the process lifetime: every later query repeats the same error. The
 * query layer already detects this (isPgliteAbort), disposes the singleton, and
 * tags the error so the RPC dispatch path drops the dead knex pool — so the NEXT
 * request rebuilds a fresh PGlite. That reactive path leaves two holes this
 * module closes:
 *
 *   1. Background timers (the periodic CHECKPOINT, snapshots) touch the DB
 *      OUTSIDE the dispatch path — an abort there is only logged, never
 *      recovered, so an idle daemon (no RPC traffic) stays wedged.
 *   2. Nothing proactively notices a dead DB: recovery only fires on the next
 *      request, and dbHealth only refreshes at boot / on `status`.
 *
 * So we run a periodic SELECT 1. On a poisoned engine we escalate recovery
 * (rebuild the PGlite instance → restore from snapshot if the cluster is torn),
 * guarded so a genuinely-broken cluster can't spin in a tight restart loop.
 * This is the runtime analogue of the boot-time tryBootRecovery in index.js.
 */

import { setDbHealth, getDbHealth } from './registry-holder.js';

// A single recovery can't run concurrently with itself (the steps tear down and
// rebuild the shared pool). And a cluster that's genuinely broken — not just a
// transient heap abort — must not restart-spin forever: cap attempts per window
// and then sit loud-and-unhealthy instead.
let recovering = false;
const recoveryAttempts = [];
const MAX_RECOVERIES = 5;
const RECOVERY_WINDOW_MS = 5 * 60_000;

/**
 * Recover a poisoned embedded PGlite engine. Idempotent and never throws.
 * Escalates: drop the dead pool + WASM singleton → re-probe (rebuilds a fresh
 * instance) → if still dead, restore the latest snapshot (non-destructive; the
 * torn dir is moved aside) → re-probe. Updates dbHealth at every exit.
 *
 * @returns {Promise<{recovered:boolean, via?:string, skipped?:string}>}
 */
export async function recoverEmbeddedDb({ log = () => {}, reason = 'health-monitor' } = {}) {
  if (recovering) return { recovered: false, skipped: 'in-flight' };
  recovering = true;
  try {
    const now = Date.now();
    while (recoveryAttempts.length && now - recoveryAttempts[0] > RECOVERY_WINDOW_MS) {
      recoveryAttempts.shift();
    }
    if (recoveryAttempts.length >= MAX_RECOVERIES) {
      log(`db: recovery suppressed — ${recoveryAttempts.length} attempts in ${RECOVERY_WINDOW_MS / 60_000}m `
        + '(crash loop); leaving DB unhealthy. Run `sigil repair db` or restart the daemon.');
      setDbHealth({ healthy: false, error: 'recovery crash-loop guard tripped', checkedAt: now });
      return { recovered: false, skipped: 'crash-loop' };
    }
    recoveryAttempts.push(now);

    const { default: cortexDb, resetCortexPool } = await import('../db/cortex.js');

    // 1. Drop the dead knex pool + WASM singleton, then re-probe — the next
    //    query rebuilds a fresh PGlite instance, which clears a transient abort.
    log(`db: recovering poisoned engine (${reason}) — rebuilding PGlite instance`);
    await resetCortexPool();
    try {
      await cortexDb.raw('SELECT 1');
      setDbHealth({ healthy: true, error: null, checkedAt: Date.now() });
      log('db: recovered — fresh PGlite instance healthy');
      return { recovered: true, via: 'reinstantiate' };
    } catch (err) {
      log(`db: reinstantiate did not clear it (${err.message.split('\n')[0]}) — trying snapshot restore`);
    }

    // 2. Still dead → the on-disk cluster is likely torn. Restore the latest
    //    snapshot (only meaningful for embedded; mirrors boot recovery).
    const { default: config } = await import('../config.js');
    if (config.db.mode !== 'embedded') {
      setDbHealth({ healthy: false, error: 'db unreachable', checkedAt: Date.now() });
      return { recovered: false };
    }
    const { latestSnapshot, recoverFromSnapshot } = await import('../db/snapshots.js');
    if (!latestSnapshot()) {
      log('db: no snapshot to restore — leaving unhealthy (run `sigil repair db`)');
      setDbHealth({ healthy: false, error: 'embedded cluster unopenable, no snapshot', checkedAt: Date.now() });
      return { recovered: false };
    }
    await resetCortexPool();
    const r = await recoverFromSnapshot({ log });
    if (!r.restored) {
      setDbHealth({ healthy: false, error: `snapshot restore skipped: ${r.reason}`, checkedAt: Date.now() });
      return { recovered: false };
    }
    await cortexDb.raw('SELECT 1'); // re-probe on the freshly restored dir
    setDbHealth({ healthy: true, error: null, checkedAt: Date.now() });
    log('db: recovered — cluster healthy after snapshot restore');
    return { recovered: true, via: 'snapshot' };
  } catch (e) {
    log(`db: recovery failed — ${e.message.split('\n')[0]}`);
    setDbHealth({ healthy: false, error: e.message, checkedAt: Date.now() });
    return { recovered: false };
  } finally {
    recovering = false;
  }
}

/**
 * Start the periodic health tick. Runs SELECT 1; on a poisoned engine it kicks
 * off recoverEmbeddedDb, otherwise it keeps dbHealth fresh. A non-abort failure
 * (server Postgres down, network) is recorded but NOT reinstantiated — only a
 * WASM abort warrants rebuilding the engine. Unref'd so it never holds the
 * process open. Returns the timer so the caller can clear it on shutdown.
 */
export function startDbHealthMonitor({ log = () => {}, intervalMs = 30_000 } = {}) {
  const tick = async () => {
    let cortexDb;
    try {
      ({ default: cortexDb } = await import('../db/cortex.js'));
    } catch {
      return; // db layer unavailable — nothing to probe
    }
    try {
      await cortexDb.raw('SELECT 1');
      // Only write on a transition to avoid churning checkedAt every tick.
      if (getDbHealth().healthy !== true) {
        setDbHealth({ healthy: true, error: null, checkedAt: Date.now() });
      }
    } catch (err) {
      const { isPgliteAbort } = await import('../db/pglite-adapter.js');
      if (isPgliteAbort(err) || err?.sigilPoisoned) {
        log(`db: health check found a poisoned engine — ${(err.message || '').split('\n')[0]}`);
        await recoverEmbeddedDb({ log, reason: 'health-monitor' });
      } else {
        setDbHealth({ healthy: false, error: err.message, checkedAt: Date.now() });
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

// Test-only: reset the crash-loop guard between cases.
export function __resetRecoveryGuard() {
  recovering = false;
  recoveryAttempts.length = 0;
}
