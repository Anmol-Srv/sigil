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

    const facts = (result.facts || []).map(serializeFact);
    // Turn raw source-document IDs into something an agent can act on. A bare
    // `sourceDocumentIds: [7]` tells a caller nothing; a title + uid tells it a
    // whole document exists and exactly how to fetch it (getDocument). This is
    // the pointer half of the on-demand contract — search stays cheap and
    // discovery-only, and no document text moves until someone asks for it.
    await attachSourceDocuments(facts);

    const response = {
      query,
      namespaces,
      facts,
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

// Resolve every referenced document once (not per fact) and hang
// `{uid, title, sourceType}` off each fact as `sourceDocuments`. Best-effort:
// a lookup failure must never fail the search that already succeeded.
async function attachSourceDocuments(facts) {
  const ids = [...new Set(facts.flatMap((f) => f.sourceDocumentIds || []))];
  if (!ids.length) return;
  try {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const rows = await cortexDb('document').whereIn('id', ids).select('id', 'uid', 'title', 'sourceType');
    mapSourceDocuments(facts, rows);
  } catch { /* pointers are an enrichment, never a hard dependency */ }
}

/**
 * Pure half of attachSourceDocuments — join facts to document rows.
 *
 * Split out to be testable without a database. Keys are compared as strings on
 * purpose: `fact.source_document_ids` is an int[] that arrives as JS numbers,
 * while `document.id` can come back as a string from some drivers (bigint
 * handling differs), and a `===` mismatch there would silently drop every
 * pointer while looking perfectly healthy.
 */
export function mapSourceDocuments(facts, rows) {
  const byId = new Map(rows.map((d) => [String(d.id), d]));
  for (const f of facts) {
    f.sourceDocuments = (f.sourceDocumentIds || [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean)
      .map((d) => ({ uid: d.uid, title: d.title, sourceType: d.sourceType }));
  }
  return facts;
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
