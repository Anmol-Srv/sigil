import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

/**
 * The on-demand document surface.
 *
 * `search` finds things and returns pointers; these two move whole documents,
 * and only when the agent decides it needs one. Keeping them separate is what
 * lets a project accumulate large documents without every recall dragging them
 * into context.
 */
function registerDocumentTools(server) {
  server.tool(
    'list_documents',
    `List whole documents stored in Sigil, scoped to the current project by default.
Returns titles and uids only — call get_document to read one.
Use when: the user asks what documents/notes/specs are saved, or you need to find the right document before reading it.`,
    {
      cwd: z.string().optional().describe('Working directory — scopes to that project\'s pod. Pass the project you are working in.'),
      podScope: z.union([z.literal('auto'), z.literal('global'), z.array(z.string())]).optional()
        .describe("'auto' (default) = this project/session. 'global' = every document. Or an explicit list of pod uids/names."),
      sourceType: z.string().optional().describe('Filter by source type (e.g. docs, notes, code).'),
      limit: z.number().optional().describe('Max documents to return (default 50).'),
    },
    async ({ cwd, podScope, sourceType, limit }) => {
      const r = await daemonCall('listDocuments', { cwd, podScope, sourceType, limit });
      if (!r.documents.length) {
        return textResponse(
          r.scoped
            ? 'No documents stored for this project yet. Ingest one with the `ingest` tool.'
            : 'No documents stored yet. Ingest one with the `ingest` tool.',
        );
      }
      const lines = r.documents.map(
        (d) => `- ${d.title}  [${d.uid}]  ${d.sourceType} · ${d.chunkCount} chunks, ${d.factCount} facts`,
      );
      return textResponse([
        `${r.documents.length} document${r.documents.length === 1 ? '' : 's'}${r.scoped ? ' in this project' : ''}:`,
        ...lines,
        '',
        'Read one with get_document(uid).',
      ].join('\n'));
    },
  );

  server.tool(
    'get_document',
    `Read a stored document IN FULL by its uid (from list_documents or a search result's source document).
Use when: you need the complete text of a spec, note, session history, or file — not just the facts extracted from it.`,
    {
      uid: z.string().describe('Document uid, e.g. doc-a1b2c3... — from list_documents or a search result.'),
      maxChars: z.number().optional().describe('Truncate the returned text at this many characters (default 40000).'),
    },
    async ({ uid, maxChars }) => {
      const d = await daemonCall('getDocument', { uid, maxChars });
      if (d.notFound) return textResponse(`No document with uid "${uid}". Run list_documents to see what is stored.`);

      const header = [
        `# ${d.title}`,
        `uid: ${d.uid} · ${d.sourceType} · ${d.chunkCount} chunks`,
        d.pods?.length ? `pods: ${d.pods.map((p) => p.name || p.uid).join(', ')}` : null,
        // Pre-migration documents have no stored content and are rebuilt from
        // overlapping chunks — say so rather than passing off an approximation
        // as the source text.
        d.exact ? null : 'note: reassembled from chunks (ingested before full text was stored) — re-ingest for exact text',
        d.truncated ? `note: truncated at ${d.content.length} of ${d.totalChars} chars` : null,
      ].filter(Boolean).join('\n');

      return textResponse(`${header}\n\n---\n\n${d.content}`);
    },
  );
}

export { registerDocumentTools };
