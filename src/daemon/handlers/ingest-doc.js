/**
 * ingestDoc — ingest a resolved document (content, filePath, or URL).
 *
 * Distinct from `remember` (CLI), which only handles plain fact strings.
 *
 * Supports `params.background`: queue the ingest and return immediately. Graph-
 * building is LLM-heavy and can exceed the RPC timeout, so — like every graph-
 * memory system (Graphiti, GraphRAG, HippoRAG) — the write is made async and
 * the cleverness lives at read time. Both the background and foreground paths
 * run under the daemon-wide write lock so concurrent ingests don't race on
 * entity create/rename (the same invariant `remember` protects with sequential
 * processing) and don't starve each other on PGlite's single connection.
 */

// Serialization now lives in the shared daemon-wide write queue rather than a
// queue private to this handler. The private one only ordered background
// ingests against each OTHER — a foreground ingest, a `remember`, or a Stop
// hook's `ingestTurn` could still land mid-transaction and starve on PGlite's
// single connection. See src/daemon/write-queue.js.
import { withWriteLock } from '../write-queue.js';

/**
 * Which pod should this document attach to?
 *
 * One owner, and the project wins — the same rule facts follow, via the shared
 * dispatcher. Documents and the facts extracted from them must land in the SAME
 * pod, or `sigil docs` in a project would list documents whose facts live
 * somewhere else.
 *
 * This previously ensured the project pod and then unioned every active kind on
 * top, so each ingest attached the document to the project AND the session pod —
 * the duplication visible as a `claude_session …` pod mirroring the project's
 * contents. Explicit podUids still win and skip resolution entirely.
 */
async function resolveIngestPods({ podUids, cwd, sessionId, namespace }) {
  if (Array.isArray(podUids) && podUids.length) return podUids;
  if (!cwd && !sessionId) return [];

  try {
    const { ensureActivePodsForHook } = await import('../../memory/pods/hook-dispatcher.js');
    const { podUids: resolved } = await ensureActivePodsForHook({
      sessionId: sessionId || null,
      cwd: cwd || null,
      namespace: namespace || null,
    });
    return resolved || [];
  } catch {
    // Pod resolution is an enhancement: an unattached document is still stored
    // and still readable (scoped search treats no-pod as globally visible).
    return [];
  }
}

async function doIngest(params) {
  const { ingestDocument } = await import('../../ingestion/pipeline.js');
  const { resolveSource } = await import('../../ingestion/resolve-source.js');

  const { content, filePath, url, title, namespace, sourceType, skipFacts, skipEntities, metadata, cwd, sessionId, sourcePath } = params;
  // sourcePath must survive: it is the (source_path, namespace) upsert key. A
  // caller that read the file itself (the MCP tool — the daemon's cwd is `/`)
  // sends content + the real path; dropping it would mint a fresh `raw/<ts>`
  // path on every ingest and duplicate the document instead of updating it.
  const source = await resolveSource({ content, filePath, url, title, sourceType, sourcePath });
  if (!source) {
    const err = new Error('ingestDoc: provide content, filePath, or url');
    err.code = 'invalid_params';
    throw err;
  }

  const podUids = await resolveIngestPods({
    podUids: params.podUids, cwd, sessionId, namespace,
  });

  const result = await ingestDocument({
    content: source.content,
    title: title || source.title,
    sourcePath: source.sourcePath,
    sourceType: sourceType || source.sourceType,
    contentType: source.contentType,
    namespace,
    metadata: metadata || source.metadata,
    podUids,
    skipFacts,
    skipEntities,
  });

  const response = {
    skipped: Boolean(result.skipped),
    title: result.title ?? null,
    documentId: result.documentId ?? null,
    documentUid: result.documentUid ?? null,
    pods: podUids,
    chunkCount: result.chunkCount ?? 0,
    facts: result.facts ?? null,
    entities: result.entities ?? null,
    output: result.md?.url ?? null,
  };

  const f = response.facts || {};
  const { recordTrace } = await import('../trace-store.js');
  recordTrace({
    kind: 'ingest',
    summary: `ingest "${String(response.title || 'document').slice(0, 60)}" → ${response.chunkCount} chunks, +${f.added ?? 0} facts${response.skipped ? ' (skipped)' : ''}`,
    namespace: namespace || null,
    detail: {
      op: 'ingestDoc',
      title: response.title,
      documentId: response.documentId,
      skipped: response.skipped,
      route: result.route ?? null,
      chunkCount: response.chunkCount,
      counts: { added: f.added ?? 0, updated: f.updated ?? 0, skipped: f.skipped ?? 0, contradicted: f.contradicted ?? 0, total: f.total ?? 0 },
      verdicts: f.verdicts || [],
      entities: response.entities ? { entityCount: response.entities.entityCount, relationCount: response.entities.relationCount, topics: response.entities.topics || [] } : null,
    },
  }).catch(() => {});

  return response;
}

export function registerIngestDoc(registry) {
  registry.register('ingestDoc', async (params) => {
    if (params.background) {
      // Fire-and-forget: queue the work and return an ack immediately. Failures
      // can't propagate to a caller that already left, so log them where
      // `sigil doctor` will surface them.
      const { resolveSource } = await import('../../ingestion/resolve-source.js');
      const source = await resolveSource({
        content: params.content, filePath: params.filePath, url: params.url,
        title: params.title, sourceType: params.sourceType,
      }).catch(() => null);

      withWriteLock(() => doIngest(params)).catch(async (err) => {
        try {
          const { recordHookError } = await import('../../hooks/error-log.js');
          await recordHookError('ingestDoc', err, String(params.title || params.filePath || params.url || '').slice(0, 200));
        } catch { /* never let logging mask the failure */ }
      });

      return { queued: true, title: params.title || source?.title || null };
    }

    return withWriteLock(() => doIngest(params));
  });
}
