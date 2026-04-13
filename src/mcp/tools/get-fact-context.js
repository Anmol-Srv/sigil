import { z } from 'zod';

import cortexDb from '../../db/cortex.js';
import { findByUid } from '../../memory/facts/store.js';
import { getEntitiesForFact } from '../../memory/facts/entity-linker.js';
import { getRelationsByFact } from '../../memory/entities/relations.js';
import { textResponse } from '../utils.js';

function registerGetFactContextTool(server) {
  server.tool(
    'get_fact_context',
    `Get full context for a specific fact: complete content, entities mentioned, relations created, sources.
Use for: drilling down on a fact from search results, checking provenance, understanding connections.
This is the detail view — search returns truncated facts, this returns everything.`,
    {
      factId: z.number().optional().describe('Fact ID (from search results)'),
      uid: z.string().optional().describe('Fact UID (e.g. "fact-a1b2c3d4")'),
    },
    async ({ uid, factId }) => {
      if (!uid && !factId) {
        return textResponse('Error: Provide either factId or uid.');
      }

      let fact;
      if (uid) {
        fact = await findByUid(uid);
      } else {
        fact = await cortexDb('fact').where({ id: factId }).first();
      }

      if (!fact) {
        return textResponse('Error: Fact not found.');
      }

      const [entities, relations, documents] = await Promise.all([
        getEntitiesForFact(fact.id),
        getRelationsByFact(fact.id),
        fact.sourceDocumentIds?.length
          ? cortexDb('document').whereIn('id', fact.sourceDocumentIds).select('id', 'title', 'sourceType')
          : [],
      ]);

      const parts = [
        `**Fact ${fact.uid}** (${fact.category}, ${fact.confidence}, ${fact.status})`,
        fact.content,
      ];

      if (fact.sourceSection) {
        parts.push(`Source section: ${fact.sourceSection}`);
      }

      if (entities.length) {
        parts.push(`\nEntities mentioned: ${entities.map((e) => `${e.name} (${e.entityType}, id:${e.id})`).join(', ')}`);
      }

      if (relations.length) {
        parts.push('\nRelations from this fact:');
        for (const r of relations) {
          parts.push(`- ${r.sourceName} --[${r.relationType}]--> ${r.targetName}`);
        }
      }

      if (documents.length) {
        parts.push(`\nSources: ${documents.map((d) => `${d.title} (${d.sourceType})`).join(', ')}`);
      }

      return textResponse(parts.join('\n'));
    },
  );
}

export { registerGetFactContextTool };
