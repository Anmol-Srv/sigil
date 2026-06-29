// config.json is the source of truth (replaces the old dotenv preload). On a
// legacy install, loadConfig() — called first thing in startDaemon — imports
// ~/.sigil/.env into config.json once, then renames .env so it's skipped.
import { loadConfig } from '../setup/config-store.js';

import { createWriteStream, writeFileSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';

import { PKG_ROOT, SIGIL_DAEMON_LOG, SIGIL_HEARTBEAT, SIGIL_UPDATE_FLAG } from '../lib/paths.js';
import { getSigilVersion } from '../lib/version.js';
import {
  detectRunningDaemon,
  ensureSigilHome,
  installShutdownHooks,
  removePidFile,
  writePidFile,
} from './lifecycle.js';
import { createRegistry } from './rpc-registry.js';
import { setRegistry, clearRegistry } from './registry-holder.js';
import { startSocketServer } from './socket-server.js';
import { startHttpServer } from './http-server.js';

import { registerAll } from './handlers/index.js';

const STARTED_AT = Date.now();

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

  // Claim the HTTP/GUI port FIRST — before the pidfile or the Unix socket.
  // The TCP port is the one resource that can't be silently taken over (bind
  // is exclusive), unlike the socket file which startSocketServer would
  // force-replace. If another daemon already owns the port we exit here with
  // ZERO side effects (no clobbered pidfile, no stolen socket), so we can
  // never produce the split-brain where socket RPC hits us but the GUI hits a
  // different daemon holding a mismatched auth token. detectRunningDaemon's
  // /healthz probe normally catches this earlier; this is the race-proof lock.
  let http = null;
  if (config.http.enabled) {
    try {
      http = await startHttpServer({ registry, log, config });
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        log(`http port ${config.http.port} already in use — another daemon is serving; exiting`);
        process.stderr.write(`[sigild] already running (port ${config.http.port} in use)\n`);
        clearRegistry();
        process.exit(0);
      }
      log(`http server failed to start: ${err.message}`);
    }
  }

  await writePidFile();

  const socket = await startSocketServer({ registry, log });

  // Eager DB health probe. A memory daemon that can't reach Postgres must say
  // so LOUDLY — the old behaviour let every hook silently return empty memory,
  // so the user kept working for hours thinking they had context. Non-fatal
  // and non-blocking: the daemon stays up (Claude keeps working) and the flag
  // feeds `status` → GUI banner. Skipped for lite-followers (no local DB).
  if (config.network.mode !== 'lite-follower') {
    // If the configured DB is our local Docker Postgres and it's stopped (e.g.
    // after a reboot), start it before probing. Best-effort, never blocks boot.
    try {
      const { ensureLocalPostgresRunning } = await import('../db/provision/docker.js');
      const started = await ensureLocalPostgresRunning();
      if (started.started) log('started local sigil-postgres container');
    } catch { /* docker absent / unrelated DB — ignore */ }
    probeDbHealth(log);

    // Live provider probe — a valid-looking-but-dead LLM/embedder (revoked key,
    // unreachable Ollama, wrong model) should be loud at boot, not silent until
    // the first ingest. Non-blocking; result is cached for `status`.
    (async () => {
      try {
        const { probeProviders } = await import('../lib/provider-probe.js');
        const { setProviderHealth } = await import('./registry-holder.js');
        const health = await probeProviders();
        setProviderHealth(health);
        if (health.embedding && !health.embedding.ok) log(`embedding provider DOWN: ${health.embedding.error}`);
        if (health.llm && !health.llm.ok) log(`llm provider DOWN: ${health.llm.error}`);
        if (health.embedding?.ok && health.llm?.ok) log('providers healthy (llm + embedding probed ok)');
      } catch (err) {
        log(`provider probe failed: ${err.message}`);
      }
    })();

    // Replay any Stop-hook saves that failed during an outage (provider/DB
    // down). Best-effort and non-blocking — the daemon stays up regardless.
    (async () => {
      try {
        const { drainStopSpool } = await import('../hooks/stop-spool.js');
        const r = await drainStopSpool();
        if (r.drained) log(`stop-spool drained: ${r.drained} turns replayed (${r.replayed} facts, ${r.remaining} remaining)`);
      } catch (err) {
        log(`stop-spool drain failed: ${err.message}`);
      }
    })();
  }

  // Managed-session engine (warm tmux workers; opt-in via SIGIL_MANAGED_SESSION).
  // Best-effort + non-blocking: any failure (no tmux, spawn error) just leaves
  // LLM calls on the proven one-shot path. Skipped for lite-followers, whose LLM
  // work runs on master. Started after the socket server is up so workers can
  // call back over RPC immediately.
  if (config.network.mode !== 'lite-follower') {
    (async () => {
      try {
        const { initSessionManager } = await import('../lib/llm/session/index.js');
        await initSessionManager({ config, log });
      } catch (err) {
        log(`managed-session init failed: ${err.message}`);
      }
    })();
  }

  // Iroh: warm up the endpoint when network is enabled so the NodeID
  // is registered with relays + discoverable before the first pair
  // request arrives. Failure is non-fatal — solo mode keeps working.
  let netEnabled = false;
  if (config.network.enabled) {
    try {
      // Register accept-side protocol handlers BEFORE constructing the
      // Iroh runtime. Only master nodes serve sigil/pair/1 + sigil/rpc/1
      // (followers dial outbound).
      if (config.network.mode === 'master') {
        const { registerProtocol } = await import('../net/endpoint.js');
        const { PAIR_ALPN, createPairAcceptor } = await import('../net/pairing.js');
        const { RPC_ALPN, createRpcAcceptor } = await import('../net/rpc-server.js');
        registerProtocol(PAIR_ALPN, createPairAcceptor({ log }));
        registerProtocol(RPC_ALPN, createRpcAcceptor({ registry, log }));
        log(`registered accept handlers: ${PAIR_ALPN}, ${RPC_ALPN}`);
      }

      const { getNodeInfo } = await import('../net/endpoint.js');
      const info = await getNodeInfo();
      netEnabled = true;
      log(`iroh node up: ${info.nodeId}`);
      if (info.relayUrl) log(`iroh relay: ${info.relayUrl}`);
    } catch (err) {
      log(`iroh failed to start: ${err.message}`);
    }
  } else {
    log(`iroh disabled (SIGIL_MODE=${config.network.mode})`);
  }

  // Lite-follower: swap data-touching handlers for proxies that forward
  // to master over Iroh. The local DB is never touched on this device.
  if (config.network.mode === 'lite-follower') {
    try {
      const { installLiteProxy } = await import('./lite-proxy.js');
      await installLiteProxy({ registry, log });
    } catch (err) {
      log(`lite-proxy install failed: ${err.message}`);
    }
  }

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

  // Background staleness check: tell the user when their git install has fallen
  // behind the release branch. Writes SIGIL_UPDATE_FLAG (read by the CLI
  // preamble → "update available") when behind, removes it when in sync. Git
  // installs only; best-effort; unref'd so it never holds the process open.
  // First check 30s after boot (let the daemon settle), then every 12h. Opt out
  // with SIGIL_NO_UPDATE_CHECK=1.
  if (process.env.SIGIL_NO_UPDATE_CHECK !== '1') {
    (async () => {
      try {
        const { isGitInstall, checkForUpdate } = await import('../lib/git-update.js');
        if (!isGitInstall()) return;
        const runCheck = async () => {
          try {
            const s = await checkForUpdate();
            if (s.behind > 0) {
              writeFileSync(SIGIL_UPDATE_FLAG, JSON.stringify({ ...s, ts: Date.now() }), 'utf8');
              log(`update available: ${s.local} → ${s.remote} (${s.behind} behind ${s.branch})`);
            } else {
              rmSync(SIGIL_UPDATE_FLAG, { force: true });
            }
          } catch (e) {
            log(`update check failed: ${e.message.split('\n')[0]}`);
          }
        };
        const firstCheck = setTimeout(runCheck, 30_000);
        firstCheck.unref();
        const updateCheckTimer = setInterval(runCheck, 12 * 60 * 60 * 1000);
        updateCheckTimer.unref();
      } catch { /* git-update unavailable — skip */ }
    })();
  }

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
  // is crash-loop guarded. Skipped for lite-followers (no local DB). Unref'd.
  let dbMonitorTimer = null;
  if (config.network.mode !== 'lite-follower') {
    try {
      const { startDbHealthMonitor } = await import('./db-monitor.js');
      dbMonitorTimer = startDbHealthMonitor({ log });
    } catch (err) {
      log(`db health monitor failed to start: ${err.message}`);
    }
  }

  // Periodic + post-boot snapshots of the embedded cluster (F2, field-report
  // Defect 1). A consistent dumpDataDir tarball, rotated, so F3 can restore a
  // torn cluster with bounded loss instead of wiping it. The shutdown hook takes
  // the cleanest snapshot; these cover a daemon that's later SIGKILL'd and never
  // shuts down cleanly. Embedded + healthy only; best-effort; unref'd.
  let snapshotTimer = null;
  let bootSnapshotTimer = null;
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
      bootSnapshotTimer = setTimeout(() => snapshotIfHealthy('post-boot'), 45_000);
      bootSnapshotTimer.unref();
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
    if (bootSnapshotTimer) clearTimeout(bootSnapshotTimer);
    try { rmSync(SIGIL_HEARTBEAT, { force: true }); } catch { /* ignore */ }
    // Kill warm tmux workers + stop the health sweep before tearing down the
    // socket, so no worker is left holding a half-open RPC connection.
    try {
      const { shutdownSessionManager } = await import('../lib/llm/session/index.js');
      await shutdownSessionManager();
    } catch (err) {
      log(`managed-session shutdown failed: ${err.message}`);
    }
    await socket.close();
    if (http) await http.close();
    if (netEnabled) {
      try {
        const { shutdownEndpoint } = await import('../net/endpoint.js');
        await shutdownEndpoint();
      } catch (err) {
        log(`iroh shutdown failed: ${err.message}`);
      }
    }
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
      // there's no concurrency risk; server Postgres doesn't desync and may be
      // shared across machines, so we skip it there.
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
