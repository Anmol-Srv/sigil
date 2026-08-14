/**
 * ingestDoc — ingest a resolved document (content, filePath, or URL).
 *
 * Distinct from `remember` (CLI), which only handles plain fact strings.
 *
 * `params.background` stages source bytes in the durable job table before it
 * acknowledges. The searchable document/fact commit and graph enrichment are
 * separate recoverable stages, so callers no longer sit through the full model
 * chain and a daemon restart cannot lose accepted work.
 */

import { createHash } from 'node:crypto';

// Serialization now lives in the shared daemon-wide write queue rather than a
// queue private to this handler. The private one only ordered background
// ingests against each OTHER — a foreground ingest, a `remember`, or a Stop
// hook's `ingestTurn` could still land mid-transaction and starve on PGlite's
// single connection. See src/daemon/write-queue.js.
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

async function stageIngestParams(params) {
  const { resolveSource } = await import('../../ingestion/resolve-source.js');
  const { maskSecrets } = await import('../../hooks/secret-mask.js');
  const source = await resolveSource({
    content: params.content,
    filePath: params.filePath,
    url: params.url,
    title: params.title,
    sourceType: params.sourceType,
    sourcePath: params.sourcePath,
    metadata: params.metadata,
  });
  if (!source) {
    const err = new Error('ingestDoc: provide content, filePath, or url');
    err.code = 'invalid_params';
    throw err;
  }
  return {
    ...params,
    // Durable jobs must not depend on a file or URL still existing later.
    content: maskSecrets(source.content),
    filePath: null,
    url: null,
    title: params.title || source.title,
    sourcePath: params.sourcePath || source.sourcePath,
    sourceType: params.sourceType || source.sourceType,
    contentType: params.contentType || source.contentType,
    metadata: params.metadata || source.metadata || {},
    background: false,
  };
}

async function doIngest(params) {
  const started = Date.now();
  const { ingestDocument } = await import('../../ingestion/pipeline.js');
  const staged = await stageIngestParams(params);
  const {
    title, namespace, sourceType, skipFacts, skipEntities, metadata, entities,
    cwd, sessionId,
  } = staged;

  const podUids = await resolveIngestPods({
    podUids: staged.podUids, cwd, sessionId, namespace,
  });

  const result = await ingestDocument({
    content: staged.content,
    title,
    sourcePath: staged.sourcePath,
    sourceType,
    contentType: staged.contentType,
    namespace,
    metadata,
    podUids,
    skipFacts,
    skipEntities,
    entities,
    force: staged.force === true,
  });

  const response = {
    skipped: Boolean(result.skipped),
    title: result.title ?? null,
    documentId: result.documentId ?? null,
    documentUid: result.documentUid ?? null,
    pods: podUids,
    chunkCount: result.chunkCount ?? 0,
    facts: result.facts ?? null,
    entities: result.entities || null,
    output: result.md?.url ?? null,
  };

  const f = response.facts || {};
  const { recordTrace } = await import('../trace-store.js');
  recordTrace({
    kind: 'ingest',
    summary: `ingest "${String(response.title || 'document').slice(0, 60)}" → ${response.chunkCount} chunks, +${f.added ?? 0} facts${response.skipped ? ' (skipped)' : ''}`,
    namespace: namespace || null,
    durationMs: Date.now() - started,
    detail: {
      op: 'ingestDoc',
      title: response.title,
      documentId: response.documentId,
      skipped: response.skipped,
      route: result.route ?? null,
      chunkCount: response.chunkCount,
      counts: { added: f.added ?? 0, updated: f.updated ?? 0, skipped: f.skipped ?? 0, contradicted: f.contradicted ?? 0, total: f.total ?? 0 },
      verdicts: f.verdicts || [],
      enrichment: response.entities?.queued ? response.entities : null,
      entities: response.entities && !response.entities.queued ? { entityCount: response.entities.entityCount, relationCount: response.entities.relationCount, topics: response.entities.topics || [] } : null,
      durationMs: Date.now() - started,
    },
  }).catch(() => {});

  return response;
}

export function registerIngestDoc(registry) {
  registry.register('ingestDoc', async (params) => {
    if (params.background) {
      const staged = await stageIngestParams(params);
      staged.podUids = await resolveIngestPods({
        podUids: staged.podUids,
        cwd: staged.cwd,
        sessionId: staged.sessionId,
        namespace: staged.namespace,
      });
      const { enqueueAndKick } = await import('../../ingestion/jobs/runner.js');
      const { default: config } = await import('../../config.js');
      const dedupeKey = `document-ingest:${createHash('sha256')
        .update(JSON.stringify(staged))
        .digest('hex')}`;
      const queued = await enqueueAndKick({
        kind: 'document-ingest',
        namespace: staged.namespace || config.defaults.namespace,
        dedupeKey,
        // The key covers the complete staged request. A collision is an exact
        // duplicate, so a running copy already includes all of its work.
        rerunIfRunning: false,
        maxAttempts: config.ingest.maxJobAttempts,
        payload: staged,
      });
      return {
        queued: true,
        durable: true,
        jobUid: queued.job.uid,
        title: staged.title || null,
        pods: staged.podUids,
      };
    }

    return doIngest(params);
  });
}

export { doIngest, stageIngestParams };
