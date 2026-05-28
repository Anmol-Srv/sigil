export function registerGetEntityContext(registry) {
  registry.register('getEntityContext', async (params) => {
    const { findById, searchByName } = await import('../../memory/entities/store.js');
    const { listRelationsForEntity } = await import('../../memory/entities/relations.js');
    const { getFactsForEntity } = await import('../../memory/facts/entity-linker.js');

    const { entityId, name, namespace } = params;
    if (!Number.isFinite(entityId) && !name) {
      const err = new Error('getEntityContext: provide entityId or name');
      err.code = 'invalid_params';
      throw err;
    }

    let entity;
    if (Number.isFinite(entityId)) {
      entity = await findById(entityId);
    } else {
      const found = await searchByName(name, { namespace, limit: 1 });
      entity = found[0];
    }
    if (!entity) {
      return { notFound: true };
    }

    const [relations, facts] = await Promise.all([
      listRelationsForEntity(entity.id, { limit: 30 }),
      getFactsForEntity(entity.id, { limit: 10 }),
    ]);

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        entityType: entity.entityType,
        description: entity.description ?? null,
        mentionCount: entity.mentionCount ?? 0,
      },
      relations,
      facts: facts.map((f) => ({
        id: f.id,
        content: f.content,
        category: f.category ?? null,
        confidence: f.confidence ?? null,
      })),
    };
  });
}
