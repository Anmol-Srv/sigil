export function registerListFacts(registry) {
  registry.register('listFacts', async (params) => {
    const { listFacts } = await import('../../memory/facts/store.js');

    // null, not config.defaults.namespace: `status` counts facts across every
    // namespace when none is given, and the GUI calls both with no namespace.
    // Defaulting to one namespace here made the stat card a superset the list
    // below it could never render.
    const namespace = params.namespace || null;
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
