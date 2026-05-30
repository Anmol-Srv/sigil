import { createServer } from 'node:net';
import { chmod } from 'node:fs/promises';

import { SIGIL_DAEMON_SOCK } from '../lib/paths.js';
import { removeSocketFile } from './lifecycle.js';

/**
 * Newline-delimited JSON over a Unix domain socket.
 *
 * Each connection is independent. We buffer incoming bytes and split on \n;
 * every complete line is parsed as one JSON-RPC request:
 *
 *   { "id": "uuid", "method": "search", "params": {...} }
 *
 * The response is one line per request, in any order (clients correlate by id):
 *
 *   { "id": "uuid", "ok": true,  "data": {...} }
 *   { "id": "uuid", "ok": false, "error": { "code": "...", "message": "..." } }
 *
 * Why NDJSON: trivial to implement, debuggable with `nc -U ~/.sigil/sock`,
 * no length-prefix bookkeeping. Frame size is naturally bounded by what
 * handlers return; for huge payloads we'd add streaming later.
 */
export async function startSocketServer({ registry, log }) {
  // Always start from a clean socket file — leftover socket files from a
  // crashed previous daemon will refuse bind() with EADDRINUSE.
  await removeSocketFile();

  const server = createServer((socket) => {
    let buffer = '';
    let closed = false;
    // PR review #16: per-connection Promise chain serializes handler
    // dispatch. Two `remember` calls on the same MCP connection now
    // execute in arrival order; AUDM's pairwise dedup invariants
    // (whose comments warn against parallel ingests) are preserved.
    let chain = Promise.resolve();
    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      if (closed) return;
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        chain = chain.then(() => {
          if (closed) return; // PR review #30
          return handleFrame(line, socket, registry, log);
        });
      }
    });

    socket.on('close', () => { closed = true; });

    socket.on('error', (err) => {
      // EPIPE / ECONNRESET are routine when clients hang up mid-call.
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
        log(`socket error: ${err.message}`);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SIGIL_DAEMON_SOCK, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // Restrict to current user only. Unix socket permissions are enforced
  // by the kernel exactly like file perms — 0600 means only this UID
  // (and root) can connect. Anyone with access to your home dir could
  // read your memory database anyway, so this matches the existing trust
  // boundary, but it's still worth pinning explicitly.
  try { await chmod(SIGIL_DAEMON_SOCK, 0o600); } catch { /* best effort */ }

  log(`socket listening at ${SIGIL_DAEMON_SOCK}`);

  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handleFrame(line, socket, registry, log) {
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    writeFrame(socket, {
      id: null,
      ok: false,
      error: { code: 'invalid_json', message: err.message },
    });
    return;
  }

  const { id = null, method, params, agent = null } = req || {};
  if (typeof method !== 'string') {
    writeFrame(socket, {
      id,
      ok: false,
      error: { code: 'invalid_params', message: 'request must include a string "method"' },
    });
    return;
  }

  const result = await registry.dispatch(method, params, { transport: 'socket', agent });
  writeFrame(socket, { id, ...result });

  if (!result.ok && process.env.SIGIL_DEBUG) {
    log(`dispatch ${method} -> ${result.error.code}: ${result.error.message}`);
  }
}

function writeFrame(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch {
    // Best-effort; ECONNRESET handled by 'error' listener on the socket.
  }
}
