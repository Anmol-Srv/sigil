/**
 * getDocument / listDocuments — the on-demand whole-document read path.
 *
 * Sigil could ingest a document and never hand it back. Chunks surfaced in
 * search, facts extracted from it surfaced in recall, but there was no way to
 * ask for the source text again — no RPC, no MCP tool. These two close that.
 *
 * The split is deliberate and is what keeps the search flow intact: `search`
 * stays the discovery surface and returns POINTERS (a fact carries the title +
 * uid of the document it came from), and `getDocument` is the only thing that
 * ever moves a full document. Nothing pays for a document's bytes until
 * something explicitly asks, so the auto-injection budget is untouched.
 */

// A whole document can be enormous, and an MCP tool result lands directly in an
// agent's context. Cap by default and report the truncation rather than
// silently blowing the caller's window; explicit callers can raise it.
const DEFAULT_MAX_CHARS = 40_000;

export function registerGetDocument(registry) {
  registry.register('getDocument', async (params = {}) => {
    const { uid, documentId, maxChars } = params;
    if (!uid && !Number.isFinite(documentId)) {
      const err = new Error('getDocument: provide uid or documentId');
      err.code = 'invalid_params';
      throw err;
    }

    const store = await import('../../memory/documents/store.js');
    const doc = await store.getDocument({
      uid,
      id: documentId,
      maxChars: maxChars === null ? null : (Number.isFinite(maxChars) ? maxChars : DEFAULT_MAX_CHARS),
    });
    if (!doc) return { notFound: true };

    return { ...doc, pods: await store.podsForDocument(doc.id) };
  });

  registry.register('listDocuments', async (params = {}) => {
    const { default: config } = await import('../../config.js');
    const store = await import('../../memory/documents/store.js');

    const namespace = params.namespace || config.defaults.namespace;
    // Same scoping vocabulary as `search`: 'auto' means the pods active for
    // this cwd/session, so "which docs belong to this project" is one call and
    // resolves to exactly the pods a search here would read from.
    const podScope = params.podScope ?? 'auto';
    const podIds = await resolvePodIds(podScope, {
      cwd: params.cwd || null, sessionId: params.sessionId || null, namespace,
    });

    const docs = await store.listDocuments({
      namespace,
      sourceType: params.sourceType,
      limit: Number.isFinite(params.limit) ? params.limit : 50,
      podIds,
    });

    return {
      namespace,
      scoped: Array.isArray(podIds),
      documents: docs.map((d) => ({
        uid: d.uid,
        id: d.id,
        title: d.title,
        sourceType: d.sourceType,
        sourcePath: d.sourcePath,
        chunkCount: d.chunkCount ?? 0,
        factCount: d.factCount ?? 0,
        lastIngestedAt: d.lastIngestedAt ?? null,
      })),
    };
  });
}

/**
 * Pod ids for a scope. Mirrors search's resolvePodScope: null/'global' means
 * unscoped, 'auto' resolves the active pods, an array is uids/names/ids.
 * Returns null (no filter) or an array (possibly empty → match nothing).
 */
async function resolvePodIds(podScope, ctx) {
  if (podScope == null || podScope === 'global') return null;

  const { default: cortexDb } = await import('../../db/cortex.js');

  if (podScope === 'auto') {
    // Side-effect import: the registry is EMPTY until the built-in kinds
    // register themselves, and activeKinds() over an empty registry returns []
    // — which reads as "this project has no documents" rather than as a missing
    // import. hybrid.js carries the same import for the same reason.
    await import('../../memory/pods/kinds/index.js');
    const { activeKinds } = await import('../../memory/pods/registry.js');
    const active = await activeKinds(ctx);
    const uids = active
      .flatMap((a) => a.scope)
      .filter((u) => typeof u === 'string' && !u.startsWith('__virtual:'));
    if (!uids.length) return [];
    const rows = await cortexDb('pod').whereIn('uid', uids).select('id');
    return rows.map((r) => r.id);
  }

  if (Array.isArray(podScope)) {
    if (!podScope.length) return [];
    if (podScope.every((x) => typeof x === 'number')) return podScope;
    const strings = podScope.filter((x) => typeof x === 'string');
    if (!strings.length) return [];
    const rows = await cortexDb('pod')
      .where(function () { this.whereIn('uid', strings).orWhereIn('name', strings); })
      .select('id');
    return rows.map((r) => r.id);
  }

  return null;
}
