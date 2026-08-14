import { writeQueueDepth, writeQueueStats } from '../write-queue.js';

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
    // status poll). null until the daemon's boot probe completes. The getter
    // re-probes in the background if config.json changed since, so a provider
    // configured after boot doesn't stay "not configured" until the next restart.
    let providers = null;
    try {
      const { getProviderHealth } = await import('../registry-holder.js');
      providers = getProviderHealth();
    } catch { /* holder unavailable outside daemon */ }

    // Live agent-process gauges — independent of DB health. `claudeProcs` is the
    // global concurrency gate that caps live `claude` spawns (the hard fix for
    // the 1600-session blowup): active/waiting/limit makes saturation visible
    // instead of silent. `managedSession` is the warm-worker engine snapshot,
    // present only when it is running in this daemon.
    let claudeProcs = null;
    let codexProcs = null;
    let managedSession = null;
    let ingestionRunner = null;
    try {
      const { claudeProcStats } = await import('../../lib/llm/providers/claude-cli.js');
      claudeProcs = claudeProcStats();
    } catch { /* provider unavailable */ }
    try {
      const { codexProcStats } = await import('../../lib/llm/providers/codex.js');
      codexProcs = codexProcStats();
    } catch { /* provider unavailable */ }
    try {
      const { getSessionManager } = await import('../../lib/llm/session/index.js');
      const mgr = getSessionManager();
      managedSession = mgr ? { enabled: true, ...mgr.stats() } : { enabled: false };
    } catch { /* holder unavailable outside daemon */ }
    try {
      const { getIngestionJobRunner } = await import('../../ingestion/jobs/runner.js');
      ingestionRunner = getIngestionJobRunner()?.stats() || { enabled: false };
    } catch { /* runner unavailable */ }

    if (!dbHealthy) {
      // NULL, not 0. These are "we could not read the store", and rendering
      // that as zero is indistinguishable from "your memory was wiped" — which
      // is exactly what a user sees when the probe merely lost a race for the
      // single embedded connection while an ingest held it. `unavailable` says
      // so outright, and writeQueue names the usual reason (a write in flight).
      return {
        namespace,
        db: { healthy: false, error: dbError, schema: dbSchema },
        unavailable: true,
        writeQueue: writeQueueDepth(),
        writeQueueStats: writeQueueStats(),
        ingestionJobs: null,
        ingestionRunner,
        providers,
        claudeProcs,
        codexProcs,
        managedSession,
        documents: null,
        chunks: null,
        facts: null,
        entities: { documents: null, people: null, topics: null },
        relations: null,
        podsByType: {},
        hotFacts: [],
        hebbian: null,
      };
    }

    const [docStats, factCount, documents, people, topics, relations, podRows, hebbian, hotFacts, ingestionJobs] = await Promise.all([
      getStats(namespace),
      getFactCount(namespace),
      getEntityCount('document'),
      getEntityCount('person'),
      getEntityCount('topic'),
      getRelationCount(),
      cortexDb('pod').where({ status: 'active' }).select('podType'),
      getEntityHebbianStats({ topN: 3 }).catch(() => null),
      getHotFacts(namespace, { limit: hotFactsLimit }).catch(() => []),
      import('../../ingestion/jobs/store.js')
        .then(({ getJobStats }) => getJobStats({ namespace }))
        .catch(() => null),
    ]);

    const podsByType = podRows.reduce((acc, r) => {
      acc[r.podType] = (acc[r.podType] || 0) + 1;
      return acc;
    }, {});

    return {
      namespace,
      db: { healthy: true, error: null, schema: 'ready' },
      // Writers queued behind the single-connection write lock. A non-zero
      // depth is why a save is slow; it is the honest answer to "is it stuck?"
      writeQueue: writeQueueDepth(),
      writeQueueStats: writeQueueStats(),
      ingestionJobs,
      ingestionRunner,
      providers,
      claudeProcs,
      codexProcs,
      managedSession,
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
