export function registerGetPod(registry) {
  registry.register('getPod', async (params) => {
    const { findByUid } = await import('../../memory/pods/store.js');
    const { listMembers } = await import('../../memory/pods/membership.js');

    const { uid } = params;
    if (!uid) {
      const err = new Error('getPod: uid required');
      err.code = 'invalid_params';
      throw err;
    }

    const pod = await findByUid(uid);
    if (!pod) {
      return { notFound: true, uid };
    }

    const attrs = typeof pod.attrs === 'object' ? pod.attrs : safeParse(pod.attrs);

    const [facts, documents] = await Promise.all([
      listMembers(pod.id, { memberType: 'fact', limit: 20 }),
      listMembers(pod.id, { memberType: 'document', limit: 10 }),
    ]);

    return {
      pod: {
        id: pod.id,
        uid: pod.uid,
        name: pod.name,
        podType: pod.podType,
        namespace: pod.namespace,
        status: pod.status,
        startedAt: pod.startedAt ?? null,
        endedAt: pod.endedAt ?? null,
        entityId: pod.entityId ?? null,
        connectionId: pod.connectionId ?? null,
        externalId: pod.externalId ?? null,
        attrs,
      },
      facts: facts.map((f) => ({
        id: f.id,
        content: f.content,
        podRole: f.podRole ?? null,
      })),
      documents: documents.map((d) => ({
        id: d.id,
        title: d.title ?? null,
        sourcePath: d.sourcePath ?? null,
      })),
    };
  });
}

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
