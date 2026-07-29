import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

function registerGetFactContextTool(server) {
  server.tool(
    'get_fact_context',
    `Get full context for a specific fact: complete content and source documents.
Use for drilling down on a fact from search results or checking provenance.
This is the detail view — search returns truncated facts, this returns everything.`,
    {
      factId: z.number().optional().describe('Fact ID (from search results)'),
      uid: z.string().optional().describe('Fact UID (e.g. "fact-a1b2c3d4")'),
    },
    async ({ uid, factId }) => {
      if (!uid && !factId) return textResponse('Error: Provide either factId or uid.');

      const data = await daemonCall('getFactContext', { uid, factId });
      if (data.notFound) return textResponse('Error: Fact not found.');

      const { fact, documents } = data;
      const parts = [
        `**Fact ${fact.uid}** (${fact.category}, ${fact.confidence}, ${fact.status})`,
        fact.content,
      ];
      if (fact.sourceSection) parts.push(`Source section: ${fact.sourceSection}`);
      if (documents.length) {
        parts.push(`\nSources: ${documents.map((d) => `${d.title} (${d.sourceType})`).join(', ')}`);
      }
      return textResponse(parts.join('\n'));
    },
  );
}

export { registerGetFactContextTool };
