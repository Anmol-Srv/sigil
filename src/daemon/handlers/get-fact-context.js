export function registerGetFactContext(registry) {
  registry.register('getFactContext', async (params) => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const { findByUid } = await import('../../memory/facts/store.js');

    const { uid, factId } = params;
    if (!uid && !Number.isFinite(factId)) {
      const err = new Error('getFactContext: provide uid or factId');
      err.code = 'invalid_params';
      throw err;
    }

    let fact;
    if (uid) {
      fact = await findByUid(uid);
    } else {
      fact = await cortexDb('fact').where({ id: factId }).first();
    }
    if (!fact) {
      return { notFound: true };
    }

    const [documents] = await Promise.all([
      fact.sourceDocumentIds?.length
        ? cortexDb('document').whereIn('id', fact.sourceDocumentIds).select('id', 'title', 'sourceType')
        : [],
    ]);

    return {
      fact: {
        id: fact.id,
        uid: fact.uid,
        content: fact.content,
        category: fact.category ?? null,
        confidence: fact.confidence ?? null,
        status: fact.status ?? null,
        sourceSection: fact.sourceSection ?? null,
        agent: fact.createdByAgent ?? null,
        namespace: fact.namespace ?? null,
      },
      documents: documents.map((d) => ({ id: d.id, title: d.title, sourceType: d.sourceType })),
    };
  });
}
