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
    const minConfidence = params.minConfidence;
    const pointInTime = params.pointInTime ? new Date(params.pointInTime) : undefined;
    const podScope = params.podScope ?? null;

    const result = await search(query, {
      namespaces,
      limit,
      useGraph,
      route,
      synthesize,
      includeChunks,
      minConfidence,
      pointInTime,
      podScope,
    });

    const response = {
      query,
      namespaces,
      facts: (result.facts || []).map(serializeFact),
      chunks: (result.chunks || []).map(serializeChunk),
      synthesized: result.synthesized || null,
      matchedEntity: result.matchedEntity || null,
      relatedEntities: result.relatedEntities || [],
    };

    const { default: bus } = await import('../events.js');
    bus.emit('read.search', {
      query: query.length > 80 ? query.slice(0, 80) + '…' : query,
      namespaces,
      factCount: response.facts.length,
      chunkCount: response.chunks.length,
    });

    return response;
  });
}

function serializeFact(f) {
  return {
    id: f.id ?? null,
    uid: f.uid ?? null,
    content: f.content,
    category: f.category ?? null,
    confidence: f.confidence ?? null,
    importance: f.importance ?? null,
    similarity: numOrNull(f.similarity),
    rrfScore: numOrNull(f.rrfScore),
  };
}

function serializeChunk(c) {
  return {
    id: c.id ?? null,
    content: c.content,
    sectionHeading: c.sectionHeading ?? null,
    similarity: numOrNull(c.similarity),
    rrfScore: numOrNull(c.rrfScore),
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
