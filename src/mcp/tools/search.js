import { z } from 'zod';
import { groupBy, sortBy } from 'lodash-es';

import { daemonCall } from '../daemon-call.js';
import { textResponse, truncate, FACT_TRUNCATE } from '../utils.js';

function registerSearchTool(server) {
  server.tool(
    'search',
    `Search Sigil knowledge base for facts across all ingested documents.
Use for: "how does X work", "what is Y?", "what are the rules for Z", domain knowledge, decisions.
When called from a Git project, Sigil searches that project first and then the
shared local memory. Pass namespaces only when you intentionally need a custom
scope. Returns compact facts. Use get_fact_context(factId) for full detail on any fact.
Set includeChunks=true only when raw document context is needed.
Set format="compact" for token-efficient output (one line per category, no IDs/metadata).`,
    {
      query: z.string().min(1).max(8_000).describe('Natural language search query'),
      limit: z.number().int().min(1).max(100).optional().default(5).describe('Max facts to return (default 5)'),
      namespaces: z.array(z.string()).optional().describe('Override automatic project + shared-memory scope'),
      minConfidence: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('Minimum fact confidence'),
      includeChunks: z.boolean().optional().default(false).describe('Include raw document chunks (verbose — only when needed)'),
      pointInTime: z.string().optional().describe('ISO timestamp — return only facts valid at this point in time'),
      format: z.enum(['full', 'compact']).optional().default('full').describe('Output format: "full" (default) or "compact" (token-efficient, one line per category)'),
    },
    async ({ query, limit, namespaces, minConfidence, includeChunks, pointInTime, format }) => {
      const data = await daemonCall('search', {
        query,
        namespaces,
        limit,
        minConfidence,
        includeChunks,
        pointInTime,
      });

      const { facts, chunks } = data;

      if (format === 'compact') {
        return textResponse(formatCompact(facts));
      }

      const parts = [];

      if (facts.length) {
        parts.push(`**Facts (${facts.length}):**`);
        for (const f of facts) {
          const content = truncate(f.content, FACT_TRUNCATE);
          const vital = f.importance === 'vital' ? ' **[VITAL]**' : '';
          // Provenance: which agent wrote it + first source doc, if known.
          const via = f.agent ? ` · via ${f.agent}` : '';
          const doc = Array.isArray(f.sourceDocumentIds) && f.sourceDocumentIds.length ? ` · doc#${f.sourceDocumentIds[0]}` : '';
          parts.push(`- [${f.category}] ${content}${vital} _(${f.confidence}, id:${f.id}${via}${doc})_`);
        }
      }

      if (includeChunks && chunks.length) {
        parts.push('');
        parts.push(`**Chunks (${chunks.length}):**`);
        for (const c of chunks.slice(0, 3)) {
          const heading = c.sectionHeading ? `[${c.sectionHeading}] ` : '';
          parts.push(`---\n${heading}${truncate(c.content, 500)}`);
        }
      }

      if (!facts.length && !chunks.length) {
        parts.push('No results found. Try broader terms or include raw chunks.');
      }

      return textResponse(parts.join('\n'));
    },
  );
}

function formatCompact(facts) {
  const parts = [];
  if (!facts.length) {
    parts.push('No results.');
    return parts.join('\n');
  }
  const grouped = groupBy(facts, 'category');
  for (const [category, categoryFacts] of Object.entries(grouped)) {
    const sorted = sortBy(categoryFacts, (f) => (f.importance === 'vital' ? 0 : 1));
    const contents = sorted.map((f) => f.content);
    parts.push(`[${category}]: ${contents.join('. ')}`);
  }
  return parts.join('\n');
}

export { registerSearchTool };
