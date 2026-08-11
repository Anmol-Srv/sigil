import cortexDb from '../../db/cortex.js';

async function createRelation({
  sourceId, targetId, relationType, sourceFactId, validAt,
  derivedBy = 'llm-extract', confidence = null, weight = null,
}) {
  const { rows: [relation] } = await cortexDb.raw(`
    INSERT INTO relation (source_id, target_id, relation_type, source_fact_id, mention_count, valid_at, derived_by, confidence, weight, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NOW(), NOW())
    ON CONFLICT (source_id, target_id, relation_type) DO UPDATE SET
      mention_count = relation.mention_count + 1,
      source_fact_id = COALESCE(EXCLUDED.source_fact_id, relation.source_fact_id),
      -- An asserted edge outranks a derived one: if graph-extractor later reads
      -- this same relation off a sentence, that is stronger evidence than the
      -- co-occurrence that first proposed it, so let it win the provenance.
      derived_by = CASE WHEN EXCLUDED.derived_by = 'llm-extract' THEN 'llm-extract' ELSE relation.derived_by END,
      confidence = COALESCE(EXCLUDED.confidence, relation.confidence),
      weight = COALESCE(EXCLUDED.weight, relation.weight),
      updated_at = NOW()
    RETURNING *
  `, [sourceId, targetId, relationType, sourceFactId || null, validAt || null, derivedBy, confidence, weight]);

  return relation;
}

async function findRelation(sourceId, targetId, relationType) {
  return cortexDb('relation')
    .where({ sourceId, targetId, relationType })
    .whereNull('invalidAt')
    .first() || null;
}

async function invalidateRelation(relationId, { invalidAt } = {}) {
  await cortexDb('relation')
    .where({ id: relationId })
    .update({ invalidAt: invalidAt || new Date() });
}

async function listRelationsForEntity(entityId, { direction = 'both', relationType, limit = 50 } = {}) {
  const buildQuery = (dir) => {
    const fkCol = dir === 'outgoing' ? 'source_id' : 'target_id';
    const joinCol = dir === 'outgoing' ? 'target_id' : 'source_id';

    return cortexDb.raw(`
      SELECT r.id AS "relationId", r.relation_type AS "relationType",
             r.mention_count AS "mentionCount", r.valid_at AS "validAt",
             e.id AS "entityId", e.uid, e.name, e.entity_type AS "entityType",
             e.description, '${dir}' AS direction
      FROM relation r
      JOIN entity e ON e.id = r.${joinCol}
      WHERE r.${fkCol} = ?
        AND r.invalid_at IS NULL
        AND e.merged_with IS NULL
        ${relationType ? 'AND r.relation_type = ?' : ''}
      ORDER BY r.mention_count DESC
      LIMIT ?
    `, relationType
      ? [entityId, relationType, limit]
      : [entityId, limit]);
  };

  if (direction === 'outgoing') {
    const { rows } = await buildQuery('outgoing');
    return rows;
  }
  if (direction === 'incoming') {
    const { rows } = await buildQuery('incoming');
    return rows;
  }

  // Both directions
  const [outgoing, incoming] = await Promise.all([
    buildQuery('outgoing'),
    buildQuery('incoming'),
  ]);

  return [...outgoing.rows, ...incoming.rows];
}

async function getRelationsByFact(factId) {
  const { rows } = await cortexDb.raw(`
    SELECT r.id, r.relation_type AS "relationType",
           r.mention_count AS "mentionCount",
           s.name AS "sourceName", s.entity_type AS "sourceType",
           t.name AS "targetName", t.entity_type AS "targetType"
    FROM relation r
    JOIN entity s ON s.id = r.source_id
    JOIN entity t ON t.id = r.target_id
    WHERE r.source_fact_id = ?
      AND r.invalid_at IS NULL
      AND s.merged_with IS NULL
      AND t.merged_with IS NULL
  `, [factId]);

  return rows;
}

async function getRelationCount() {
  const [{ count }] = await cortexDb('relation')
    .whereNull('invalidAt')
    .count('id as count');
  return Number(count);
}

export {
  createRelation,
  findRelation,
  invalidateRelation,
  listRelationsForEntity,
  getRelationsByFact,
  getRelationCount,
};
