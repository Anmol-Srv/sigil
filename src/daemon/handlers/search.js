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

    // Author provenance filters (opt-in). `agent` is matched verbatim against
    // created_by_agent. `device` accepts either a numeric device.id or a device
    // NAME — resolve the name to its id here (the SQL filter only knows the id).
    const agent = typeof params.agent === 'string' && params.agent.trim() ? params.agent.trim() : null;
    const deviceId = await resolveDeviceFilter(params.device);

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
      agent,
      deviceId,
      ctx,
    });

    // Resolve device.id → friendly name for every distinct device in the result
    // set, in one query, so the CLI can show "by <agent>@<device-name>".
    const deviceNames = await resolveDeviceNames(result.facts || []);

    const response = {
      query,
      namespaces,
      facts: (result.facts || []).map((f) => serializeFact(f, deviceNames)),
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

function serializeFact(f, deviceNames = new Map()) {
  const deviceId = f.createdByDeviceId ?? null;
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
    // which source documents it came from. deviceName is the friendly label
    // from the device table (null for local writes / unknown ids).
    agent: f.createdByAgent ?? null,
    device: deviceId,
    deviceName: deviceId != null ? (deviceNames.get(Number(deviceId)) ?? null) : null,
    sourceDocumentIds: Array.isArray(f.sourceDocumentIds) ? f.sourceDocumentIds : [],
    sourceSection: f.sourceSection ?? null,
  };
}

// Resolve a --device filter value (numeric id OR device name) to the integer
// device.id used by the SQL predicate. Returns null when no filter / unresolved.
async function resolveDeviceFilter(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isInteger(n)) return n;
  // Non-numeric → treat as a device name and look up its id.
  try {
    const cortexDb = (await import('../../db/cortex.js')).default;
    const row = await cortexDb('device').where({ name: String(value) }).select('id').first();
    return row ? row.id : -1; // -1 = a name that matches no device → empty result, not "no filter"
  } catch {
    return null;
  }
}

// Batch-resolve device.id → device.name for the result set in one query.
async function resolveDeviceNames(facts) {
  const ids = [...new Set(
    facts
      .map((f) => f.createdByDeviceId)
      .filter((d) => d != null)
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d)),
  )];
  if (!ids.length) return new Map();
  try {
    const cortexDb = (await import('../../db/cortex.js')).default;
    const rows = await cortexDb('device').whereIn('id', ids).select('id', 'name');
    return new Map(rows.map((r) => [Number(r.id), r.name]));
  } catch {
    return new Map();
  }
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
