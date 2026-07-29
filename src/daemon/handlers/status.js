export function registerStatus(registry) {
  registry.register('status', async (params) => {
    const { getStats } = await import('../../memory/documents/store.js');
    const { getFactCount } = await import('../../memory/facts/store.js');
    const { default: cortexDb } = await import('../../db/cortex.js');

    const namespace = params.namespace || null;

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

    // Cached provider health from explicit diagnostics/setup. null until probed;
    // status itself stays read-only and never launches a provider.
    let providers = null;
    try {
      const { getProviderHealth } = await import('../registry-holder.js');
      providers = getProviderHealth();
    } catch { /* holder unavailable outside daemon */ }

    // Live coding-agent process gauges make an explicitly configured
    // claude-cli provider's bounded one-shot activity visible.
    let claudeProcs = null;
    try {
      const { claudeProcStats } = await import('../../lib/llm/providers/claude-cli.js');
      claudeProcs = claudeProcStats();
    } catch { /* provider unavailable */ }

    if (!dbHealthy) {
      return {
        namespace,
        db: { healthy: false, error: dbError, schema: dbSchema },
        providers,
        claudeProcs,
        documents: 0,
        chunks: 0,
        facts: 0,
      };
    }

    const [docStats, factCount] = await Promise.all([
      getStats(namespace),
      getFactCount(namespace),
    ]);

    return {
      namespace,
      db: { healthy: true, error: null, schema: 'ready' },
      providers,
      claudeProcs,
      documents: docStats.documentCount,
      chunks: docStats.totalChunks,
      facts: factCount,
    };
  });
}
