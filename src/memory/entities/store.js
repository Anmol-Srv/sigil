import { nanoid } from 'nanoid';

import cortexDb from '../../db/cortex.js';
import { pgVector } from '../../lib/vectors.js';
import config from '../../config.js';

async function insertEntity({ name, entityType, description, namespace, externalId, embedding }) {
  const uid = `ent-${nanoid(16)}`;

  const [entity] = await cortexDb('entity')
    .insert({
      uid,
      name,
      entityType,
      description: description || null,
      namespace: namespace || config.defaults.namespace,
      externalId: externalId || null,
      mentionCount: 1,
      embedding: pgVector(embedding),
    })
    .returning('*');

  return entity;
}

async function findByName(name, namespace) {
  return cortexDb('entity')
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .where({ namespace: namespace || config.defaults.namespace })
    .whereNull('mergedWith')
    .first() || null;
}

async function findByUid(uid) {
  return cortexDb('entity').where({ uid }).first() || null;
}

async function findById(id) {
  return cortexDb('entity').where({ id }).first() || null;
}

async function findSimilar(embedding, { entityType, namespace, threshold = 0.85, limit = 3 }) {
  const vec = pgVector(embedding);

  const { rows } = await cortexDb.raw(`
    SELECT id, uid, name, entity_type AS "entityType", description,
           mention_count AS "mentionCount",
           1 - (embedding <=> ?) AS similarity
    FROM entity
    WHERE entity_type = ?
      AND namespace = COALESCE(?, ?)
      AND embedding IS NOT NULL
      AND merged_with IS NULL
      AND 1 - (embedding <=> ?) >= ?
    ORDER BY embedding <=> ?
    LIMIT ?
  `, [vec, entityType, namespace, config.defaults.namespace, vec, threshold, vec, limit]);

  return rows;
}

async function incrementMentionCount(entityId) {
  await cortexDb('entity')
    .where({ id: entityId })
    .increment('mentionCount', 1);
}

async function updateDescription(entityId, description) {
  await cortexDb('entity')
    .where({ id: entityId })
    .update({ description });
}

async function listByType(entityType, { namespace, limit = 50 } = {}) {
  const query = cortexDb('entity')
    .where({ entityType })
    .whereNull('mergedWith')
    .orderBy('mentionCount', 'desc')
    .limit(limit);

  if (namespace) query.where({ namespace });
  return query;
}

async function getEntityCount(entityType) {
  const [{ count }] = await cortexDb('entity')
    .where({ entityType })
    .whereNull('mergedWith')
    .count('id as count');
  return Number(count);
}

async function searchByName(query, { entityType, namespace, limit = 10 } = {}) {
  const q = cortexDb('entity')
    .whereRaw('LOWER(name) LIKE ?', [`%${query.toLowerCase()}%`])
    .whereNull('mergedWith')
    .orderBy('mentionCount', 'desc')
    .limit(limit);

  if (entityType) q.where({ entityType });
  if (namespace) q.where({ namespace });
  return q;
}

async function updateEntityTypes(entityId, newType) {
  const entity = await findById(entityId);
  if (!entity) return;

  let types;
  try {
    types = entity.entityTypes ? JSON.parse(entity.entityTypes) : [entity.entityType];
  } catch {
    types = [entity.entityType];
  }

  if (!types.includes(newType)) {
    types.push(newType);
    await cortexDb('entity')
      .where({ id: entityId })
      .update({ entityTypes: JSON.stringify(types) });
  }
}

async function getCanonicalEntity(entityId) {
  let entity = await findById(entityId);

  while (entity?.mergedWith) {
    entity = await findById(entity.mergedWith);
  }

  return entity;
}

export {
  insertEntity,
  findByName,
  findByUid,
  findById,
  findSimilar,
  incrementMentionCount,
  updateDescription,
  updateEntityTypes,
  getCanonicalEntity,
  listByType,
  getEntityCount,
  searchByName,
};
