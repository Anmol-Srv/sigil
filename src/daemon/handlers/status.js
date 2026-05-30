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

    // Live DB reachability check first. If Postgres is down, return a clean
    // degraded payload (zeros + db.healthy=false) instead of letting the
    // Promise.all below throw — the GUI/CLI renders a loud banner from this
    // rather than memory silently appearing empty.
    let dbHealthy = true;
    let dbError = null;
    try {
      await cortexDb.raw('SELECT 1');
    } catch (err) {
      dbHealthy = false;
      dbError = err.message;
    }
    try {
      const { setDbHealth } = await import('../registry-holder.js');
      setDbHealth({ healthy: dbHealthy, error: dbError, checkedAt: Date.now() });
    } catch { /* holder unavailable outside daemon */ }

    if (!dbHealthy) {
      return {
        namespace,
        db: { healthy: false, error: dbError },
        documents: 0,
        chunks: 0,
        facts: 0,
        entities: { documents: 0, people: 0, topics: 0 },
        relations: 0,
        podsByType: {},
        hotFacts: [],
        hebbian: null,
      };
    }

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
      db: { healthy: true, error: null },
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
