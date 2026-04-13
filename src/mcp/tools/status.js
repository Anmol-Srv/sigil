import { z } from 'zod';

import { getStats } from '../../memory/documents/store.js';
import { getEntityCount } from '../../memory/entities/store.js';
import { getRelationCount } from '../../memory/entities/relations.js';
import { getFactCount, getHotFacts } from '../../memory/facts/store.js';
import { textResponse, truncate } from '../utils.js';

function registerStatusTool(server) {
  server.tool(
    'status',
    `Show Cortex knowledge base statistics — documents, chunks, facts, entities, relations.
Use when: checking system health, verifying ingestion, reviewing knowledge graph size.`,
    {
      namespace: z.string().optional().describe('Filter by namespace. Omit for global stats.'),
    },
    async ({ namespace }) => {
      const [docStats, factCount, documents, people, topics, relations, hotFacts] = await Promise.all([
        getStats(namespace),
        getFactCount(namespace),
        getEntityCount('document'),
        getEntityCount('person'),
        getEntityCount('topic'),
        getRelationCount(),
        getHotFacts(namespace, { limit: 5 }),
      ]);

      const scope = namespace ? ` (${namespace})` : '';
      const text = [
        `Cortex KB${scope}: ${docStats.documentCount} docs, ${docStats.totalChunks} chunks, ${factCount} facts`,
        `Entities: ${documents} documents, ${people} people, ${topics} topics`,
        `Relations: ${relations}`,
        `Hot facts (top ${hotFacts.length}): ${hotFacts.map((f) => `${truncate(f.content, 60)} (${f.accessCount}x)`).join(', ') || 'none yet'}`,
      ].join('\n');

      return textResponse(text);
    },
  );
}

export { registerStatusTool };
