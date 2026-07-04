export function registerSearch(registry) {
  registry.register('search', async (params) => {
    const query = (params.query ?? '').trim();
    if (!query) {
      const err = new Error('search: params.query is required');
      err.code = 'invalid_params';
      throw err;
    }

    const { search } = await import('../../memory/search/hybrid.js');
    const { resolveNamespace } = await import('../../memory/namespace.js');

    // Per-project namespace resolution: an explicit namespaces[] (CLI
    // --namespace) wins; otherwise resolve from SIGIL_NAMESPACE env > committed
    // `.sigil/namespace` marker at the repo root (located via params.cwd) >
    // the install default. No marker/env ⟹ the historical default.
    const namespaces = Array.isArray(params.namespaces) && params.namespaces.length
      ? params.namespaces
      : [resolveNamespace({ cwd: params.cwd || null })];
    const limit = Number.isFinite(params.limit) ? params.limit : 10;
    const useGraph    = Boolean(params.useGraph);
    const route       = Boolean(params.route);
    // expand (query-variant expansion) is opt-in and tri-state: undefined lets
    // search()/the router decide; the read hook passes true explicitly.
    const expand      = params.expand !== undefined ? Boolean(params.expand) : undefined;
    const synthesize  = Boolean(params.synthesize);
    const includeChunks = Boolean(params.includeChunks) || synthesize;
    const minConfidence = params.minConfidence;
    const pointInTime = params.pointInTime ? new Date(params.pointInTime) : undefined;
    // Default to project scope ('auto'), not the whole brain. An explicit
    // caller can still pass 'global' or a pod list. ctx carries cwd/sessionId
    // so 'auto' can resolve the active project/session pods.
    const podScope = params.podScope ?? 'auto';
    // Explicit search (CLI `sigil search`, MCP) shows everything by default —
    // the precision floor is for unprompted auto-injection (hooks), not for a
    // human/agent who deliberately asked. Opt in with applyFloor:true.
    const applyFloor = params.applyFloor ?? false;
    const ctx = { cwd: params.cwd || null, sessionId: params.sessionId || null };

    const result = await search(query, {
      namespaces,
      limit,
      useGraph,
      route,
      expand,
      synthesize,
      includeChunks,
      minConfidence,
      pointInTime,
      podScope,
      applyFloor,
      ctx,
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

    // Persist + broadcast the full causal trace (routing → entity → ranked
    // scores → decay/activation → synthesis). Best-effort; never blocks search.
    const trace = result._trace || {};
    const qShort = query.length > 80 ? query.slice(0, 80) + '…' : query;
    const strategy = trace.strategy === 'entity-first' ? ' · entity-first' : '';
    const { recordTrace } = await import('../trace-store.js');
    recordTrace({
      kind: 'search',
      summary: `"${qShort}" → ${response.facts.length} facts, ${response.chunks.length} chunks${strategy}`,
      namespace: namespaces[0] || null,
      durationMs: trace.durationMs ?? null,
      sessionId: ctx.sessionId,
      detail: { ...trace, cwd: ctx.cwd ?? null },
    }).catch(() => {});

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
