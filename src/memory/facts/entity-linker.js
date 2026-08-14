import { uniqBy } from 'lodash-es';

import cortexDb from '../../db/cortex.js';
import * as podMembership from '../pods/membership.js';

async function linkEntitiesToFact(factId, entities) {
  if (!entities.length) return;

  // Dedupe by entity id — same fact-entity pair appearing twice in one INSERT trips ON CONFLICT DO UPDATE
  // ("cannot affect row a second time"). This happens when entity resolution maps multiple raw mentions
  // to the same canonical entity within a single fact.
  const uniqueEntities = uniqBy(entities, 'id');

  const rows = uniqueEntities.map((e) => ({
    factId,
    entityId: e.id,
    mentionType: 'content',
    mentionCount: 1,
  }));

  await cortexDb('fact_entity')
    .insert(rows)
    .onConflict(cortexDb.raw('(fact_id, entity_id, mention_type)'))
    // One fact/entity pair is one piece of evidence. Durable enrichment retries
    // must be idempotent rather than inflating rank after a crash.
    .merge({ mentionCount: cortexDb.raw('GREATEST(fact_entity.mention_count, EXCLUDED.mention_count)') });

  await attachFactToEntityPods(factId, uniqueEntities);
}

// Cap fan-out. A fact naming half a dozen entities would otherwise join a pod
// for each and pollute all of them; a fact is genuinely "about" one or two
// things. Ranked by how often the entity is mentioned in the fact.
const MAX_ENTITY_PODS = 3;

/**
 * Subject routing: attach a fact to every pod backed by an entity it mentions,
 * with role='mention' — which is exactly what pod_membership.role documents it
 * as ("member just mentions an entity associated with this pod").
 *
 * This has always been the live wire behind hot-context's person slots. It now
 * carries project pods too, not because the code changed but because project
 * pods finally have an entity binding (see pods/subject-router.js
 * bindPodToEntity) — before that they were invisible to this query, which is
 * why a fact about srver written in another repo never reached srver.
 */
async function attachFactToEntityPods(factId, entities, db = cortexDb) {
  const entityIds = entities.map((e) => e.id).filter(Boolean);
  if (!entityIds.length) return { attached: 0, pods: [] };

  const podRows = await db('pod')
    .whereIn('entityId', entityIds)
    .where({ status: 'active' })
    .select('id', 'entityId');

  // Order pods by the mention weight of the entity that backs them, so the cap
  // keeps the pods this fact is most about.
  const weight = new Map(entities.map((e) => [e.id, e.mentionCount ?? 1]));
  const ranked = podRows
    .sort((a, b) => (weight.get(b.entityId) || 0) - (weight.get(a.entityId) || 0))
    .slice(0, MAX_ENTITY_PODS);

  let attached = 0;
  const pods = [];
  for (const { id: podId } of ranked) {
    const res = await podMembership.attachFact(podId, factId, 'mention', db);
    if (res.attached) { attached += 1; pods.push(podId); }
  }
  return { attached, pods };
}

async function getFactsForEntity(entityId, { limit = 50 } = {}) {
  return cortexDb('fact')
    .join('fact_entity', 'fact.id', 'fact_entity.fact_id')
    .where('fact_entity.entity_id', entityId)
    .where('fact.status', 'active')
    .select('fact.*', 'fact_entity.mention_count as entityMentionCount')
    .orderBy('fact_entity.mention_count', 'desc')
    .limit(limit);
}

async function getEntitiesForFact(factId) {
  return cortexDb('entity')
    .join('fact_entity', 'entity.id', 'fact_entity.entity_id')
    .where('fact_entity.fact_id', factId)
    .whereNull('entity.mergedWith')
    .select('entity.id', 'entity.uid', 'entity.name', 'entity.entityType', 'entity.description');
}

async function getEntityIdsForFacts(factIds) {
  if (!factIds.length) return new Map();

  const rows = await cortexDb('fact_entity')
    .whereIn('factId', factIds)
    .select('factId', 'entityId');

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.factId)) map.set(row.factId, []);
    map.get(row.factId).push(row.entityId);
  }
  return map;
}

export { linkEntitiesToFact, attachFactToEntityPods, getFactsForEntity, getEntitiesForFact, getEntityIdsForFacts };
