export function registerSearchEntity(registry) {
  registry.register('searchEntity', async (params) => {
    const { searchByName, listByType } = await import('../../memory/entities/store.js');
    const { query, entityType, limit = 10, namespace } = params;
    if (!query && !entityType) {
      const err = new Error('searchEntity: provide query or entityType');
      err.code = 'invalid_params';
      throw err;
    }
    const results = query
      ? await searchByName(query, { entityType, namespace, limit })
      : await listByType(entityType, { namespace, limit });

    return {
      query: query || null,
      entityType: entityType || null,
      entities: results.map((e) => ({
        id: e.id,
        name: e.name,
        entityType: e.entityType,
        description: e.description ?? null,
        mentionCount: e.mentionCount ?? 0,
      })),
    };
  });
}
