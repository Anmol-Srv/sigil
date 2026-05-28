/**
 * RemoteClient — talks to a master device over Iroh sigil/rpc/1.
 *
 * One Iroh connection is held for the lifetime of the client and reused
 * across many calls. Each call opens a bi-stream, sends the request,
 * reads the response, closes the stream. If the underlying connection
 * dies the next call re-dials transparently.
 *
 * Identity: uses THIS device's Ed25519 secret (loaded by net/identity.js
 * inside net/endpoint.js). The master verifies it by NodeID lookup in
 * the device table — auth happens at the QUIC handshake, not in the
 * application payload.
 */
import { randomUUID } from 'node:crypto';

import config from '../config.js';
import { dial } from '../net/endpoint.js';
import { RPC_ALPN } from '../net/rpc-server.js';

const MAX_RESP = 8 * 1024 * 1024;

export async function createRemoteClient() {
  const masterNodeId = config.network.masterNodeId;
  if (!masterNodeId) {
    throw new Error('RemoteClient: SIGIL_MASTER_NODE_ID is not set. Run `sigil join <master-node-id> <code>` first.');
  }
  return new RemoteClient({ masterNodeId });
}

class RemoteClient {
  constructor({ masterNodeId }) {
    this.kind = 'remote';
    this.masterNodeId = masterNodeId;
    this.conn = null;
    this.connecting = null;
  }

  async ensureConnection() {
    if (this.conn && !this.conn._dead) return this.conn;
    if (this.connecting) return this.connecting;
    this.connecting = dial({ nodeId: this.masterNodeId }, RPC_ALPN)
      .then((c) => { this.conn = c; this.connecting = null; return c; })
      .catch((err) => { this.connecting = null; throw err; });
    return this.connecting;
  }

  async call(method, params = {}) {
    let attempt = 0;
    let lastErr;
    while (attempt < 2) {
      attempt++;
      let conn;
      try {
        conn = await this.ensureConnection();
        const bi = await conn.openBi();
        const request_id = randomUUID();
        await bi.send.writeAll(Buffer.from(JSON.stringify({ v: 1, method, params, request_id })));
        await bi.send.finish();
        const raw = await bi.recv.readToEnd(MAX_RESP);
        const frame = JSON.parse(raw.toString());
        if (!frame.ok) {
          // Handler-side rejection — leave the connection intact and
          // surface the error. PR review #10: pre-fix tore down the
          // long-lived Iroh connection on every authorization failure.
          const err = new Error(frame.error?.message || frame.error?.code || 'rpc error');
          err.code = frame.error?.code || 'handler_error';
          err.isHandlerError = true;
          throw err;
        }
        return frame.data;
      } catch (err) {
        lastErr = err;
        if (err.isHandlerError) {
          throw err; // never retry, never drop connection
        }
        // Transport-layer error → drop connection and retry once.
        if (this.conn) { this.conn._dead = true; this.conn = null; }
      }
    }
    throw lastErr;
  }

  async close() {
    const c = this.conn;
    this.conn = null;
    this.connecting = null;
    if (c?.close) {
      try { await c.close(); } catch { /* ignore */ }
    }
  }
}
