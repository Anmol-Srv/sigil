/**
 * trace.* — read the persisted causal log that powers the Activity tab.
 *
 *   trace.list  → latest N traces (newest first), filter by kind/namespace
 *   trace.get   → one trace by uid (full detail)
 *   trace.clear → wipe history
 */
export function registerTrace(registry) {
  registry.register('trace.list', async (params = {}) => {
    const { listTraces } = await import('../trace-store.js');
    const traces = await listTraces({
      kind: params.kind || null,
      namespace: params.namespace || null,
      before: params.before || null,
      limit: params.limit ?? 50,
    });
    return { traces };
  });

  registry.register('trace.get', async (params = {}) => {
    if (!params.uid) {
      const err = new Error('trace.get: params.uid is required');
      err.code = 'invalid_params';
      throw err;
    }
    const { getTrace } = await import('../trace-store.js');
    const trace = await getTrace(params.uid);
    return { trace };
  });

  registry.register('trace.clear', async () => {
    const { clearTraces } = await import('../trace-store.js');
    return clearTraces();
  });
}
