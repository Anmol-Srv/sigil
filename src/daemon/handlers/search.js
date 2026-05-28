export function registerSearch(registry) {
  registry.register('search', async (params) => {
    const query = (params.query ?? '').trim();
    if (!query) {
      const err = new Error('search: params.query is required');
      err.code = 'invalid_params';
      throw err;
    }

    const { search } = await import('../../memory/search/hybrid.js');
    const { default: config } = await import('../../config.js');

    const namespaces = Array.isArray(params.namespaces) && params.namespaces.length
      ? params.namespaces
      : [config.defaults.namespace];
    const limit = Number.isFinite(params.limit) ? params.limit : 10;
    const useGraph    = Boolean(params.useGraph);
    const route       = Boolean(params.route);
    const synthesize  = Boolean(params.synthesize);
    const includeChunks = Boolean(params.includeChunks) || synthesize;

    const { facts, chunks, synthesized } = await search(query, {
      namespaces,
      limit,
      useGraph,
      route,
      synthesize,
      includeChunks,
    });

    return {
      query,
      namespaces,
      facts: facts.map((f) => ({
        content: f.content,
        similarity: numOrNull(f.similarity),
        rrfScore: numOrNull(f.rrfScore),
        id: f.id ?? null,
      })),
      chunks: chunks.map((c) => ({
        content: c.content,
        similarity: numOrNull(c.similarity),
        rrfScore: numOrNull(c.rrfScore),
        id: c.id ?? null,
      })),
      synthesized: synthesized || null,
    };
  });
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
