/** Runtime-only automatic-recall status for the Agents screen and diagnostics. */
export function registerRecall(registry) {
  registry.register('recall.status', async (params = {}) => {
    const { recallStatus } = await import('../recall-observatory.js');
    return recallStatus({ agent: params.agent || null, limit: params.limit });
  });
}
