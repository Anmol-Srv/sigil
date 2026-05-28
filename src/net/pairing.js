/**
 * sigil/pair/1 — pairing protocol.
 *
 * Wire format (single-shot bidirectional stream):
 *
 *   client → server  { v: 1, code, name, hostname, sigilVersion, nodeId }
 *   server → client  { ok: true,  device: { id, role, namespaces }, masterNodeId, manifest? }
 *                  | { ok: false, error: { code, message } }
 *
 * Code is the plaintext one-time pairing code printed by `sigil pair
 * create`. Server hashes it and looks up `pairing_code` row, checks not
 * expired + not consumed, creates a `device` row, marks the code
 * consumed.
 *
 * Authentication of the client: Iroh's QUIC handshake already proved
 * the client controls the secret key for the NodeID we see in
 * `conn.remoteNodeId()`. We pin that NodeID into the device row.
 */
import { createHash } from 'node:crypto';

import bus from '../daemon/events.js';

export const PAIR_ALPN = 'sigil/pair/1';

const MAX_FRAME = 64 * 1024;
const SUPPORTED_VERSION = 1;

export function createPairAcceptor({ log }) {
  return async function accept(err, conn) {
    if (err) {
      log(`pair: accept err: ${err.message}`);
      return;
    }
    let remoteNodeId = '<unknown>';
    try {
      remoteNodeId = conn.remoteNodeId().toString();
      const bi = await conn.acceptBi();
      const raw = await bi.recv.readToEnd(MAX_FRAME);
      const req = JSON.parse(raw.toString());

      const result = await handlePairRequest(req, remoteNodeId);
      await bi.send.writeAll(Buffer.from(JSON.stringify(result)));
      await bi.send.finish();

      if (result.ok) {
        bus.emit('pair.consumed', { nodeId: remoteNodeId, deviceName: req.name });
        log(`pair: registered ${req.name} (${remoteNodeId.slice(0, 12)}…)`);
      } else {
        bus.emit('pair.rejected', { nodeId: remoteNodeId, code: result.error?.code });
        log(`pair: rejected ${remoteNodeId.slice(0, 12)}… (${result.error?.code})`);
      }
    } catch (e) {
      log(`pair: handler err from ${remoteNodeId.slice(0, 12)}…: ${e.message}`);
      bus.emit('pair.error', { nodeId: remoteNodeId, message: e.message });
    }
  };
}

async function handlePairRequest(req, remoteNodeId) {
  if (!req || req.v !== SUPPORTED_VERSION) {
    return reject('unsupported_version', `expected v=${SUPPORTED_VERSION}`);
  }
  if (typeof req.code !== 'string' || !req.code) {
    return reject('invalid_request', 'missing code');
  }
  if (typeof req.name !== 'string' || !req.name) {
    return reject('invalid_request', 'missing name');
  }
  if (typeof req.nodeId !== 'string' || req.nodeId.toLowerCase() !== remoteNodeId.toLowerCase()) {
    return reject('invalid_request', 'nodeId claim does not match transport identity');
  }

  const { default: cortexDb } = await import('../db/cortex.js');
  const { getNodeInfo } = await import('./endpoint.js');

  const codeHash = hashCode(req.code);
  const row = await cortexDb('pairing_code').where({ code_hash: codeHash }).first();
  if (!row) return reject('invalid_code', 'pairing code not recognised');
  if (row.consumedByDeviceId) return reject('already_consumed', 'pairing code was already used');
  if (new Date(row.expiresAt) < new Date()) return reject('expired', 'pairing code has expired');

  // Check whether this node_id is already a known device. If so, refresh
  // the existing row instead of creating a duplicate (still consume the
  // code so it can't be reused).
  const existing = await cortexDb('device').where({ node_id: remoteNodeId }).first();
  let device;
  if (existing) {
    await cortexDb('device').where({ id: existing.id }).update({
      name: req.name,
      role: row.role,
      namespaces: row.namespaces,
      active: true,
      last_seen_at: cortexDb.fn.now(),
      meta: JSON.stringify({
        hostname: req.hostname || null,
        sigilVersion: req.sigilVersion || null,
        repairedAt: new Date().toISOString(),
      }),
    });
    device = { id: existing.id };
  } else {
    const [row2] = await cortexDb('device').insert({
      node_id: remoteNodeId,
      name: req.name,
      role: row.role,
      namespaces: row.namespaces,
      active: true,
      last_seen_at: cortexDb.fn.now(),
      meta: JSON.stringify({
        hostname: req.hostname || null,
        sigilVersion: req.sigilVersion || null,
      }),
    }).returning(['id']);
    device = { id: row2.id };
  }

  await cortexDb('pairing_code').where({ id: row.id }).update({
    consumed_by_device_id: device.id,
    consumed_at: cortexDb.fn.now(),
  });

  let masterNodeId = null;
  try { masterNodeId = (await getNodeInfo()).nodeId; } catch { /* ignore */ }

  return {
    ok: true,
    device: { id: device.id, role: row.role, namespaces: row.namespaces },
    masterNodeId,
    // Full schema manifest lands in PR 12. Stub for now so the client
    // protocol can develop without blocking on the manifest design.
    manifest: { v: 1, stub: true },
  };
}

function reject(code, message) {
  return { ok: false, error: { code, message } };
}

export function hashCode(code) {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Helper for the joining device. Dials master + ALPN, exchanges JSON.
 */
export async function joinMaster({ masterAddr, code, name, sigilVersion }) {
  const { dial, getEndpoint } = await import('./endpoint.js');
  const { hostname } = await import('node:os');
  const conn = await dial(masterAddr, PAIR_ALPN);
  const ep = await getEndpoint();
  const bi = await conn.openBi();
  await bi.send.writeAll(Buffer.from(JSON.stringify({
    v: SUPPORTED_VERSION,
    code,
    name,
    nodeId: ep.nodeId(),
    hostname: hostname(),
    sigilVersion: sigilVersion || null,
  })));
  await bi.send.finish();
  const raw = await bi.recv.readToEnd(MAX_FRAME);
  return JSON.parse(raw.toString());
}
