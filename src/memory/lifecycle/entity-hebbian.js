/**
 * Hebbian co-retrieval edges between entities.
 *
 * Sibling of fact-level hebbian.js. Called fire-and-forget from the search
 * path: every pair of entities linked to facts in the same top-K gets its
 * edge strengthened. Lex canonicalization (entity_a_id < entity_b_id) at the
 * row level guarantees one row per unordered pair.
 *
 * Update rule: capped increment over a decayed base.
 *   write  →  strength = LEAST(strength * exp(-lambda * days_since_last_seen) + eta, cap)
 *             last_seen_at = NOW()
 *   read   →  effective = strength * exp(-lambda * days_since_last_seen)
 *             where lambda = ln(2) / halfLifeDays
 *
 * The write settles the decay accrued up to this touch; the read decays from
 * the touch onwards. No background job, and no double-counting: each interval
 * between touches is discounted exactly once.
 */

import cortexDb from '../../db/cortex.js';
import config from '../../config.js';

const LN2 = Math.log(2);

function lambdaFromHalfLife(halfLifeDays) {
  return LN2 / Math.max(halfLifeDays, 1);
}

/**
 * Strengthen edges between every pair in the given entity list.
 * O(K²) writes — pass top-K entities only (default cap K=12 caller-side).
 */
async function strengthenEntityEdges(entityIds, opts = {}) {
  if (!config.hebbian.entity.enabled) return;
  if (!entityIds || entityIds.length < 2) return;

  const eta = opts.eta ?? config.hebbian.entity.eta;
  const cap = opts.cap ?? config.hebbian.entity.cap;
  const lambda = lambdaFromHalfLife(opts.halfLifeDays ?? config.hebbian.entity.halfLifeDays);

  const ids = [...new Set(entityIds.filter((id) => Number.isInteger(id)))].sort((a, b) => a - b);
  if (ids.length < 2) return;

  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push([ids[i], ids[j]]);
    }
  }

  const valuesSql = pairs.map(() => '(?, ?, ?, NOW(), NOW())').join(', ');
  const params = pairs.flatMap(([a, b]) => [a, b, eta]);

  // Fold the elapsed decay into the stored value BEFORE incrementing. Reads
  // decay from last_seen_at, which this resets to NOW() — so without settling
  // it here, a single touch restored an edge's full historical strength and the
  // half-life never actually cost anything.
  await cortexDb.raw(`
    INSERT INTO entity_hebbian_edge (entity_a_id, entity_b_id, strength, first_seen_at, last_seen_at)
    VALUES ${valuesSql}
    ON CONFLICT (entity_a_id, entity_b_id)
    DO UPDATE SET
      strength = LEAST(
        entity_hebbian_edge.strength
          * EXP(-1.0 * ?::float8 * EXTRACT(EPOCH FROM (NOW() - entity_hebbian_edge.last_seen_at)) / 86400.0)
          + ?, ?),
      last_seen_at = NOW()
  `, [...params, lambda, eta, cap]);
}

/**
 * Top-K entities co-retrieved with the given entity, ranked by *decayed*
 * strength. Returns numeric effectiveStrength (post-decay) — callers can
 * threshold or blend directly.
 */
async function getCoRetrievedEntities(entityId, opts = {}) {
  if (!config.hebbian.entity.enabled) return [];

  const limit = opts.limit ?? 10;
  const minEffective = opts.minEffectiveStrength ?? config.hebbian.entity.minEffective;
  const lambda = lambdaFromHalfLife(opts.halfLifeDays ?? config.hebbian.entity.halfLifeDays);

  const { rows } = await cortexDb.raw(`
    SELECT
      CASE WHEN entity_a_id = ? THEN entity_b_id ELSE entity_a_id END AS "partnerId",
      (strength * EXP(-1.0 * ?::float8 * EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 86400.0))::float8 AS "effectiveStrength",
      strength::float8 AS "rawStrength",
      last_seen_at AS "lastSeenAt"
    FROM entity_hebbian_edge
    WHERE entity_a_id = ? OR entity_b_id = ?
    ORDER BY "effectiveStrength" DESC
    LIMIT ?
  `, [entityId, lambda, entityId, entityId, limit * 3]);

  return rows.filter((r) => r.effectiveStrength >= minEffective).slice(0, limit);
}

/**
 * For a set of seed entities (e.g. those linked to the top retrieved facts)
 * and a set of candidate entities (e.g. those linked to other facts in the
 * result set), return a Map of candidateId → summed decayed strength across
 * its edges to the seed set.
 *
 * This is the read-time signal for ranking: facts whose entities are tightly
 * co-retrieved with the seed entities get boosted in the final RRF blend.
 */
async function getEdgeStrengthsForRanking(seedEntityIds, candidateEntityIds, opts = {}) {
  if (!config.hebbian.entity.enabled) return new Map();
  if (!seedEntityIds.length || !candidateEntityIds.length) return new Map();

  const lambda = lambdaFromHalfLife(opts.halfLifeDays ?? config.hebbian.entity.halfLifeDays);

  const seedSet = [...new Set(seedEntityIds)];
  const candSet = [...new Set(candidateEntityIds)].filter((id) => !seedSet.includes(id));
  if (!candSet.length) return new Map();

  // An edge connects seed↔candidate iff exactly one endpoint is in each set.
  // The decayed strength contributes to the candidate's score.
  const { rows } = await cortexDb.raw(`
    SELECT
      CASE
        WHEN entity_a_id = ANY(?::bigint[]) THEN entity_b_id
        ELSE entity_a_id
      END AS "candidateId",
      SUM(strength * EXP(-1.0 * ?::float8 * EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 86400.0))::float8 AS "summedStrength"
    FROM entity_hebbian_edge
    WHERE
      (entity_a_id = ANY(?::bigint[]) AND entity_b_id = ANY(?::bigint[]))
      OR
      (entity_b_id = ANY(?::bigint[]) AND entity_a_id = ANY(?::bigint[]))
    GROUP BY "candidateId"
  `, [seedSet, lambda, seedSet, candSet, seedSet, candSet]);

  const map = new Map();
  for (const row of rows) {
    map.set(Number(row.candidateId), row.summedStrength);
  }
  return map;
}

/**
 * Housekeeping: drop edges that haven't been reinforced and have decayed
 * below the floor. Run from `sigil maintain`.
 */
async function consolidateEntityCoRetrievalEdges({ floor = 0.5, decayDays = 90 } = {}) {
  const lambda = lambdaFromHalfLife(config.hebbian.entity.halfLifeDays);
  const { rows } = await cortexDb.raw(`
    DELETE FROM entity_hebbian_edge
    WHERE (strength * EXP(-1.0 * ?::float8 * EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 86400.0)) <= ?
      AND last_seen_at < NOW() - (INTERVAL '1 day' * ?)
    RETURNING entity_a_id
  `, [lambda, floor, decayDays]);
  return rows.length;
}

/**
 * Edge density + top-pairs summary for `sigil status`. Returns an empty
 * shape when the feature is disabled or the table is empty so the caller
 * can render "0 edges" without special-casing.
 */
async function getEntityHebbianStats({ topN = 5 } = {}) {
  const lambda = lambdaFromHalfLife(config.hebbian.entity.halfLifeDays);

  const summary = await cortexDb.raw(`
    SELECT
      COUNT(*)::int AS "edgeCount",
      COALESCE(AVG(strength)::float8, 0) AS "avgStrength",
      COALESCE(MAX(strength)::float8, 0) AS "maxStrength"
    FROM entity_hebbian_edge
  `);

  const topPairs = await cortexDb.raw(`
    SELECT
      ea.name AS "aName",
      eb.name AS "bName",
      strength::float8 AS "strength",
      (strength * EXP(-1.0 * ?::float8 * EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 86400.0))::float8 AS "decayed"
    FROM entity_hebbian_edge
    JOIN entity ea ON ea.id = entity_a_id
    JOIN entity eb ON eb.id = entity_b_id
    ORDER BY "decayed" DESC
    LIMIT ?
  `, [lambda, topN]);

  return {
    edgeCount: summary.rows[0]?.edgeCount ?? 0,
    avgStrength: summary.rows[0]?.avgStrength ?? 0,
    maxStrength: summary.rows[0]?.maxStrength ?? 0,
    topPairs: topPairs.rows ?? [],
  };
}

export {
  strengthenEntityEdges,
  getCoRetrievedEntities,
  getEdgeStrengthsForRanking,
  consolidateEntityCoRetrievalEdges,
  getEntityHebbianStats,
};
