import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

function registerIngestTool(server) {
  server.tool(
    'ingest',
    `Ingest a document into the Sigil knowledge base. Accepts raw content, a file path, or a URL.
Parses the content, chunks it, embeds it, extracts facts, links entities, and stores everything for search.
Use when: adding documents to the knowledge base, ingesting files, URLs, or raw text.`,
    {
      content: z.string().optional().describe('Raw text content to ingest. Provide this OR filePath OR url.'),
      filePath: z.string().optional().describe('Local file path to ingest. Provide this OR content OR url.'),
      url: z.string().optional().describe('URL to fetch and ingest. Provide this OR content OR filePath.'),
      title: z.string().optional().describe('Document title. Auto-detected if not provided.'),
      namespace: z.string().optional().describe('Namespace for the document. Defaults to config default.'),
      sourceType: z.string().optional().describe('Source type label (e.g., docs, code, notes). Auto-detected from format.'),
      cwd: z.string().optional().describe('Working directory — attaches the document to that project\'s pod so it is findable from that project later. Pass the project you are working in.'),
      skipFacts: z.boolean().optional().default(false).describe('Skip fact extraction (faster, chunks only)'),
      skipEntities: z.boolean().optional().default(false).describe('Skip entity linking'),
    },
    async ({ content, filePath, url, title, namespace, sourceType, cwd, skipFacts, skipEntities }) => {
      // Read the file HERE, not in the daemon. `ingestDoc` runs inside sigild,
      // whose cwd is `/` — a relative path like ./NOTES.md resolved to /NOTES.md
      // and failed, and the daemon's traversal guard (`startsWith(cwd)`) is
      // vacuous when cwd is `/`. The MCP server runs in the client's context, so
      // it is the right place to resolve a path the client gave us. Matches what
      // `sigil ingest` already does CLI-side.
      let payload = { content, filePath, url };
      if (filePath) {
        const { readSource } = await import('../../ingestion/sources/file.js');
        const { resolve } = await import('node:path');
        const src = await readSource(resolve(cwd || process.cwd(), filePath));
        payload = { content: src.content, sourcePath: src.sourcePath };
        title = title || src.title;
        sourceType = sourceType || src.sourceType;
      }

      const result = await daemonCall('ingestDoc', { ...payload, title, namespace, sourceType, cwd, skipFacts, skipEntities });

      const text = result.skipped
        ? `Document "${result.title}" already up to date — skipped.`
        : [
            `Document "${result.title}" ingested.`,
            `- Document ID: ${result.documentUid || result.documentId} (read it back with get_document)`,
            result.pods?.length ? `- Pods: ${result.pods.join(', ')}` : null,
            `- Chunks: ${result.chunkCount}`,
            result.facts ? `- Facts: ${result.facts.total} extracted (${result.facts.added} new, ${result.facts.skipped} skipped)` : '- Facts: skipped',
            result.entities ? `- Entities: ${result.entities.entityCount}, Relations: ${result.entities.relationCount}` : '- Entities: skipped',
            result.output ? `- Output: ${result.output}` : '',
          ].filter(Boolean).join('\n');

      return textResponse(text);
    },
  );
}

export { registerIngestTool };
