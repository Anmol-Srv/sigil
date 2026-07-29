import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

function registerStatusTool(server) {
  server.tool(
    'status',
    `Show Sigil knowledge base statistics — documents, chunks, and facts.
Use when checking system health or verifying ingestion.`,
    {
      namespace: z.string().optional().describe('Filter by namespace. Omit for global stats.'),
    },
    async ({ namespace }) => {
      const data = await daemonCall('status', { namespace });
      const scope = data.namespace ? ` (${data.namespace})` : '';
      const text = [
        `Sigil KB${scope}: ${data.documents} docs, ${data.chunks} chunks, ${data.facts} facts`,
      ].join('\n');
      return textResponse(text);
    },
  );
}

export { registerStatusTool };
