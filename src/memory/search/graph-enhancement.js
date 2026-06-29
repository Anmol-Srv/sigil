import cortexDb from '../../db/cortex.js';
import { getEntityIdsForFacts } from '../facts/entity-linker.js';

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

async function findRelatedFacts(mentionedEntityIds, { limit = 10 } = {}) {
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
    .select('id', 'name');

  const entityNameById = new Map(relatedEntities.map((e) => [e.id, e.name]));

  const facts = await cortexDb('fact')
    .join('fact_entity', 'fact.id', 'fact_entity.factId')
    .whereIn('fact_entity.entityId', [...relatedEntityIds])
    .where('fact.status', 'active')
    .select('fact.*', 'fact_entity.entityId')
    .orderBy('fact_entity.mentionCount', 'desc')
    .limit(limit * 3);

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

export { extractEntitiesFromFacts, findRelatedFacts, rerank };
