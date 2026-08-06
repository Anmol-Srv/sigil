import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

// Writes legitimately outlast a read budget (classify → extract → AUDM → link).
const WRITE_RPC_TIMEOUT_MS = 10 * 60 * 1000;

function registerRememberTool(server) {
  server.tool(
    'remember',
    `Save one or more standalone facts to the Sigil knowledge base.
Each fact is classified, embedded, deduped against existing memory, and stored.
Use when: the user states a durable preference, decision, constraint, or factual claim worth recalling later.
Pass each distinct fact as its own array element — don't concatenate unrelated facts into one string.
Facts are written under the agent provenance "mcp" and survive across sessions.
Pass cwd so the fact attaches to that project and resurfaces there; pass pod when the fact is ABOUT a different project than the one you're in.`,
    {
      facts: z.array(z.string()).min(1).describe('One or more self-contained facts to remember. Each element is a separate fact.'),
      namespace: z.string().optional().describe('Target namespace. Defaults to the config default namespace.'),
      cwd: z.string().optional().describe("Working directory — attaches the facts to that project's pod so they resurface there. Pass the project you are working in."),
      pod: z.string().optional().describe('Attach to this pod (name or uid) INSTEAD of the one derived from cwd. Use when the fact is about a different project than the one you are working in.'),
    },
    async ({ facts, namespace, cwd, pod }) => {
      // Saves run a chain of LLM calls; a read-sized budget would report
      // failure on a write the daemon is still completing.
      const data = await daemonCall('remember', { facts, namespace, cwd, pod }, { timeoutMs: WRITE_RPC_TIMEOUT_MS });

      const parts = [];
      if (data.added)        parts.push(`${data.added} new`);
      if (data.updated)      parts.push(`${data.updated} updated`);
      if (data.alreadyKnown) parts.push(`${data.alreadyKnown} already known`);
      const summary = parts.length ? parts.join(', ') : 'nothing stored';

      return textResponse(`Remembered ${facts.length} input${facts.length === 1 ? '' : 's'} → ${summary} (namespace: ${data.namespace}).`);
    },
  );
}

export { registerRememberTool };
