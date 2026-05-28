/**
 * pair.create / pair.list / pair.revoke — local management of pairing codes.
 * pair.consume happens over Iroh in src/net/pairing.js (different surface).
 */
import { randomBytes } from 'node:crypto';

import { hashCode } from '../../net/pairing.js';

const DEFAULT_TTL_SECONDS = 600; // 10 min

export function registerPair(registry) {
  registry.register('pair.create', async (params) => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const name = (params.name || '').trim();
    if (!name) {
      const err = new Error('pair.create: params.name required');
      err.code = 'invalid_params';
      throw err;
    }
    const role = params.role || 'writer';
    if (!['reader', 'writer', 'admin'].includes(role)) {
      const err = new Error(`pair.create: invalid role "${role}"`);
      err.code = 'invalid_params';
      throw err;
    }
    const namespaces = Array.isArray(params.namespaces) ? params.namespaces : [];
    const ttl = Number.isFinite(params.ttlSeconds) ? params.ttlSeconds : DEFAULT_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const code = generateCode();
    await cortexDb('pairing_code').insert({
      code_hash: hashCode(code),
      name,
      role,
      namespaces,
      expires_at: expiresAt,
    });

    const { getNodeInfo } = await import('../../net/endpoint.js');
    let masterNodeId = null;
    try { masterNodeId = (await getNodeInfo()).nodeId; } catch { /* iroh may be off */ }

    return {
      code,
      expiresAt: expiresAt.toISOString(),
      name,
      role,
      namespaces,
      masterNodeId,
    };
  });

  registry.register('pair.list', async () => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const rows = await cortexDb('pairing_code')
      .leftJoin('device', 'pairing_code.consumed_by_device_id', 'device.id')
      .select(
        'pairing_code.id',
        'pairing_code.name',
        'pairing_code.role',
        'pairing_code.namespaces',
        'pairing_code.expires_at',
        'pairing_code.consumed_at',
        'pairing_code.created_at',
        'device.name as consumed_by_name',
        'device.node_id as consumed_by_node_id',
      )
      .orderBy('pairing_code.created_at', 'desc');
    return {
      codes: rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        namespaces: r.namespaces,
        expiresAt: r.expiresAt,
        consumedAt: r.consumedAt,
        consumedBy: r.consumedByName ? { name: r.consumedByName, nodeId: r.consumedByNodeId } : null,
        expired: new Date(r.expiresAt) < new Date(),
      })),
    };
  });

  registry.register('pair.revoke', async (params) => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      const err = new Error('pair.revoke: params.id required');
      err.code = 'invalid_params';
      throw err;
    }
    const deleted = await cortexDb('pairing_code').where({ id }).del();
    return { deleted };
  });
}

/**
 * Pairing code format: SIGIL-XXXX-XXXX  (8 base32 chars + dash, easy to
 * read aloud and copy). 8 chars of base32 = 40 bits — enough entropy
 * given the 10-minute window and one-shot semantics.
 */
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // crockford-ish, drop confusing chars
  const bytes = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return `SIGIL-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}
