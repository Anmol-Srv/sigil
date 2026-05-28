export function registerStatus(registry) {
  registry.register('status', async (params) => {
    const { getStats } = await import('../../memory/documents/store.js');
    const { getEntityCount } = await import('../../memory/entities/store.js');
    const { getRelationCount } = await import('../../memory/entities/relations.js');
    const { getFactCount, getHotFacts } = await import('../../memory/facts/store.js');
    const { getEntityHebbianStats } = await import('../../memory/lifecycle/entity-hebbian.js');
    const { default: cortexDb } = await import('../../db/cortex.js');

    const namespace = params.namespace || null;
    const hotFactsLimit = Number.isFinite(params.hotFactsLimit) ? params.hotFactsLimit : 5;

    const [docStats, factCount, documents, people, topics, relations, podRows, hebbian, hotFacts] = await Promise.all([
      getStats(namespace),
      getFactCount(namespace),
      getEntityCount('document'),
      getEntityCount('person'),
      getEntityCount('topic'),
      getRelationCount(),
      cortexDb('pod').where({ status: 'active' }).select('podType'),
      getEntityHebbianStats({ topN: 3 }).catch(() => null),
      getHotFacts(namespace, { limit: hotFactsLimit }).catch(() => []),
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
      hotFacts: (hotFacts || []).map((f) => ({
        id: f.id ?? null,
        content: f.content,
        accessCount: f.accessCount ?? 0,
      })),
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
