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
    let dbSchema = 'ready';
    try {
      await cortexDb.raw('SELECT 1');
      // Honest diagnostics (F7): a reachable DB whose tables don't exist is NOT
      // the same as a down DB or an empty one. Without this, getStats() below
      // throws an opaque "relation \"document\" does not exist" that reads as a
      // generic failure; instead report "schema not initialized" with the real
      // remedy (run migrations), distinct from "0 docs" (healthy + empty).
      const tbl = await cortexDb('information_schema.tables')
        .where({ table_schema: 'public', table_name: 'document' })
        .first();
      if (!tbl) {
        dbHealthy = false;
        dbSchema = 'missing';
        dbError = 'schema not initialized (no tables) — run `sigil migrate`';
      }
    } catch (err) {
      dbHealthy = false;
      dbError = err.message;
    }
    try {
      const { setDbHealth } = await import('../registry-holder.js');
      setDbHealth({ healthy: dbHealthy, error: dbError, schema: dbSchema, checkedAt: Date.now() });
    } catch { /* holder unavailable outside daemon */ }

    // Provider health from the boot probe (cached — no live provider call per
    // status poll). null until the daemon's boot probe completes.
    let providers = null;
    try {
      const { getProviderHealth } = await import('../registry-holder.js');
      providers = getProviderHealth();
    } catch { /* holder unavailable outside daemon */ }

    if (!dbHealthy) {
      return {
        namespace,
        db: { healthy: false, error: dbError, schema: dbSchema },
        providers,
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
      db: { healthy: true, error: null, schema: 'ready' },
      providers,
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
