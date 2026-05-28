/**
 * device.list / device.revoke / device.activate — manage paired devices.
 */
export function registerDevice(registry) {
  registry.register('device.list', async () => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const rows = await cortexDb('device')
      .select('id', 'node_id', 'name', 'role', 'namespaces', 'active', 'meta', 'last_seen_at', 'created_at')
      .orderBy('created_at', 'desc');
    return {
      devices: rows.map((r) => ({
        id: r.id,
        nodeId: r.nodeId,
        name: r.name,
        role: r.role,
        namespaces: r.namespaces,
        active: r.active,
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
    const n = await cortexDb('device').where({ id }).update({ active: false });
    return { revoked: n > 0 };
  });

  registry.register('device.activate', async (params) => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const id = Number(params.id);
    if (!Number.isFinite(id)) {
      const err = new Error('device.activate: params.id required');
      err.code = 'invalid_params';
      throw err;
    }
    const n = await cortexDb('device').where({ id }).update({ active: true });
    return { activated: n > 0 };
  });
}
