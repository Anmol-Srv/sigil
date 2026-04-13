import { z } from 'zod';

import { ingestDocument } from '../../ingestion/pipeline.js';
import { resolveSource } from '../../ingestion/resolve-source.js';
import { textResponse } from '../utils.js';

function registerIngestTool(server) {
  server.tool(
    'ingest',
    `Ingest a document into the Cortex knowledge base. Accepts raw content, a file path, or a URL.
Parses the content, chunks it, embeds it, extracts facts, links entities, and stores everything for search.
Use when: adding documents to the knowledge base, ingesting files, URLs, or raw text.`,
    {
      content: z.string().optional().describe('Raw text content to ingest. Provide this OR filePath OR url.'),
      filePath: z.string().optional().describe('Local file path to ingest. Provide this OR content OR url.'),
      url: z.string().optional().describe('URL to fetch and ingest. Provide this OR content OR filePath.'),
      title: z.string().optional().describe('Document title. Auto-detected if not provided.'),
      namespace: z.string().optional().describe('Namespace for the document. Defaults to config default.'),
      sourceType: z.string().optional().describe('Source type label (e.g., docs, code, notes). Auto-detected from format.'),
      skipFacts: z.boolean().optional().default(false).describe('Skip fact extraction (faster, chunks only)'),
      skipEntities: z.boolean().optional().default(false).describe('Skip entity linking'),
    },
    async ({ content, filePath, url, title, namespace, sourceType, skipFacts, skipEntities }) => {
      const source = await resolveSource({ content, filePath, url, title, sourceType });
      if (!source) {
        return textResponse('Error: provide content, filePath, or url.');
      }

      const result = await ingestDocument({
        content: source.content,
        title: title || source.title,
        sourcePath: source.sourcePath,
        sourceType: sourceType || source.sourceType,
        contentType: source.contentType,
        namespace,
        metadata: source.metadata,
        skipFacts,
        skipEntities,
      });

      const text = result.skipped
        ? `Document "${result.title}" already up to date — skipped.`
        : [
            `Document "${result.title}" ingested.`,
            `- Document ID: ${result.documentId}`,
            `- Chunks: ${result.chunkCount}`,
            result.facts ? `- Facts: ${result.facts.total} extracted (${result.facts.added} new, ${result.facts.skipped} skipped)` : '- Facts: skipped',
            result.entities ? `- Entities: ${result.entities.entityCount}, Relations: ${result.entities.relationCount}` : '- Entities: skipped',
            result.md ? `- Output: ${result.md.url}` : '',
          ].filter(Boolean).join('\n');

      return textResponse(text);
    },
  );
}

export { registerIngestTool };
