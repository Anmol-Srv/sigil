import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';
import { MAX_ATOMIC_FACT_CHARS, MAX_FACTS_PER_REQUEST, MAX_NAMESPACE_CHARS } from '../../lib/constants.js';

function registerRememberTool(server) {
  server.tool(
    'remember',
`Save one or more standalone facts to the Sigil knowledge base.
Each fact is masked, embedded, deterministically deduped, and stored.
Use when: the user states a durable preference, decision, constraint, or factual claim worth recalling later.
Pass each distinct fact as its own array element — don't concatenate unrelated facts into one string.
Use the correct tool when replacing an outdated fact; Sigil never guesses corrections.
Facts retain their writing-agent provenance and survive across sessions. In a
Git project they are saved to that project; outside one they use shared local
memory.`,
    {
      facts: z.array(z.string().min(1).max(MAX_ATOMIC_FACT_CHARS)).min(1).max(MAX_FACTS_PER_REQUEST)
        .describe('One or more self-contained facts to remember. Each element is a separate fact.'),
      namespace: z.string().min(1).max(MAX_NAMESPACE_CHARS).optional()
        .describe('Target namespace. Overrides automatic project/shared scope.'),
    },
    async ({ facts, namespace }) => {
      const data = await daemonCall('remember', { facts, namespace });

      const parts = [];
      if (data.added)        parts.push(`${data.added} new`);
      if (data.alreadyKnown) parts.push(`${data.alreadyKnown} already known`);
      const summary = parts.length ? parts.join(', ') : 'nothing stored';

      return textResponse(`Remembered ${facts.length} input${facts.length === 1 ? '' : 's'} → ${summary} (namespace: ${data.namespace}).`);
    },
  );
}

export { registerRememberTool };
