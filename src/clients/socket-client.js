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
        const e = new Error('daemon connection closed');
        e.code = 'ECLOSED';
        entry.reject(e);
      }
      pending.clear();
    });

    sock.on('error', () => { /* surfaced via close handler */ });

    function makeApi() {
      return {
        // `opts.timeoutMs` overrides the client default for THIS call. Reads and
        // writes have very different honest budgets: a search answers in under a
        // second, while a save runs a chain of LLM calls (classify → extract →
        // AUDM decide → entity link) and routinely exceeds 30s. Judging both by
        // the read budget is what made a save that the daemon went on to
        // complete successfully report "rpc timeout after 30000ms" to the user,
        // who then retried — and the retry queued behind the still-running first
        // one. One timeout per call site, not one per connection.
        call(method, params, { timeoutMs: callTimeoutMs = timeoutMs } = {}) {
          if (closed) {
            // Stamp a transport code so callers (e.g. the MCP daemon-call
            // reconnect path) can detect a stale-closed client and reconnect,
            // rather than surfacing "client is closed" to the user. This fires
            // when the daemon restarted out from under a long-lived client.
            const e = new Error('client is closed');
            e.code = 'ECLOSED';
            return Promise.reject(e);
          }
          const id = randomUUID();
          // Carry agent provenance ('claude-code' / 'codex' / 'cursor' / 'mcp'
          // / 'cli') so the daemon can stamp created_by_agent. Set per entry
          // point via SIGIL_AGENT; null when unknown (back-compat).
          const agent = process.env.SIGIL_AGENT || null;
          const frame = JSON.stringify({ id, method, params, agent }) + '\n';
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              if (pending.delete(id)) {
                rej(new Error(`rpc timeout after ${callTimeoutMs}ms: ${method}`));
              }
            }, callTimeoutMs);
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
