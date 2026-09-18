import cortexDb from '../../db/cortex.js';
import { getEntityIdsForFacts } from '../facts/entity-linker.js';
import { buildFactFilters } from './filters.js';
import { scopeVisibility } from '../visibility.js';

const GRAPH_CONFIDENCE_CASE = `CASE fact.confidence
  WHEN 'high' THEN 2
  WHEN 'medium' THEN 1
  ELSE 0
END`;

// Graph traversal broadens *relationships*, never the caller's authorization
// boundary. Keep this in the graph module (rather than trusting callers to
// pre-filter) so every future graph-backed retrieval path inherits the guard.
function applyFactScope(query, { namespaces, minConfidence = 'medium', pointInTime, categories, podIds, viewer } = {}) {
  const { minRank } = buildFactFilters({ minConfidence, pointInTime, categories, viewer });
  if (!Array.isArray(namespaces) || !namespaces.length) {
    return query.whereRaw('FALSE');
  }

  query
    .whereIn('fact.namespace', namespaces)
    .where('fact.status', 'active')
    .whereRaw(`${GRAPH_CONFIDENCE_CASE} >= ?`, [minRank]);

  if (pointInTime) {
    query.whereRaw('fact.valid_from <= ? AND (fact.valid_until IS NULL OR fact.valid_until > ?)', [pointInTime, pointInTime]);
  }
  if (categories?.length) query.whereIn('fact.category', categories);
  scopeVisibility(query, viewer, 'fact');

  if (Array.isArray(podIds)) {
    const unpodded = `NOT EXISTS (
      SELECT 1 FROM pod_membership pm
      WHERE pm.member_type = 'fact' AND pm.member_id = fact.id
    )`;
    if (!podIds.length) query.whereRaw(unpodded);
    else query.whereRaw(`(fact.id = ANY(
      SELECT member_id FROM pod_membership
      WHERE member_type = 'fact' AND pod_id = ANY(?::int[])
    ) OR ${unpodded})`, [podIds]);
  }
  return query;
}

async function extractEntitiesFromFacts(facts) {
  const factIds = facts.map((f) => f.id);
  const factEntityMap = await getEntityIdsForFacts(factIds);

  const allEntityIds = new Set();
  for (const ids of factEntityMap.values()) {
    for (const id of ids) allEntityIds.add(id);
  }

  if (!allEntityIds.size) return [];

  return cortexDb('entity')
    .whereIn('id', [...allEntityIds])
    .whereNull('mergedWith')
    .select('id', 'uid', 'name', 'entityType', 'description');
}

async function findRelatedFacts(mentionedEntityIds, { limit = 10, hubMentionCutoff, ...scope } = {}) {
  if (!mentionedEntityIds.length) return [];

  const relations = await cortexDb('relation')
    .where(function () {
      this.whereIn('sourceId', mentionedEntityIds)
        .orWhereIn('targetId', mentionedEntityIds);
    })
    .whereNull('invalidAt')
    .select('*')
    .limit(limit * 3);

  const mentionedSet = new Set(mentionedEntityIds);
  const relatedEntityIds = new Set();
  const relationByEntity = new Map();

  for (const rel of relations) {
    const relatedId = mentionedSet.has(rel.sourceId) ? rel.targetId : rel.sourceId;
    relatedEntityIds.add(relatedId);
    if (!relationByEntity.has(relatedId)) {
      relationByEntity.set(relatedId, rel);
    }
  }

  if (!relatedEntityIds.size) return [];

  const relatedEntities = await cortexDb('entity')
    .whereIn('id', [...relatedEntityIds])
    .whereNull('mergedWith')
    .select('id', 'name', 'mentionCount');

  // Hub entities carry no relatedness. Measured on a real 1331-entity store:
  // the median entity is mentioned by 1 fact and p99 by 22, but a handful of
  // project-name topics reach 179. Two facts "related" because both mention
  // `hermes` are not related at all, and traversal through those hubs is what
  // returned a Slack channel id for a query about dependency checks.
  const hubCutoff = Number(hubMentionCutoff) > 0 ? Number(hubMentionCutoff) : Infinity;
  const specific = relatedEntities.filter((e) => (e.mentionCount ?? 1) <= hubCutoff);
  if (!specific.length) return [];

  const entityNameById = new Map(specific.map((e) => [e.id, e.name]));
  // Inverse-frequency weight: a bridge entity shared by two facts says more the
  // rarer it is. Same intuition as IDF, and the reason the old
  // `ORDER BY fact_entity.mention_count DESC` was backwards — it ranked the
  // most generic association first.
  const specificity = new Map(specific.map((e) => [e.id, 1 / Math.log2(2 + (e.mentionCount ?? 1))]));
  const specificIds = specific.map((e) => e.id);

  const factsQuery = cortexDb('fact')
    .join('fact_entity', 'fact.id', 'fact_entity.factId')
    .whereIn('fact_entity.entityId', specificIds);
  applyFactScope(factsQuery, scope);
  const rows = await factsQuery
    .select('fact.*', 'fact_entity.entityId')
    .limit(limit * 6);
  const facts = rows.sort((a, b) => (specificity.get(b.entityId) ?? 0) - (specificity.get(a.entityId) ?? 0));

  const seenFactIds = new Set();
  const relatedFacts = [];

  for (const fact of facts) {
    if (seenFactIds.has(fact.id)) continue;
    seenFactIds.add(fact.id);

    const rel = relationByEntity.get(fact.entityId);
    const entityName = entityNameById.get(fact.entityId) || 'unknown';
    const relationType = rel?.relationType || 'related';

    relatedFacts.push({
      ...fact,
      relationPath: `${entityName} (${relationType})`,
      graphDistance: 1,
    });

    if (relatedFacts.length >= limit) break;
  }

  return relatedFacts;
}

function rerank(directFacts, relatedFacts, mentionedEntityIds, limit) {
  const boosted = directFacts.map((f) => ({
    ...f,
    resultType: 'direct',
  }));

  const related = relatedFacts
    .filter((rf) => !directFacts.some((df) => df.id === rf.id))
    .map((f) => ({
      ...f,
      rrfScore: (f.rrfScore || 0.1) * 0.5,
      resultType: 'related',
    }));

  return [...boosted, ...related].slice(0, limit);
}

export { applyFactScope, extractEntitiesFromFacts, findRelatedFacts, rerank };
