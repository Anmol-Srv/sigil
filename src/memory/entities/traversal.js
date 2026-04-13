import cortexDb from '../../db/cortex.js';
import { findById } from './store.js';
import { listRelationsForEntity } from './relations.js';

/**
 * Walk the graph outward from an entity using recursive CTE.
 * Returns all reachable entities up to maxDepth, with cycle prevention.
 */
async function findRelated(entityId, { maxDepth: rawDepth = 2, relationType, limit = 30 } = {}) {
  const maxDepth = Math.min(Math.max(rawDepth, 1), 6);
  const params = [entityId, entityId];
  const typeFilter = relationType
    ? 'AND r.relation_type = ?'
    : '';
  if (relationType) params.push(relationType);

  // Repeat params for recursive part
  const typeFilter2 = relationType ? 'AND r.relation_type = ?' : '';
  if (relationType) params.push(relationType);

  params.push(maxDepth, limit);

  const { rows } = await cortexDb.raw(`
    WITH RECURSIVE graph AS (
      SELECT r.target_id AS entity_id, r.relation_type, r.mention_count,
             1 AS depth, ARRAY[?::integer] AS path
      FROM relation r
      WHERE r.source_id = ?
        AND r.invalid_at IS NULL
        ${typeFilter}

      UNION ALL

      SELECT r.target_id, r.relation_type, r.mention_count,
             g.depth + 1, g.path || r.target_id
      FROM relation r
      JOIN graph g ON r.source_id = g.entity_id
      WHERE g.depth < ?
        AND r.invalid_at IS NULL
        AND NOT (r.target_id = ANY(g.path))
        ${typeFilter2}
    )
    SELECT DISTINCT ON (g.entity_id)
      g.entity_id AS "entityId", g.relation_type AS "relationType",
      g.depth, g.mention_count AS "mentionCount",
      e.name, e.entity_type AS "entityType", e.description, e.uid
    FROM graph g
    JOIN entity e ON e.id = g.entity_id
    WHERE e.merged_with IS NULL
    ORDER BY g.entity_id, g.depth ASC
    LIMIT ?
  `, params);

  return rows;
}

/**
 * Get an entity and all its direct connections (depth 1).
 * Returns the entity with outgoing and incoming relations.
 */
async function getEntityNeighborhood(entityId, { depth = 1, limit = 50 } = {}) {
  const entity = await findById(entityId);
  if (!entity) return null;

  if (depth > 1) {
    const related = await findRelated(entityId, { maxDepth: depth, limit });
    return { entity, related };
  }

  const relations = await listRelationsForEntity(entityId, { limit });
  return { entity, relations };
}

/**
 * BFS shortest path between two entities via recursive CTE.
 * Returns the path as an array of entities, or null if no path exists.
 */
async function findPath(sourceEntityId, targetEntityId, { maxDepth: rawDepth = 4 } = {}) {
  const maxDepth = Math.min(Math.max(rawDepth, 1), 6);
  const { rows } = await cortexDb.raw(`
    WITH RECURSIVE search AS (
      SELECT r.target_id AS current_id,
             ARRAY[r.source_id, r.target_id] AS path,
             ARRAY[r.relation_type] AS relation_types,
             1 AS depth
      FROM relation r
      WHERE r.source_id = ?
        AND r.invalid_at IS NULL

      UNION ALL

      SELECT r.target_id,
             s.path || r.target_id,
             s.relation_types || r.relation_type,
             s.depth + 1
      FROM relation r
      JOIN search s ON r.source_id = s.current_id
      WHERE s.depth < ?
        AND r.invalid_at IS NULL
        AND NOT (r.target_id = ANY(s.path))
    )
    SELECT path, relation_types AS "relationTypes", depth
    FROM search
    WHERE current_id = ?
    ORDER BY depth ASC
    LIMIT 1
  `, [sourceEntityId, maxDepth, targetEntityId]);

  if (!rows.length) return null;

  const { path: entityIds, relationTypes, depth } = rows[0];

  const entities = await cortexDb('entity')
    .whereIn('id', entityIds)
    .select('id', 'uid', 'name', 'entityType', 'description');

  // Order by path position
  const entityMap = Object.fromEntries(entities.map((e) => [e.id, e]));
  const orderedPath = entityIds.map((id) => entityMap[id]);

  return { path: orderedPath, relationTypes, depth };
}

/**
 * List entities of a given type, sorted by mention count (most connected first).
 */
async function findEntitiesByType(entityType, { namespace, sortBy = 'mentionCount', limit = 50 } = {}) {
  const query = cortexDb('entity')
    .where({ entityType })
    .whereNull('mergedWith')
    .orderBy(sortBy, 'desc')
    .limit(limit);

  if (namespace) query.where({ namespace });
  return query;
}

export { findRelated, getEntityNeighborhood, findPath, findEntitiesByType };
