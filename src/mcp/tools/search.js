import { z } from 'zod';
import { groupBy, sortBy } from 'lodash-es';

import { search } from '../../memory/search/hybrid.js';
import config from '../../config.js';
import { textResponse, truncate, FACT_TRUNCATE } from '../utils.js';

function registerSearchTool(server) {
  server.tool(
    'search',
    `Search Sigil knowledge base for facts across all ingested documents.
Automatically detects entity names and returns entity-centric results.
Use for: "how does X work", "what is Y?", "what are the rules for Z", domain knowledge, decisions.
Returns compact facts. Use get_fact_context(factId) for full detail on any fact.
Set includeChunks=true only when raw document context is needed.
Set format="compact" for token-efficient output (one line per category, no IDs/metadata).`,
    {
      query: z.string().describe('Natural language search query'),
      limit: z.number().optional().default(5).describe('Max facts to return (default 5)'),
      namespaces: z.array(z.string()).optional().describe('Filter by namespaces'),
      minConfidence: z.enum(['low', 'medium', 'high']).optional().default('medium').describe('Minimum fact confidence'),
      includeChunks: z.boolean().optional().default(false).describe('Include raw document chunks (verbose — only when needed)'),
      useGraph: z.boolean().optional().default(false).describe('Traverse entity graph for additional related facts'),
      pointInTime: z.string().optional().describe('ISO timestamp — return only facts valid at this point in time'),
      format: z.enum(['full', 'compact']).optional().default('full').describe('Output format: "full" (default) or "compact" (token-efficient, one line per category)'),
      podScope: z.union([
        z.literal('auto'),
        z.literal('global'),
        z.array(z.string()),
      ]).optional().describe('Pod scope: "auto" (uses active session/project/person pods), "global" (no filter), or list of pod uids/names. Default: "global".'),
    },
    async ({ query, limit, namespaces, minConfidence, includeChunks, useGraph, pointInTime, format, podScope }) => {
      const ns = namespaces?.length ? namespaces : [config.defaults.namespace];
      const pit = pointInTime ? new Date(pointInTime) : undefined;

      const { facts, chunks, matchedEntity, relatedEntities } = await search(query, {
        namespaces: ns,
        limit,
        minConfidence,
        includeChunks,
        useGraph,
        pointInTime: pit,
        podScope: podScope ?? null,
        route: false,
        synthesize: false,
      });

      if (format === 'compact') {
        return textResponse(formatCompact(facts, matchedEntity));
      }

      const parts = [];

      if (matchedEntity) {
        parts.push(`**Matched entity:** ${matchedEntity.name} (${matchedEntity.type}, id:${matchedEntity.id}, ${matchedEntity.mentions} mentions)`);
        if (matchedEntity.description) {
          parts.push(matchedEntity.description);
        }
        parts.push('');
      }

      if (facts.length) {
        parts.push(`**Facts (${facts.length}):**`);
        for (const f of facts) {
          const content = truncate(f.content, FACT_TRUNCATE);
          const vital = f.importance === 'vital' ? ' **[VITAL]**' : '';
          parts.push(`- [${f.category}] ${content}${vital} _(${f.confidence}, id:${f.id})_`);
        }
      }

      if (relatedEntities.length) {
        parts.push('');
        parts.push(`**Related entities (${relatedEntities.length}):**`);
        for (const e of relatedEntities.slice(0, 10)) {
          parts.push(`- ${e.name} (${e.type}) [${e.relation}] id:${e.id}`);
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
        parts.push('No results found. Try broader terms or use search_entity to find entity names.');
      }

      if (matchedEntity) {
        parts.push(`\n_Drill down: get_entity_context(entityId=${matchedEntity.id}) for full details about ${matchedEntity.name}_`);
      }

      return textResponse(parts.join('\n'));
    },
  );
}

function formatCompact(facts, matchedEntity) {
  const parts = [];

  if (matchedEntity) {
    parts.push(`> ${matchedEntity.name} (${matchedEntity.type})`);
  }

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
