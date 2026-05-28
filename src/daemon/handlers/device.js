/**
 * device.list / device.revoke / device.activate — manage paired devices.
 *
 * Revoke reasons (PR review #7):
 *   'paused'      — temporary; re-activatable
 *   'compromised' — terminal; activate rejects, device must re-pair
 *
 * A compromised key getting one-click re-enabled is a foot-gun, so the
 * GUI distinguishes paused vs compromised in its revoke dialog and
 * activate refuses on the latter.
 */
const VALID_REASONS = new Set(['paused', 'compromised']);

export function registerDevice(registry) {
  registry.register('device.list', async (params = {}) => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
    const offset = Math.max(Number(params.offset) || 0, 0);
    const rows = await cortexDb('device')
      .select(
        'id', 'node_id', 'name', 'role', 'namespaces', 'active', 'meta',
        'last_seen_at', 'created_at', 'revoked_reason',
      )
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);
    return {
      limit, offset,
      devices: rows.map((r) => ({
        id: r.id,
        nodeId: r.nodeId,
        name: r.name,
        role: r.role,
        namespaces: r.namespaces,
        active: r.active,
        revokedReason: r.revokedReason ?? null,
        reactivatable: r.active || r.revokedReason !== 'compromised',
        lastSeenAt: r.lastSeenAt,
        createdAt: r.createdAt,
        meta: r.meta,
      })),
    };
  });

  registry.register('device.revoke', async (params) => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      const err = new Error('device.revoke: params.id required');
      err.code = 'invalid_params';
      throw err;
    }
    const reason = params.reason || 'paused';
    if (!VALID_REASONS.has(reason)) {
      const err = new Error(`device.revoke: reason must be one of ${[...VALID_REASONS].join(', ')}`);
      err.code = 'invalid_params';
      throw err;
    }
    const row = await cortexDb('device').where({ id }).first();
    const n = await cortexDb('device').where({ id }).update({
      active: false,
      revoked_reason: reason,
    });
    if (n > 0 && row) {
      // PR review #12: notify rpc-server to terminate any live
      // Iroh connections from this NodeID.
      const { default: bus } = await import('../events.js');
      bus.emit('device.revoked', { deviceId: row.id, nodeId: row.nodeId, reason });
    }
    return { revoked: n > 0, reason };
  });

  registry.register('device.activate', async (params) => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      const err = new Error('device.activate: params.id required');
      err.code = 'invalid_params';
      throw err;
    }
    const row = await cortexDb('device').where({ id }).first();
    if (!row) return { activated: false, notFound: true };
    if (row.revokedReason === 'compromised') {
      const err = new Error(
        `device ${id} ("${row.name}") was revoked as compromised. `
        + 'Re-activation is blocked — the device must re-pair with a fresh code.',
      );
      err.code = 'compromised';
      throw err;
    }
    const n = await cortexDb('device').where({ id }).update({
      active: true,
      revoked_reason: null,
    });
    return { activated: n > 0 };
  });
}
