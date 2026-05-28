export function registerListPods(registry) {
  registry.register('listPods', async (params) => {
    const { listPods } = await import('../../memory/pods/store.js');
    const { type, namespace, status = 'active', limit = 20 } = params;
    const pods = await listPods({ podType: type, namespace, status, limit });
    return {
      pods: pods.map((p) => ({
        id: p.id,
        uid: p.uid,
        name: p.name,
        podType: p.podType,
        memberFactCount: p.memberFactCount ?? 0,
        memberDocCount: p.memberDocCount ?? 0,
        updatedAt: p.updatedAt ?? null,
      })),
    };
  });
}
