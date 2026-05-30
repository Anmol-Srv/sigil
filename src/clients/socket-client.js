import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';

import { SIGIL_DAEMON_SOCK } from '../lib/paths.js';

/**
 * Tiny JSON-RPC-over-NDJSON client for the local daemon.
 *
 * Usage:
 *   const client = await openSocketClient();
 *   const { data } = await client.call('search', { query: '...' });
 *   await client.close();
 *
 * `call` rejects with `SigilRpcError` on a non-ok response; transport
 * errors (socket dies mid-call) reject with the underlying Node error.
 */
export class SigilRpcError extends Error {
  constructor({ code, message, stack }) {
    super(message || code || 'rpc error');
    this.name = 'SigilRpcError';
    this.code = code || 'handler_error';
    if (stack) this.remoteStack = stack;
  }
}

export function openSocketClient({ path = SIGIL_DAEMON_SOCK, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const pending = new Map();
    let buffer = '';
    let closed = false;

    sock.setEncoding('utf8');

    sock.once('connect', () => {
      sock.off('error', onErrorBeforeConnect);
      resolve(makeApi());
    });

    function onErrorBeforeConnect(err) {
      reject(err);
    }
    sock.once('error', onErrorBeforeConnect);

    sock.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        const entry = pending.get(frame.id);
        if (!entry) continue;
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.ok) entry.resolve(frame);
        else entry.reject(new SigilRpcError(frame.error || {}));
      }
    });

    sock.on('close', () => {
      closed = true;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('daemon connection closed'));
      }
      pending.clear();
    });

    sock.on('error', () => { /* surfaced via close handler */ });

    function makeApi() {
      return {
        call(method, params) {
          if (closed) return Promise.reject(new Error('client is closed'));
          const id = randomUUID();
          // Carry agent provenance ('claude-code' / 'codex' / 'cursor' / 'mcp'
          // / 'cli') so the daemon can stamp created_by_agent. Set per entry
          // point via SIGIL_AGENT; null when unknown (back-compat).
          const agent = process.env.SIGIL_AGENT || null;
          const frame = JSON.stringify({ id, method, params, agent }) + '\n';
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              if (pending.delete(id)) {
                rej(new Error(`rpc timeout after ${timeoutMs}ms: ${method}`));
              }
            }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            sock.write(frame);
          });
        },
        close() {
          return new Promise((res) => {
            if (closed) return res();
            sock.end(() => res());
          });
        },
      };
    }
  });
}
