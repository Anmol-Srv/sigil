import { z } from 'zod';

import { findById, searchByName } from '../../memory/entities/store.js';
import { listRelationsForEntity } from '../../memory/entities/relations.js';
import { getFactsForEntity } from '../../memory/facts/entity-linker.js';
import { textResponse, truncate, FACT_TRUNCATE } from '../utils.js';

function registerGetEntityContextTool(server) {
  server.tool(
    'get_entity_context',
    `Get full context for an entity: relations, connected facts, graph position.
Use for: "tell me about Alice", "what documents cover this topic?", "show expertise areas".
Returns entity details + relations + key facts (truncated — use get_fact_context for full text).`,
    {
      entityId: z.number().optional().describe('Entity ID (from search_entity or search results)'),
      name: z.string().optional().describe('Entity name (alternative to ID)'),
      namespace: z.string().optional().describe('Namespace. Omit for default.'),
    },
    async ({ entityId, name, namespace }) => {
      if (!entityId && !name) {
        return textResponse('Error: Provide either entityId or name.');
      }

      let entity;
      if (entityId) {
        entity = await findById(entityId);
      } else {
        const results = await searchByName(name, { namespace, limit: 1 });
        entity = results[0];
      }

      if (!entity) {
        return textResponse('Error: Entity not found.');
      }

      const [relations, facts] = await Promise.all([
        listRelationsForEntity(entity.id, { limit: 30 }),
        getFactsForEntity(entity.id, { limit: 10 }),
      ]);

      const parts = [
        `**${entity.name}** (${entity.entityType}, id:${entity.id}, ${entity.mentionCount} mentions)`,
      ];

      if (entity.description) {
        parts.push(entity.description);
      }

      const outgoing = relations.filter((r) => r.direction === 'outgoing');
      const incoming = relations.filter((r) => r.direction === 'incoming');

      if (outgoing.length) {
        parts.push(`\nOutgoing relations (${outgoing.length}):`);
        for (const r of outgoing.slice(0, 15)) {
          parts.push(`- [${r.relationType}] ${r.name} (${r.entityType}, id:${r.entityId})`);
        }
        if (outgoing.length > 15) parts.push(`  ...and ${outgoing.length - 15} more`);
      }

      if (incoming.length) {
        parts.push(`\nIncoming relations (${incoming.length}):`);
        for (const r of incoming.slice(0, 15)) {
          parts.push(`- ${r.name} (${r.entityType}, id:${r.entityId}) [${r.relationType}]`);
        }
        if (incoming.length > 15) parts.push(`  ...and ${incoming.length - 15} more`);
      }

      if (facts.length) {
        parts.push(`\nKey facts (${facts.length}):`);
        for (const f of facts) {
          const content = truncate(f.content, FACT_TRUNCATE);
          parts.push(`- [${f.category}] ${content} _(${f.confidence}, id:${f.id})_`);
        }
      }

      if (!outgoing.length && !incoming.length && !facts.length) {
        parts.push('\nNo connections or facts found for this entity.');
      }

      parts.push(`\n_Use traverse_graph(startEntityId=${entity.id}) for deeper graph exploration._`);

      return textResponse(parts.join('\n'));
    },
  );
}

export { registerGetEntityContextTool };
