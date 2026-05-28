/**
 * ingestDoc — ingest a resolved document (content, filePath, or URL).
 *
 * Distinct from `remember` (CLI), which only handles plain fact strings.
 */
export function registerIngestDoc(registry) {
  registry.register('ingestDoc', async (params) => {
    const { ingestDocument } = await import('../../ingestion/pipeline.js');
    const { resolveSource } = await import('../../ingestion/resolve-source.js');

    const { content, filePath, url, title, namespace, sourceType, skipFacts, skipEntities, metadata } = params;
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
      namespace,
      metadata: metadata || source.metadata,
      skipFacts,
      skipEntities,
    });

    return {
      skipped: Boolean(result.skipped),
      title: result.title ?? null,
      documentId: result.documentId ?? null,
      chunkCount: result.chunkCount ?? 0,
      facts: result.facts ?? null,
      entities: result.entities ?? null,
      output: result.md?.url ?? null,
    };
  });
}
