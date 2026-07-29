/**
 * ingestDoc — ingest a resolved document (content, filePath, or URL).
 *
 * Distinct from `remember` (CLI), which only handles plain fact strings.
 *
 * Synchronous so the caller gets a truthful success or failure. The daemon
 * serializes embedded-database writes; it does not maintain a second in-memory
 * job queue whose work could be lost on shutdown.
 */

async function doIngest(params, ctx = {}) {
  const { ingestDocument } = await import('../../ingestion/pipeline.js');
  const { resolveSource } = await import('../../ingestion/resolve-source.js');

  const {
    content, filePath, url, title, sourceType,
    skipFacts, extractFacts, metadata,
  } = params;
  const { resolveMemoryScope } = await import('../memory-scope.js');
  const memoryScope = resolveMemoryScope(params, ctx);
  const resolvedNamespace = memoryScope.writeNamespace;
  const source = await resolveSource({ content, filePath, url, title, sourceType });
  if (!source) {
    const err = new Error('ingestDoc: provide content, filePath, or url');
    err.code = 'invalid_params';
    throw err;
  }

  const result = await ingestDocument({
    content: source.content,
    title: title || source.title,
    sourcePath: source.sourcePath,
    sourceType: sourceType || source.sourceType,
    contentType: source.contentType,
    namespace: resolvedNamespace,
    metadata: metadata || source.metadata,
    skipFacts,
    extractFacts,
  });

  const response = {
    skipped: Boolean(result.skipped),
    title: result.title ?? null,
    documentId: result.documentId ?? null,
    chunkCount: result.chunkCount ?? 0,
    facts: result.facts ?? null,
    output: result.md?.url ?? null,
  };

  const f = response.facts || {};
  const { recordTrace } = await import('../trace-store.js');
  recordTrace({
    kind: 'ingest',
    summary: `ingest "${String(response.title || 'document').slice(0, 60)}" → ${response.chunkCount} chunks, +${f.added ?? 0} facts${response.skipped ? ' (skipped)' : ''}`,
    namespace: resolvedNamespace,
    detail: {
      op: 'ingestDoc',
      title: response.title,
      documentId: response.documentId,
      skipped: response.skipped,
      route: result.route ?? null,
      chunkCount: response.chunkCount,
      counts: { added: f.added ?? 0, skipped: f.skipped ?? 0, total: f.total ?? 0 },
      verdicts: f.verdicts || [],
    },
  }).catch(() => {});

  return response;
}

export function registerIngestDoc(registry) {
  registry.register('ingestDoc', async (params, ctx) => doIngest(params, ctx));
}
