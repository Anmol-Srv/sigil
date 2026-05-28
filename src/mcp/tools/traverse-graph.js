import { z } from 'zod';
import { groupBy } from 'lodash-es';

import { daemonCall } from '../daemon-call.js';
import { textResponse } from '../utils.js';

function registerTraverseGraphTool(server) {
  server.tool(
    'traverse_graph',
    `Navigate entity relationships in the knowledge graph.
Use for: "who did Alice mentor?", "what topics does course X cover?", "how is A related to B?",
"what documents cover this topic?", "show mentorship chain".
Relation types: PART_OF, LED_BY, MENTORED, COVERS, FOLLOWS.`,
    {
      startEntityId: z.number().describe('Starting entity ID (from search_entity results)'),
      action: z.enum(['neighbors', 'path', 'related']).optional().default('neighbors')
        .describe('neighbors = direct connections, path = shortest path to target, related = all reachable'),
      targetEntityId: z.number().optional().describe('Target entity ID (required for "path" action)'),
      relationType: z.string().optional().describe('Filter: PART_OF, LED_BY, MENTORED, COVERS, FOLLOWS'),
      maxDepth: z.number().optional().default(2).describe('Traversal depth 1-3'),
      limit: z.number().optional().default(20).describe('Max results'),
    },
    async ({ startEntityId, action, targetEntityId, relationType, maxDepth, limit }) => {
      const data = await daemonCall('traverseGraph', { startEntityId, action, targetEntityId, relationType, maxDepth, limit });
      if (data.notFound) return textResponse(`Error: Entity ID ${startEntityId} not found.`);

      const label = `${data.start.name} (${data.start.entityType}, id:${data.start.id})`;

      if (data.action === 'path') {
        if (!data.path) return textResponse(`No path found from ${data.start.name} to entity ${targetEntityId}.`);
        const steps = data.path.path.map((e, i) => {
          const arrow = i < data.path.relationTypes.length ? ` --[${data.path.relationTypes[i]}]--> ` : '';
          return `${e.name} (${e.entityType})${arrow}`;
        });
        return textResponse(`Path (${data.path.depth} hops):\n${steps.join('')}`);
      }

      if (data.action === 'related') {
        const related = data.related || [];
        if (!related.length) return textResponse(`${data.start.name} has no related entities within ${maxDepth} hops.`);
        const byDepth = groupBy(related, 'depth');
        const parts = [`Entities related to ${label} (${related.length}):`];
        for (const depth of Object.keys(byDepth).sort()) {
          const depthLabel = depth === '1' ? 'Direct' : `${depth} hops`;
          parts.push(`\n${depthLabel}:`);
          for (const r of byDepth[depth]) {
            parts.push(`- [${r.relationType}] ${r.name} (${r.entityType}, id:${r.entityId})`);
          }
        }
        return textResponse(parts.join('\n'));
      }

      // neighbors
      if (data.related) {
        const lines = data.related.map((r) =>
          `- [${r.relationType}] ${r.name} (${r.entityType}, id:${r.entityId || r.id}) depth:${r.depth}`,
        );
        return textResponse(`${label}\nConnections (${data.related.length}):\n${lines.join('\n')}`);
      }
      if (!data.relations?.length) return textResponse(`${label}\nNo connections found.`);
      const outgoing = data.relations.filter((r) => r.direction === 'outgoing');
      const incoming = data.relations.filter((r) => r.direction === 'incoming');
      const parts = [label];
      if (outgoing.length) {
        parts.push(`\nOutgoing (${outgoing.length}):`);
        for (const r of outgoing) parts.push(`- [${r.relationType}] ${r.name} (${r.entityType}, id:${r.entityId})`);
      }
      if (incoming.length) {
        parts.push(`\nIncoming (${incoming.length}):`);
        for (const r of incoming) parts.push(`- ${r.name} (${r.entityType}, id:${r.entityId}) [${r.relationType}]`);
      }
      return textResponse(parts.join('\n'));
    },
  );
}

export { registerTraverseGraphTool };
