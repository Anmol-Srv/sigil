import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse, truncate, FACT_TRUNCATE } from '../utils.js';

function registerGetPodTool(server) {
  server.tool(
    'get_pod',
    `Get a memory pod with its member facts, documents, and (for person pods)
the canonical entity link.
Use for: "what happened in this session?", "show me everything sigil knows
about Dhaval", "what's in the Slack workspace pod?".
Returns pod metadata + up to 20 latest facts + up to 10 latest documents.`,
    {
      uid: z.string().describe('Pod uid (from list_pods or sigil session current)'),
    },
    async ({ uid }) => {
      const data = await daemonCall('getPod', { uid });
      if (data.notFound) return textResponse(`Error: pod ${uid} not found.`);

      const { pod, facts, documents } = data;
      const parts = [
        `**${pod.name}** (${pod.podType}, uid:${pod.uid})`,
        '',
        `- namespace: ${pod.namespace}`,
        `- status: ${pod.status}`,
      ];
      if (pod.startedAt) parts.push(`- started_at: ${pod.startedAt}`);
      if (pod.endedAt) parts.push(`- ended_at: ${pod.endedAt}`);
      if (pod.entityId) parts.push(`- entity_id: ${pod.entityId}`);
      if (pod.connectionId) parts.push(`- connection_id: ${pod.connectionId}`);
      if (pod.externalId) parts.push(`- external_id: ${pod.externalId}`);

      const attrEntries = Object.entries(pod.attrs || {}).filter(([, v]) => v != null && v !== '');
      if (attrEntries.length) {
        parts.push('', 'Attrs:');
        for (const [k, v] of attrEntries) {
          const val = typeof v === 'object' ? JSON.stringify(v) : v;
          parts.push(`- ${k}: ${val}`);
        }
      }

      if (facts.length) {
        parts.push('', `Member facts (${facts.length}, up to 20):`);
        for (const f of facts) {
          const content = truncate(f.content, FACT_TRUNCATE);
          const tag = f.podRole === 'mention' ? ' _[mention]_' : '';
          parts.push(`- ${content} (id:${f.id})${tag}`);
        }
      }
      if (documents.length) {
        parts.push('', `Member documents (${documents.length}, up to 10):`);
        for (const d of documents) {
          const title = d.title || d.sourcePath || `doc-${d.id}`;
          parts.push(`- ${truncate(title, 80)} (id:${d.id})`);
        }
      }
      if (!facts.length && !documents.length) {
        parts.push('', '_Pod has no member facts or documents yet._');
      }
      return textResponse(parts.join('\n'));
    },
  );
}

export { registerGetPodTool };
