import { createWriteStream } from 'node:fs';
import { appendFile } from 'node:fs/promises';

import { SIGIL_DAEMON_LOG } from '../lib/paths.js';
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

import { registerPing } from './handlers/ping.js';
import { registerRemember } from './handlers/remember.js';
import { registerSearch } from './handlers/search.js';
import { registerStatus } from './handlers/status.js';
import { registerSearchEntity } from './handlers/search-entity.js';
import { registerTraverseGraph } from './handlers/traverse-graph.js';
import { registerGetFactContext } from './handlers/get-fact-context.js';
import { registerGetEntityContext } from './handlers/get-entity-context.js';
import { registerGetPod } from './handlers/get-pod.js';
import { registerListPods } from './handlers/list-pods.js';
import { registerIngestDoc } from './handlers/ingest-doc.js';
import { registerListFacts } from './handlers/list-facts.js';
import { registerForgetFact } from './handlers/forget-fact.js';
import { registerRefreshContext } from './handlers/refresh-context.js';
import { registerTestDbConnection } from './handlers/test-db-connection.js';
import { registerRunMigrations } from './handlers/run-migrations.js';
import { registerEnv } from './handlers/env.js';
import { registerNodeInfo } from './handlers/node-info.js';
import { registerPair } from './handlers/pair.js';
import { registerMode } from './handlers/mode.js';
import { registerManifest } from './handlers/manifest.js';

const STARTED_AT = Date.now();

export async function startDaemon({ foreground = false } = {}) {
  await ensureSigilHome();

  const existing = await detectRunningDaemon();
  if (existing) {
    process.stderr.write(`[sigild] already running (pid ${existing})\n`);
    process.exit(0);
  }

  // Log: append-only. We don't redirect stdout/stderr globally — handlers
  // shouldn't be using them anyway, and a separate log stream is easier
  // to tail. If launched detached, the parent already redirected fds.
  const log = makeLogger();
  log(`starting (pid ${process.pid}, node ${process.version})`);

  await writePidFile();

  const registry = createRegistry();
  setRegistry(registry);
  registerPing(registry, { startedAt: STARTED_AT });
  registerRemember(registry);
  registerSearch(registry);
  registerStatus(registry);
  registerSearchEntity(registry);
  registerTraverseGraph(registry);
  registerGetFactContext(registry);
  registerGetEntityContext(registry);
  registerGetPod(registry);
  registerListPods(registry);
  registerIngestDoc(registry);
  registerListFacts(registry);
  registerForgetFact(registry);
  registerRefreshContext(registry);
  registerTestDbConnection(registry);
  registerRunMigrations(registry);
  registerEnv(registry);
  registerNodeInfo(registry);
  registerPair(registry);
  registerMode(registry);
  registerManifest(registry);

  const socket = await startSocketServer({ registry, log });

  const { default: config } = await import('../config.js');
  let http = null;
  if (config.http.enabled) {
    try {
      http = await startHttpServer({ registry, log, config });
    } catch (err) {
      log(`http server failed to start: ${err.message}`);
    }
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

  // Lazy-init guard: handlers that touch the DB open the connection on
  // first use (see handlers/*). On shutdown we destroy the pool if it
  // was ever opened.
  installShutdownHooks(async (signal) => {
    log(`received ${signal}, shutting down`);
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
