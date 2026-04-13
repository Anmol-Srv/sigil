import { z } from 'zod';

import { searchByName, listByType } from '../../memory/entities/store.js';
import { textResponse } from '../utils.js';

function registerSearchEntityTool(server) {
  server.tool(
    'search_entity',
    `Find entities in the knowledge graph by name or type.
Use for: "find Alice", "list all topics", "show all people", "find documents about normalization".
Entity types: document, person, topic (extensible per domain).
Returns compact entity list. Use get_entity_context(entityId) for full details.`,
    {
      query: z.string().optional().describe('Entity name to search (e.g. "Alice", "Cohort 6")'),
      entityType: z.string().optional().describe('Filter by type: session, course, person, topic'),
      limit: z.number().optional().default(10).describe('Max results'),
      namespace: z.string().optional().describe('Namespace. Omit for default.'),
    },
    async ({ query, entityType, limit, namespace }) => {
      if (!query && !entityType) {
        return textResponse('Error: Provide either a query (entity name) or entityType.');
      }

      const results = query
        ? await searchByName(query, { entityType, namespace, limit })
        : await listByType(entityType, { namespace, limit });

      if (!results.length) {
        const filter = query ? `matching "${query}"` : `of type "${entityType}"`;
        return textResponse(`No entities found ${filter}.`);
      }

      const lines = results.map((e) => {
        const desc = e.description ? ` — ${e.description}` : '';
        return `- **${e.name}** (${e.entityType}, id:${e.id}, ${e.mentionCount} mentions)${desc}`;
      });

      const header = query ? `Entities matching "${query}"` : `${entityType} entities`;

      return textResponse(`${header} (${results.length}):\n${lines.join('\n')}\n\n_Use get_entity_context(entityId=<id>) for details or traverse_graph(startEntityId=<id>) for connections._`);
    },
  );
}

export { registerSearchEntityTool };
