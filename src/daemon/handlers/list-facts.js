export function registerListFacts(registry) {
  registry.register('listFacts', async (params) => {
    const { listFacts } = await import('../../memory/facts/store.js');
    const { resolveNamespace } = await import('../../memory/namespace.js');

    // Explicit --namespace wins; else SIGIL_NAMESPACE env > committed
    // `.sigil/namespace` marker (via params.cwd) > install default.
    const namespace = resolveNamespace({ cwd: params.cwd || null, explicit: params.namespace });
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
