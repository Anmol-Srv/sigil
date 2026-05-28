import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse, truncate } from '../utils.js';

function registerStatusTool(server) {
  server.tool(
    'status',
    `Show Sigil knowledge base statistics — documents, chunks, facts, entities, relations.
Use when: checking system health, verifying ingestion, reviewing knowledge graph size.`,
    {
      namespace: z.string().optional().describe('Filter by namespace. Omit for global stats.'),
    },
    async ({ namespace }) => {
      const data = await daemonCall('status', { namespace, hotFactsLimit: 5 });
      const scope = data.namespace ? ` (${data.namespace})` : '';
      const text = [
        `Sigil KB${scope}: ${data.documents} docs, ${data.chunks} chunks, ${data.facts} facts`,
        `Entities: ${data.entities.documents} documents, ${data.entities.people} people, ${data.entities.topics} topics`,
        `Relations: ${data.relations}`,
        `Hot facts (top ${data.hotFacts.length}): ${data.hotFacts.map((f) => `${truncate(f.content, 60)} (${f.accessCount}x)`).join(', ') || 'none yet'}`,
      ].join('\n');
      return textResponse(text);
    },
  );
}

export { registerStatusTool };
