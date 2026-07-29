/**
 * Read/export and namespace-management RPCs.
 *
 * These operations live in the daemon so a CLI never opens PGlite beside its
 * sole owner. Destructive namespace deletion also requires an explicit
 * confirmation bit at the RPC boundary, not just in the CLI renderer.
 */
export function registerManageMemory(registry) {
  registry.register('exportData', async (params = {}) => {
    const { listFacts } = await import('../../memory/facts/store.js');
    const { listDocuments } = await import('../../memory/documents/store.js');
    const { default: config } = await import('../../config.js');

    const namespace = String(params.namespace || config.defaults.namespace).trim();
    const facts = await listFacts({ namespace, limit: 10_000 });
    const documents = await listDocuments({ namespace, limit: 10_000 });

    return {
      namespace,
      facts: facts.map((fact) => ({
        uid: fact.uid,
        content: fact.content,
        category: fact.category,
        confidence: fact.confidence,
        importance: fact.importance,
        createdAt: fact.createdAt,
      })),
      documents: documents.map((document) => ({
        sourcePath: document.sourcePath,
        title: document.title,
        sourceType: document.sourceType,
        chunkCount: document.chunkCount,
        factCount: document.factCount,
      })),
    };
  });

  registry.register('listNamespaces', async () => {
    const { listNamespaces } = await import('../../memory/facts/store.js');
    return { namespaces: await listNamespaces() };
  });

  registry.register('deleteNamespace', async (params = {}) => {
    const namespace = String(params.namespace || '').trim();
    if (!namespace) {
      const err = new Error('deleteNamespace: params.namespace is required');
      err.code = 'invalid_params';
      throw err;
    }
    if (params.confirm !== true) {
      const err = new Error('deleteNamespace: params.confirm must be true');
      err.code = 'confirmation_required';
      throw err;
    }

    const { deleteNamespace } = await import('../../memory/facts/store.js');
    const result = await deleteNamespace(namespace);
    return {
      namespace,
      factsDeleted: result.factsDeleted,
      chunksDeleted: result.chunksDeleted,
      docsDeleted: result.docsDeleted,
    };
  });
}
