export function registerStatus(registry) {
  registry.register('status', async (params) => {
    const { getStats } = await import('../../memory/documents/store.js');
    const { getEntityCount } = await import('../../memory/entities/store.js');
    const { getRelationCount } = await import('../../memory/entities/relations.js');
    const { getFactCount } = await import('../../memory/facts/store.js');
    const { getEntityHebbianStats } = await import('../../memory/lifecycle/entity-hebbian.js');
    const { default: cortexDb } = await import('../../db/cortex.js');

    const namespace = params.namespace || null;

    const [docStats, factCount, documents, people, topics, relations, podRows, hebbian] = await Promise.all([
      getStats(namespace),
      getFactCount(namespace),
      getEntityCount('document'),
      getEntityCount('person'),
      getEntityCount('topic'),
      getRelationCount(),
      cortexDb('pod').where({ status: 'active' }).select('podType'),
      getEntityHebbianStats({ topN: 3 }).catch(() => null),
    ]);

    const podsByType = podRows.reduce((acc, r) => {
      acc[r.podType] = (acc[r.podType] || 0) + 1;
      return acc;
    }, {});

    return {
      namespace,
      documents: docStats.documentCount,
      chunks: docStats.totalChunks,
      facts: factCount,
      entities: { documents, people, topics },
      relations,
      podsByType,
      hebbian: hebbian
        ? {
            edgeCount: hebbian.edgeCount,
            avgStrength: hebbian.avgStrength ?? 0,
            maxStrength: hebbian.maxStrength ?? 0,
            topPairs: (hebbian.topPairs || []).map((p) => ({
              a: p.aName,
              b: p.bName,
              decayed: Number(p.decayed) || 0,
            })),
          }
        : null,
    };
  });
}
