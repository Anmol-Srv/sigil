export function registerGetFactContext(registry) {
  registry.register('getFactContext', async (params) => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const { findByUid } = await import('../../memory/facts/store.js');
    const { getEntitiesForFact } = await import('../../memory/facts/entity-linker.js');
    const { getRelationsByFact } = await import('../../memory/entities/relations.js');

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

    const [entities, relations, documents] = await Promise.all([
      getEntitiesForFact(fact.id),
      getRelationsByFact(fact.id),
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
      },
      entities: entities.map((e) => ({ id: e.id, name: e.name, entityType: e.entityType })),
      relations,
      documents: documents.map((d) => ({ id: d.id, title: d.title, sourceType: d.sourceType })),
    };
  });
}
