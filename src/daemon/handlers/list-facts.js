export function registerListFacts(registry) {
  registry.register('listFacts', async (params) => {
    const { listFacts } = await import('../../memory/facts/store.js');
    const { default: config } = await import('../../config.js');

    const namespace = params.namespace || config.defaults.namespace;
    const category = params.category || undefined;
    const limit = Number.isFinite(params.limit) ? params.limit : 20;

    const facts = await listFacts({ namespace, category, limit });
    return {
      namespace,
      category: category || null,
      facts: facts.map((f) => ({
        id: f.id,
        uid: f.uid,
        content: f.content,
        category: f.category ?? null,
        importance: f.importance ?? null,
        confidence: f.confidence ?? null,
      })),
    };
  });
}
