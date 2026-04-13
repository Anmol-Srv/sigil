import { z } from 'zod';
import { groupBy } from 'lodash-es';

import { findById } from '../../memory/entities/store.js';
import { getEntityNeighborhood, findPath, findRelated } from '../../memory/entities/traversal.js';
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
      const entity = await findById(startEntityId);
      if (!entity) {
        return textResponse(`Error: Entity ID ${startEntityId} not found.`);
      }

      const label = `${entity.name} (${entity.entityType}, id:${entity.id})`;

      if (action === 'path') {
        if (!targetEntityId) {
          return textResponse('Error: targetEntityId is required for "path" action.');
        }
        return formatPath(label, entity, targetEntityId, { maxDepth: Math.min(maxDepth, 4) });
      }

      if (action === 'related') {
        return formatRelated(label, entity, { maxDepth: Math.min(maxDepth, 3), relationType, limit });
      }

      return formatNeighbors(label, entity, { depth: Math.min(maxDepth, 3), limit });
    },
  );
}

async function formatNeighbors(label, entity, opts) {
  const result = await getEntityNeighborhood(entity.id, opts);

  if (result.related) {
    const lines = result.related.map((r) =>
      `- [${r.relationType}] ${r.name} (${r.entityType}, id:${r.entityId || r.id}) depth:${r.depth}`,
    );
    return textResponse(`${label}\nConnections (${result.related.length}):\n${lines.join('\n')}`);
  }

  if (!result.relations?.length) {
    return textResponse(`${label}\nNo connections found.`);
  }

  const outgoing = result.relations.filter((r) => r.direction === 'outgoing');
  const incoming = result.relations.filter((r) => r.direction === 'incoming');
  const parts = [label];

  if (outgoing.length) {
    parts.push(`\nOutgoing (${outgoing.length}):`);
    for (const r of outgoing) {
      parts.push(`- [${r.relationType}] ${r.name} (${r.entityType}, id:${r.entityId})`);
    }
  }

  if (incoming.length) {
    parts.push(`\nIncoming (${incoming.length}):`);
    for (const r of incoming) {
      parts.push(`- ${r.name} (${r.entityType}, id:${r.entityId}) [${r.relationType}]`);
    }
  }

  return textResponse(parts.join('\n'));
}

async function formatPath(label, startEntity, targetEntityId, opts) {
  const result = await findPath(startEntity.id, targetEntityId, opts);
  if (!result) {
    return textResponse(`No path found from ${startEntity.name} to entity ${targetEntityId}.`);
  }

  const steps = result.path.map((e, i) => {
    const arrow = i < result.relationTypes.length ? ` --[${result.relationTypes[i]}]--> ` : '';
    return `${e.name} (${e.entityType})${arrow}`;
  });

  return textResponse(`Path (${result.depth} hops):\n${steps.join('')}`);
}

async function formatRelated(label, entity, opts) {
  const related = await findRelated(entity.id, opts);
  if (!related.length) {
    return textResponse(`${entity.name} has no related entities within ${opts.maxDepth} hops.`);
  }

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

export { registerTraverseGraphTool };
