export function registerTraverseGraph(registry) {
  registry.register('traverseGraph', async (params) => {
    const { findById } = await import('../../memory/entities/store.js');
    const { getEntityNeighborhood, findPath, findRelated } = await import('../../memory/entities/traversal.js');

    const { startEntityId, action = 'neighbors', targetEntityId, relationType, maxDepth = 2, limit = 20 } = params;
    if (!Number.isFinite(startEntityId)) {
      const err = new Error('traverseGraph: startEntityId required');
      err.code = 'invalid_params';
      throw err;
    }

    const entity = await findById(startEntityId);
    if (!entity) {
      return { ok: false, notFound: true, startEntityId };
    }

    const summary = {
      id: entity.id,
      name: entity.name,
      entityType: entity.entityType,
    };

    if (action === 'path') {
      if (!Number.isFinite(targetEntityId)) {
        const err = new Error('traverseGraph: targetEntityId required for action=path');
        err.code = 'invalid_params';
        throw err;
      }
      const result = await findPath(entity.id, targetEntityId, { maxDepth: Math.min(maxDepth, 4) });
      return { action, start: summary, targetEntityId, path: result || null };
    }

    if (action === 'related') {
      const related = await findRelated(entity.id, { maxDepth: Math.min(maxDepth, 3), relationType, limit });
      return { action, start: summary, related };
    }

    const result = await getEntityNeighborhood(entity.id, { depth: Math.min(maxDepth, 3), limit });
    return {
      action: 'neighbors',
      start: summary,
      relations: result.relations || [],
      related: result.related || null,
    };
  });
}
