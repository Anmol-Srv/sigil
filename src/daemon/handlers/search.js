export function registerSearch(registry) {
  registry.register('search', async (params, ctx = {}) => {
    const query = (params.query ?? '').trim();
    if (!query || query.length > 8_000) {
      const err = new Error('search: params.query must contain 1-8000 characters');
      err.code = 'invalid_params';
      throw err;
    }

    const startedAt = Date.now();
    const { search } = await import('../../memory/search/hybrid.js');
    const { resolveMemoryScope } = await import('../memory-scope.js');
    const memoryScope = resolveMemoryScope(params, ctx);
    const limit = Number.isFinite(params.limit) ? params.limit : 10;
    const includeChunks = Boolean(params.includeChunks);
    const minConfidence = params.minConfidence;
    const pointInTime = params.pointInTime ? new Date(params.pointInTime) : undefined;
    const applyFloor = params.applyFloor ?? false;

    const result = await search(query, {
      namespaces: memoryScope.namespaces,
      namespaceTiers: memoryScope.namespaceTiers,
      limit,
      includeChunks,
      minConfidence,
      pointInTime,
      categories: params.categories,
      applyFloor,
    });

    const response = {
      query,
      namespaces: memoryScope.namespaces,
      scope: memoryScope.mode,
      facts: (result.facts || []).map(serializeFact),
      chunks: (result.chunks || []).map(serializeChunk),
      trace: result._trace || null,
    };

    // The one automatic prompt hook is observable without making search write
    // to PGlite. The bounded runtime ledger carries only client, timestamp,
    // result count, duration, and namespace — never the prompt or memory text.
    if (params.observePromptRecall === true) {
      const { recordPromptRecall } = await import('../recall-observatory.js');
      recordPromptRecall({
        agent: ctx.agent,
        namespace: memoryScope.writeNamespace,
        resultCount: response.facts.length,
        durationMs: Date.now() - startedAt,
      });
    }

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
    // Provenance (surfaced, never a scope): which agent/device wrote it and
    // which source documents it came from.
    agent: f.createdByAgent ?? null,
    device: f.createdByDeviceId ?? null,
    sourceDocumentIds: Array.isArray(f.sourceDocumentIds) ? f.sourceDocumentIds : [],
    sourceSection: f.sourceSection ?? null,
    // The namespace is the retrieval scope (shared/project/explicit), not the
    // agent that wrote the fact. Returning it makes ranking evidence honest.
    namespace: f.namespace ?? null,
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
