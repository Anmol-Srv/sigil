// config.json is the source of truth (replaces the old dotenv preload). On a
// legacy install, loadConfig() — called first thing in startDaemon — imports
// ~/.sigil/.env into config.json once, then renames .env so it's skipped.
import { loadConfig } from '../setup/config-store.js';

import { createWriteStream, writeFileSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';

import { PKG_ROOT, SIGIL_DAEMON_LOG, SIGIL_HEARTBEAT } from '../lib/paths.js';
import { getSigilVersion } from '../lib/version.js';
import {
  acquireDaemonLock,
  detectRunningDaemon,
  ensureSigilHome,
  installShutdownHooks,
  releaseDaemonLock,
  removePidFile,
  writePidFile,
} from './lifecycle.js';
import { createRegistry } from './rpc-registry.js';
import { setRegistry, clearRegistry } from './registry-holder.js';
import { startSocketServer } from './socket-server.js';
import { createHttpController } from './http-controller.js';

import { registerAll } from './handlers/index.js';

const STARTED_AT = Date.now();

/**
 * Start the browser adapter and remember that the user explicitly opened it.
 * The HTTP server itself stays lazy for memory-only installs, but once a user
 * uses the GUI it must come back after a supervised daemon restart. Persist
 * only after the server is successfully listening so a failed bind never turns
 * into a boot-time retry loop.
 */
export function createGuiStartHandler({ http, config, log, persistHttpEnabled }) {
  return async () => {
    const result = await http.start();
    if (!config.http.enabled) {
      try {
        await persistHttpEnabled();
        config.http.enabled = true;
      } catch (err) {
        // The current GUI is still usable. Leave the daemon's core lifecycle
        // untouched and make the failed persistence diagnosable in its log.
        log(`could not persist GUI preference: ${err.message}`);
      }
    }
    return result;
  };
}

export async function startDaemon({ foreground = false } = {}) {
  // The daemon serves every agent; agent provenance must come per-request from
  // the socket envelope (→ AsyncLocalStorage), never from a global. Scrub any
  // SIGIL_AGENT inherited from the spawning CLI so currentAgent()'s env
  // fallback can't misattribute another agent's writes to 'cli'.
  delete process.env.SIGIL_AGENT;

  await ensureSigilHome();

  const existing = await detectRunningDaemon();
  if (existing) {
    process.stderr.write(`[sigild] already running (pid ${existing})\n`);
    process.exit(0);
  }

  // Atomic lifetime ownership. The old split-brain guard was the always-on GUI
  // port; that made every memory-only daemon load HTTP + WebSocket code. A
  // dedicated lock closes the startup race before either contender can unlink
  // the Unix socket or touch PGlite.
  try {
    acquireDaemonLock();
  } catch (err) {
    if (err.code === 'daemon_owned') {
      process.stderr.write(`[sigild] ${err.message}\n`);
      process.exit(0);
    }
    throw err;
  }

  // Log: append-only. We don't redirect stdout/stderr globally — handlers
  // shouldn't be using them anyway, and a separate log stream is easier
  // to tail. If launched detached, the parent already redirected fds.
  // Mark this process as THE daemon — the sole legitimate owner of the embedded
  // PGlite engine. The single-process guard in pglite-adapter exempts us; every
  // other process must route DB access through the daemon (finding 6.1).
  process.env.SIGIL_DAEMON_PROCESS = '1';

  const log = makeLogger();
  log(`starting (pid ${process.pid}, node ${process.version})`);

  // Global safety net. Node ≥15 turns an unhandled promise rejection into a
  // fatal crash by default; a single stray rejection deep in a handler would
  // take down the daemon that serves every agent. Log rejections and keep
  // running. For a genuinely uncaught exception the process state is suspect —
  // log it and exit non-zero so the supervisor (launchd KeepAlive) restarts a
  // clean process instead of limping along corrupted.
  process.on('unhandledRejection', (reason) => {
    log(`unhandledRejection: ${reason?.stack || reason}`);
  });
  process.on('uncaughtException', (err) => {
    log(`uncaughtException: ${err?.stack || err}`);
    process.exit(1);
  });

  // Load config.json + migrate any legacy ~/.sigil/.env into it, before
  // anything reads configuration.
  loadConfig();

  const registry = createRegistry();
  setRegistry(registry);
  registerAll(registry, { startedAt: STARTED_AT });

  const { default: config } = await import('../config.js');

  // HTTP/WebSocket is a UI adapter, not a storage prerequisite. Keep it unloaded
  // until the user opens the GUI. Existing installations that explicitly set
  // http.enabled=true retain the old always-on behavior.
  const http = createHttpController({ registry, log, config });
  registry.register('gui.start', createGuiStartHandler({
    http,
    config,
    log,
    persistHttpEnabled: async () => {
      const { patchConfig } = await import('../setup/config-store.js');
      patchConfig('http', { enabled: true });
    },
  }));
  registry.register('gui.status', () => http.status());
  if (config.http.enabled) {
    try {
      await http.start();
    } catch (err) {
      log(`http server failed to start: ${err.message}`);
    }
  }

  await writePidFile();

  const socket = await startSocketServer({ registry, log });

  // Eager DB health probe. A memory daemon that can't reach Postgres must say
  // so LOUDLY — the old behaviour let every hook silently return empty memory,
  // so the user kept working for hours thinking they had context. Non-fatal
  // and non-blocking: the daemon stays up (Claude keeps working) and the flag
  // If the configured DB is our local Docker Postgres and it's stopped (e.g.
  // after a reboot), start it before probing. Best-effort, never blocks boot.
  try {
    const { ensureLocalPostgresRunning } = await import('../db/provision/docker.js');
    const started = await ensureLocalPostgresRunning();
    if (started.started) log('started local sigil-postgres container');
  } catch { /* docker absent / unrelated DB — ignore */ }
  probeDbHealth(log);

  // Heartbeat: a small liveness file the supervisor/CLI/GUI read to tell
  // "running" from "stale pidfile". Refreshed every 15s; removed on shutdown.
  const pkgVersion = getSigilVersion();
  const writeHeartbeat = () => {
    try {
      writeFileSync(SIGIL_HEARTBEAT, JSON.stringify({
        pid: process.pid,
        version: pkgVersion,
        node: process.version,
        // The daemon's package root — lets the install-integrity check (S2) tell
        // whether the serving daemon is the canonical git install or a foreign copy.
        root: PKG_ROOT,
        startedAt: STARTED_AT,
        ts: Date.now(),
        supervised: process.env.SIGIL_SUPERVISED === '1',
      }), 'utf8');
    } catch { /* best-effort */ }
  };
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, 15_000);
  heartbeatTimer.unref();

  // Install-integrity warning (S2): if the shims or this daemon don't line up
  // with the canonical git install at ~/.sigil/app, say so loudly. We WARN
  // rather than refuse to boot — a hard exit here could wedge auto-spawn into a
  // restart loop on a broken shim — while `sigil doctor` reports it as a hard
  // failure with the one-command fix.
  try {
    const { checkInstallIntegrity } = await import('../lib/install-state.js');
    const r = checkInstallIntegrity();
    if (r.applicable && !r.ok) {
      for (const issue of r.issues) log(`install-integrity WARNING: ${issue.message} — fix: ${issue.fix}`);
    }
  } catch { /* best-effort — never block boot */ }

  // Update checks are explicit (`sigil update --check`). A storage daemon must
  // not run background git/network work while the user is coding.

  // Periodic CHECKPOINT for the embedded store (field-report Defect 1): bounds how
  // much WAL a hard kill (SIGKILL / crash / power loss) would need to replay,
  // shrinking the torn-checkpoint window. Embedded only; best-effort; unref'd so it
  // never holds the process open.
  let checkpointTimer = null;
  (async () => {
    try {
      const { default: cfg } = await import('../config.js');
      if (cfg.db.mode !== 'embedded') return;
      const { default: cortexDb } = await import('../db/cortex.js');
      checkpointTimer = setInterval(() => {
        cortexDb.raw('CHECKPOINT').catch(async (e) => {
          log(`periodic checkpoint failed: ${e.message}`);
          // A CHECKPOINT abort is a poisoned WASM heap surfacing on a TIMER, not
          // an RPC — so the dispatch-path recovery never sees it. Heal it here so
          // an idle daemon (no request traffic) can't sit wedged (S1).
          const { isPgliteAbort } = await import('../db/pglite-adapter.js');
          if (isPgliteAbort(e) || e?.sigilPoisoned) {
            const { recoverEmbeddedDb } = await import('./db-monitor.js');
            await recoverEmbeddedDb({ log, reason: 'checkpoint-abort' });
          }
        });
      }, 60_000);
      checkpointTimer.unref();
    } catch { /* config/db unavailable — skip */ }
  })();

  // Proactive DB health monitor (S1): periodically probe the store and, on a
  // poisoned embedded engine, rebuild it (→ snapshot restore if torn). Recovery
  // is crash-loop guarded. Unref'd.
  let dbMonitorTimer = null;
  try {
    const { startDbHealthMonitor } = await import('./db-monitor.js');
    dbMonitorTimer = startDbHealthMonitor({ log });
  } catch (err) {
    log(`db health monitor failed to start: ${err.message}`);
  }

  // Periodic snapshots of the embedded cluster. A consistent dumpDataDir
  // tarball, rotated, lets recovery bound data loss instead of wiping a torn
  // cluster. Clean shutdown also takes one. There is no post-boot full copy:
  // it duplicated the previous shutdown snapshot and made daemon restarts
  // unnecessarily expensive.
  let snapshotTimer = null;
  (async () => {
    try {
      const { default: cfg } = await import('../config.js');
      if (cfg.db.mode !== 'embedded') return;
      const { takeSnapshot } = await import('../db/snapshots.js');
      const { getDbHealth } = await import('./registry-holder.js');
      const snapshotIfHealthy = async (reason) => {
        if (!getDbHealth().healthy) return; // never overwrite a good snapshot with a bad cluster
        try { await takeSnapshot({ reason, log }); }
        catch (e) { log(`snapshot (${reason}) failed: ${e.message}`); }
      };
      snapshotTimer = setInterval(() => snapshotIfHealthy('periodic'), 30 * 60_000);
      snapshotTimer.unref();
    } catch { /* config/db unavailable — skip */ }
  })();

  // Lazy-init guard: handlers that touch the DB open the connection on
  // first use (see handlers/*). On shutdown we destroy the pool if it
  // was ever opened.
  installShutdownHooks(async (signal) => {
    log(`received ${signal}, shutting down`);
    clearInterval(heartbeatTimer);
    if (checkpointTimer) clearInterval(checkpointTimer);
    if (dbMonitorTimer) clearInterval(dbMonitorTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    try { rmSync(SIGIL_HEARTBEAT, { force: true }); } catch { /* ignore */ }
    await socket.close();
    await http.close();
    try {
      const { default: cortexDb } = await import('../db/cortex.js');
      // Embedded (PGlite on NODEFS): force a clean CHECKPOINT before closing so the
      // cluster is never left "in production" needing WAL replay — a torn checkpoint
      // there bricks the store (field-report Defect 1). Best-effort; close still runs.
      try {
        const { default: cfg } = await import('../config.js');
        if (cfg.db.mode === 'embedded') {
          await cortexDb.raw('CHECKPOINT');
          // CHECKPOINT succeeded → the cluster is consistent and reachable. Take
          // the cleanest snapshot now, while the dir is quiescent (socket already
          // closed, no concurrent writers) and before we close (F2). Bounded so a
          // slow dump can't hang shutdown.
          try {
            const { takeSnapshot } = await import('../db/snapshots.js');
            await Promise.race([
              takeSnapshot({ reason: 'shutdown', log }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('snapshot timed out')), 8_000)),
            ]);
          } catch (e) { log(`shutdown snapshot failed: ${e.message}`); }
        }
      } catch (e) { log(`shutdown checkpoint failed: ${e.message}`); }
      await cortexDb.destroy();
    } catch (err) {
      log(`pool destroy failed: ${err.message}`);
    }
    await removePidFile();
    releaseDaemonLock();
    clearRegistry();
    log('stopped');
  });

  log(`ready in ${Date.now() - STARTED_AT}ms — ${registry.list().length} methods registered`);

  if (foreground) {
    // Print a readiness line to stdout so the auto-spawner can detect it.
    process.stdout.write('sigild ready\n');
  }
}

// Fire-and-forget Postgres reachability probe. Sets the shared dbHealth flag
// and logs loudly on failure. Never throws, never blocks startup — a down DB
// must not stop the daemon (so `sigil` keeps responding and the user gets a
// clear signal rather than silent empty memory).
async function probeDbHealth(log) {
  try {
    const { default: cortexDb } = await import('../db/cortex.js');
    const { setDbHealth } = await import('./registry-holder.js');
    try {
      await cortexDb.raw('SELECT 1');
      setDbHealth({ healthy: true, error: null, checkedAt: Date.now() });
      // Embedded-only self-heal (finding 6.6): a serial sequence left behind its
      // column's MAX(id) makes the next INSERT collide on the pkey, silently
      // breaking writes. Heal it on every boot. Embedded is single-process, so
      // there's no concurrency risk; server Postgres owns its own sequences, so
      // we skip it there.
      try {
        const { default: config } = await import('../config.js');
        if (config.db.mode === 'embedded') {
          const { resyncSequences } = await import('../db/migrate.js');
          const { resynced } = await resyncSequences(cortexDb);
          if (resynced) log(`db: resynced ${resynced} sequence(s) to MAX(id)`);
        }
      } catch (e) { log(`db: sequence resync skipped — ${e.message}`); }
    } catch (err) {
      setDbHealth({ healthy: false, error: err.message, checkedAt: Date.now() });
      log(`DB UNREACHABLE: ${err.message} — memory operations will fail until Postgres is back`);
      // Boot-time non-destructive heal (F3, field-report Defect 1): if the
      // EMBEDDED cluster won't open, it may be torn. Restore the latest snapshot
      // — the torn dir is moved aside (preserved), never deleted — and re-probe.
      // Only when a snapshot exists; a never-initialized cluster is left for
      // provision/`sigil repair db` to handle. One-shot; never loops.
      await tryBootRecovery(cortexDb, setDbHealth, log);
    }
  } catch { /* import failure — nothing we can do, leave health unknown */ }
}

async function tryBootRecovery(cortexDb, setDbHealth, log) {
  try {
    const { default: config } = await import('../config.js');
    if (config.db.mode !== 'embedded') return;
    const { latestSnapshot, recoverFromSnapshot } = await import('../db/snapshots.js');
    if (!latestSnapshot()) {
      log('db: no snapshot available — cannot auto-recover (run `sigil repair db` after fixing config)');
      return;
    }
    log('db: embedded cluster unopenable — attempting non-destructive restore from latest snapshot...');
    // Drop the dead pool + WASM instance so the dir can be moved and reopened.
    const { resetCortexPool } = await import('../db/cortex.js');
    await resetCortexPool();
    const r = await recoverFromSnapshot({ log });
    if (!r.restored) { log(`db: auto-recover skipped (${r.reason})`); return; }
    await cortexDb.raw('SELECT 1'); // re-probe — rebuilds the pool on the fresh dir
    setDbHealth({ healthy: true, error: null, checkedAt: Date.now() });
    log('db: recovered — cluster healthy after snapshot restore');
  } catch (e) {
    log(`db: auto-recover failed — ${e.message}`);
  }
}

function makeLogger() {
  // Best-effort sync open; if it fails we fall back to stderr.
  let stream;
  try {
    stream = createWriteStream(SIGIL_DAEMON_LOG, { flags: 'a' });
  } catch { /* fall through */ }

  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (stream) stream.write(line);
    else process.stderr.write(line);
  };
}

// Allow running this file directly: `node src/daemon/index.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  startDaemon({ foreground: true }).catch(async (err) => {
    try { await appendFile(SIGIL_DAEMON_LOG, `[fatal] ${err.stack || err.message}\n`); } catch { /* ignore */ }
    process.stderr.write(`[sigild] fatal: ${err.message}\n`);
    process.exit(1);
  });
}
