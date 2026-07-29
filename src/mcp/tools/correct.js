import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

export function registerCorrectTool(server) {
  server.tool(
    'correct',
    `Replace one active Sigil fact explicitly while preserving its history.
Use when: the user says an existing memory is outdated or wrong.
Pass the fact ID/UID returned by search or facts, plus the complete replacement statement.`,
    {
      id: z.string().min(1).describe('Numeric fact id, full UID, or unambiguous UID prefix'),
      content: z.string().min(1).describe('Complete replacement fact'),
    },
    async ({ id, content }) => {
      const result = await daemonCall('correctFact', { id, content });
      if (result.notFound) return textResponse(`No fact matches "${id}".`);
      if (result.unchanged) return textResponse(`Fact ${result.previous.uid} already has that content.`);
      return textResponse(
        `Corrected ${result.previous.uid} → ${result.replacement.uid}.\n`
        + `Previous: ${result.previous.content}\n`
        + `Current: ${result.replacement.content}`,
      );
    },
  );
}
