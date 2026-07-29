import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

function registerIngestTool(server) {
  server.tool(
    'ingest',
    `Ingest a document into the Sigil knowledge base. Accepts raw content, a file path, or a URL.
By default it deterministically parses, chunks, embeds, and stores the document for search.
Fact extraction is an optional generation feature.
Use when: adding documents to the knowledge base, ingesting files, URLs, or raw text.`,
    {
      content: z.string().optional().describe('Raw text content to ingest. Provide this OR filePath OR url.'),
      filePath: z.string().optional().describe('Local file path to ingest. Provide this OR content OR url.'),
      url: z.string().optional().describe('URL to fetch and ingest. Provide this OR content OR filePath.'),
      title: z.string().optional().describe('Document title. Auto-detected if not provided.'),
      namespace: z.string().optional().describe('Namespace for the document. Overrides automatic project/shared scope.'),
      sourceType: z.string().optional().describe('Source type label (e.g., docs, code, notes). Auto-detected from format.'),
      extractFacts: z.boolean().optional().default(false).describe('Opt in to LLM fact extraction'),
    },
    async ({ content, filePath, url, title, namespace, sourceType, extractFacts }) => {
      const result = await daemonCall('ingestDoc', {
        content, filePath, url, title, namespace, sourceType,
        extractFacts,
      });

      const text = result.skipped
        ? `Document "${result.title}" already up to date — skipped.`
        : [
            `Document "${result.title}" ingested.`,
            `- Document ID: ${result.documentId}`,
            `- Chunks: ${result.chunkCount}`,
            result.facts?.total ? `- Facts: ${result.facts.total} extracted (${result.facts.added} new, ${result.facts.skipped} skipped)` : '- Fact extraction: off',
            result.output ? `- Output: ${result.output}` : '',
          ].filter(Boolean).join('\n');

      return textResponse(text);
    },
  );
}

export { registerIngestTool };
