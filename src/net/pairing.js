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

  // Race-free redemption: do the lookup, expiry check, device upsert, and
  // code-consumption mark inside a single transaction with FOR UPDATE on
  // the code row. Two concurrent redemptions serialize; the second sees
  // consumed_by_device_id already set and gets 'already_consumed'.
  let txResult;
  try {
    txResult = await cortexDb.transaction(async (trx) => {
      const row = await trx('pairing_code')
        .where({ code_hash: codeHash })
        .forUpdate()
        .first();
      if (!row) return { ok: false, error: { code: 'invalid_code', message: 'pairing code not recognised' } };
      if (row.consumedByDeviceId) return { ok: false, error: { code: 'already_consumed', message: 'pairing code was already used' } };
      if (new Date(row.expiresAt) < new Date()) return { ok: false, error: { code: 'expired', message: 'pairing code has expired' } };

      // Upsert device row keyed by node_id. PostgreSQL ON CONFLICT lets
      // us collapse the existing/new branches into one statement that
      // returns the resulting id either way.
      const meta = {
        hostname: req.hostname || null,
        sigilVersion: req.sigilVersion || null,
      };
      const [device] = await trx('device')
        .insert({
          node_id: remoteNodeId,
          name: req.name,
          role: row.role,
          namespaces: row.namespaces,
          active: true,
          last_seen_at: trx.fn.now(),
          meta: JSON.stringify(meta),
        })
        .onConflict('node_id')
        .merge({
          name: req.name,
          role: row.role,
          namespaces: row.namespaces,
          active: true,
          last_seen_at: trx.fn.now(),
          meta: JSON.stringify({ ...meta, repairedAt: new Date().toISOString() }),
        })
        .returning(['id']);

      await trx('pairing_code').where({ id: row.id }).update({
        consumed_by_device_id: device.id,
        consumed_at: trx.fn.now(),
      });

      return { ok: true, device: { id: device.id, role: row.role, namespaces: row.namespaces } };
    });
  } catch (err) {
    return reject('transaction_failed', err.message);
  }

  if (!txResult.ok) return txResult;

  let masterNodeId = null;
  try { masterNodeId = (await getNodeInfo()).nodeId; } catch { /* ignore */ }

  const { produceManifest } = await import('../memory/manifest.js');
  const manifest = await produceManifest();

  return {
    ok: true,
    device: txResult.device,
    masterNodeId,
    manifest,
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
