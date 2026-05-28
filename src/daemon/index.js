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
import { startSocketServer } from './socket-server.js';

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

  const socket = await startSocketServer({ registry, log });

  // Lazy-init guard: handlers that touch the DB open the connection on
  // first use (see handlers/*). On shutdown we destroy the pool if it
  // was ever opened.
  installShutdownHooks(async (signal) => {
    log(`received ${signal}, shutting down`);
    await socket.close();
    try {
      const { default: cortexDb } = await import('../db/cortex.js');
      await cortexDb.destroy();
    } catch (err) {
      log(`pool destroy failed: ${err.message}`);
    }
    await removePidFile();
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
