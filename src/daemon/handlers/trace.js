/**
 * trace.* — read the persisted causal log that powers the Activity tab.
 *
 *   trace.list  → latest N traces (newest first), filter by kind/namespace
 *   trace.clear → wipe history
 */
export function registerTrace(registry) {
  registry.register('trace.list', async (params = {}) => {
    const { listTraces } = await import('../trace-store.js');
    const traces = await listTraces({
      kind: params.kind || null,
      agent: params.agent || null,
      namespace: params.namespace || null,
      before: params.before || null,
      limit: params.limit ?? 50,
    });
    return { traces };
  });

  registry.register('trace.clear', async (params = {}) => {
    if (params.confirm !== true) {
      const err = new Error('trace.clear: params.confirm must be true');
      err.code = 'confirmation_required';
      throw err;
    }
    const { clearTraces } = await import('../trace-store.js');
    return clearTraces();
  });
}
