import { z } from 'zod';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

function registerListPodsTool(server) {
  server.tool(
    'list_pods',
    `List memory pods (typed containers segregating facts by source or subject).
Use for: "what sessions do I have?", "list everyone I have a pod for", "which workspaces?".
Pod types: session (Claude Code), person (people you have a relationship with),
project, connector_workspace, custom.`,
    {
      type: z.enum(['session', 'person', 'project', 'connector_workspace', 'custom']).optional()
        .describe('Filter by pod type. Omit for all types.'),
      namespace: z.string().optional().describe('Namespace. Omit for default.'),
      status: z.enum(['active', 'archived']).optional().default('active'),
      limit: z.number().int().positive().max(100).optional().default(20),
    },
    async ({ type, namespace, status, limit }) => {
      const { pods } = await daemonCall('listPods', { type, namespace, status, limit });
      if (!pods.length) {
        const filter = type ? ` of type "${type}"` : '';
        return textResponse(`No${filter} pods found.`);
      }
      const lines = [`Found ${pods.length} pod${pods.length === 1 ? '' : 's'}:`, ''];
      for (const p of pods) {
        const facts = p.memberFactCount ?? 0;
        const docs = p.memberDocCount ?? 0;
        const updated = p.updatedAt
          ? new Date(p.updatedAt).toISOString().slice(0, 16).replace('T', ' ')
          : '—';
        lines.push(`- **${p.name}** (${p.podType}, uid:${p.uid})`);
        lines.push(`  facts=${facts} docs=${docs} updated=${updated}`);
      }
      lines.push('');
      lines.push('_Use get_pod(uid=...) for member facts and full metadata._');
      return textResponse(lines.join('\n'));
    },
  );
}

export { registerListPodsTool };
