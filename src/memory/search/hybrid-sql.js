/**
 * Single-query hybrid search for facts: vector + keyword merged in SQL via RRF,
 * then re-weighted by an ACT-R-style activation function.
 *
 * Pipeline (one round-trip):
 *   1. Semantic CTE — top-K via cosine similarity
 *   2. Keyword CTE — top-K via ts_rank
 *   3. fused — FULL OUTER JOIN with position-based RRF
 *   4. ranked — multiply RRF score by softplus(ACT-R activation) × importance × confidence
 *
 * ACT-R activation (Anderson's cognitive architecture) makes frequently-used and
 * recently-used facts win ties over equally-similar but older/less-used facts.
 * Formula: `ln(access_count+1) - 0.5*ln(t_days)`, then softplus to keep ≥0.
 *
 * Approach: single-SQL RRF (fewer round-trips than two-query JS merge)
 * + ACT-R activation as the ranking multiplier on top of the fused score.
 */

import cortexDb from '../../db/cortex.js';
import { pgHalfvecColumn, pgHalfvecParam, pgVector } from '../../lib/vectors.js';
import { CONFIDENCE_CASE, buildFactFilters } from './filters.js';
import { RRF_K, VECTOR_WEIGHT, KEYWORD_WEIGHT } from './scoring-constants.js';

const OVERFETCH = 3;

// Score multipliers (kept here — match what the rerank stage expects)
const IMPORTANCE_VITAL_MULT = 1.5;
const CONFIDENCE_HIGH_MULT = 1.0;
const CONFIDENCE_MEDIUM_MULT = 0.85;
const CONFIDENCE_LOW_MULT = 0.7;

async function hybridSearchFacts(query, queryEmbedding, { namespaces, limit = 5, minConfidence = 'medium', pointInTime, categories, podIds = null }) {
  const vec = pgVector(queryEmbedding);
  const embeddingDistance = `${pgHalfvecColumn('embedding')} <=> ${pgHalfvecParam()}`;
  const { temporalClause, categoryClause, filterParams } = buildFactFilters({ minConfidence, pointInTime, categories });
  const overfetchLimit = limit * OVERFETCH;

  // Pod-scope filter — applied identically to both CTEs. THREE distinct cases,
  // and conflating the first two was a silent global leak:
  //   - null / undefined  → no scope requested → global, no filter.
  //   - []                → scope requested but resolved to NOTHING → match no
  //                          rows (NOT global!). An agent/context with zero
  //                          readable pods must see zero facts, not the whole
  //                          brain. `AND FALSE` short-circuits both CTEs.
  //   - [ids]             → membership filter to those pods.
  // Caller (hybrid.js resolvePodScope) returns null for global, [] for
  // scoped-empty, [ids] for scoped.
  const podScopeRequested = Array.isArray(podIds);
  const podScopeEmpty = podScopeRequested && podIds.length === 0;
  const podScopeClause = !podScopeRequested
    ? ''
    : podScopeEmpty
      ? 'AND FALSE'
      : `AND id = ANY(
           SELECT member_id FROM pod_membership
           WHERE member_type = 'fact' AND pod_id = ANY(?::int[])
         )`;
  const podScopeParams = (podScopeRequested && !podScopeEmpty) ? [podIds] : [];

  // Params order (matches the `?` sequence below):
  //   1. vec                            -- semantic CTE: similarity select
  //   2. vec                            -- semantic CTE: rank_ix order
  //   3. namespaces                     -- semantic WHERE
  //   4. minRank                        -- semantic confidence (from filterParams[0])
  //   5...N  temporal + category params -- semantic WHERE (from filterParams tail)
  //   N+1. vec                          -- semantic ORDER BY
  //   N+2. overfetchLimit               -- semantic LIMIT
  //   N+3. query                        -- keyword tsquery
  //   N+4. query                        -- keyword rank_ix tsquery
  //   N+5. namespaces                   -- keyword WHERE
  //   N+6. minRank                      -- keyword confidence
  //   N+7...M  temporal + category      -- keyword WHERE
  //   M+1. query                        -- keyword ORDER BY tsquery
  //   M+2. overfetchLimit               -- keyword LIMIT
  //   final: RRF_K (twice), weights, fallback ranks, RRF_K sort, limit

  // filterParams = [minRank, ...extras] where extras are the temporal+category
  // params. Semantic CTE places extras BETWEEN minRank and the closing
  // ORDER BY/LIMIT — so [minRank, ...extras] flows naturally. Keyword CTE
  // places the @@ tsquery BETWEEN minRank and extras (because the @@ filter
  // is a WHERE clause that comes textually before ${temporalClause} and
  // ${categoryClause} in the SQL), so the @@ query param has to be inserted
  // after minRank but BEFORE extras. Splatting filterParams blindly here is
  // what caused the previous "Invalid input for string type" error when a
  // categories array landed where the @@ tsquery placeholder lived.
  const [minRank, ...extraFilterParams] = filterParams;

  const semanticParams = [vec, vec, namespaces, minRank, ...extraFilterParams, ...podScopeParams, vec, overfetchLimit];
  const keywordParams  = [query, query, namespaces, minRank, query, ...extraFilterParams, ...podScopeParams, overfetchLimit];
  const rrfParams = [
    overfetchLimit, // COALESCE fallback for semantic rank_ix
    overfetchLimit, // COALESCE fallback for keyword rank_ix
    limit,          // final LIMIT
  ];

  const sql = `
    WITH semantic AS (
      SELECT id,
             uid,
             content, category, confidence, importance, namespace, status,
             source_document_ids AS "sourceDocumentIds",
             source_section AS "sourceSection",
             created_by_device_id AS "createdByDeviceId",
             created_by_agent AS "createdByAgent",
             created_at,
             1 - (${embeddingDistance}) AS similarity,
             ROW_NUMBER() OVER (ORDER BY ${embeddingDistance}) AS rank_ix
      FROM fact
      WHERE namespace = ANY(?)
        AND status = 'active'
        AND embedding IS NOT NULL
        AND ${CONFIDENCE_CASE} >= ?
        ${temporalClause}
        ${categoryClause}
        ${podScopeClause}
      ORDER BY ${embeddingDistance}
      LIMIT ?
    ),
    keyword AS (
      SELECT id,
             uid,
             content, category, confidence, importance, namespace, status,
             source_document_ids AS "sourceDocumentIds",
             source_section AS "sourceSection",
             created_by_device_id AS "createdByDeviceId",
             created_by_agent AS "createdByAgent",
             created_at,
             ts_rank_cd(search_vector, plainto_tsquery('english', ?)) AS keyword_rank,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_vector, plainto_tsquery('english', ?)) DESC) AS rank_ix
      FROM fact
      WHERE namespace = ANY(?)
        AND status = 'active'
        AND ${CONFIDENCE_CASE} >= ?
        AND search_vector @@ plainto_tsquery('english', ?)
        ${temporalClause}
        ${categoryClause}
        ${podScopeClause}
      ORDER BY keyword_rank DESC
      LIMIT ?
    ),
    fused AS (
      SELECT COALESCE(s.id, k.id) AS id,
             COALESCE(s.uid, k.uid) AS uid,
             COALESCE(s.content, k.content) AS content,
             COALESCE(s.category, k.category) AS category,
             COALESCE(s.confidence, k.confidence) AS confidence,
             COALESCE(s.importance, k.importance) AS importance,
             COALESCE(s.namespace, k.namespace) AS namespace,
             COALESCE(s.status, k.status) AS status,
             COALESCE(s."sourceDocumentIds", k."sourceDocumentIds") AS "sourceDocumentIds",
             COALESCE(s."sourceSection", k."sourceSection") AS "sourceSection",
             COALESCE(s."createdByDeviceId", k."createdByDeviceId") AS "createdByDeviceId",
             COALESCE(s."createdByAgent", k."createdByAgent") AS "createdByAgent",
             COALESCE(s.created_at, k.created_at) AS created_at,
             COALESCE(s.similarity, 0) AS similarity,
             (
               ${VECTOR_WEIGHT} * (1.0 / (${RRF_K} + COALESCE(s.rank_ix, ?)))
             + ${KEYWORD_WEIGHT} * (1.0 / (${RRF_K} + COALESCE(k.rank_ix, ?)))
             ) AS rrf_raw
      FROM semantic s
      FULL OUTER JOIN keyword k ON s.id = k.id
    ),
    ranked AS (
      SELECT f.*,
             COALESCE(fl.access_count, 0) AS access_count,
             fl.last_accessed_at,
             -- ACT-R activation: ln(n+1) - 0.5*ln(t_days), softplus to keep >= 0.
             -- t_days floor of 0.01 prevents log(0). Recently-accessed facts win ties.
             ln(1.0 + exp(
               ln(COALESCE(fl.access_count, 0) + 1.0)
               - 0.5 * ln(
                   GREATEST(
                     EXTRACT(epoch FROM (now() - COALESCE(fl.last_accessed_at, f.created_at))) / 86400.0,
                     0.01
                   )
                 )
             )) AS activation,
             CASE f.importance WHEN 'vital' THEN ${IMPORTANCE_VITAL_MULT} ELSE 1.0 END AS importance_mult,
             CASE f.confidence
               WHEN 'high'   THEN ${CONFIDENCE_HIGH_MULT}
               WHEN 'medium' THEN ${CONFIDENCE_MEDIUM_MULT}
               WHEN 'low'    THEN ${CONFIDENCE_LOW_MULT}
               ELSE 1.0
             END AS confidence_mult
      FROM fused f
      LEFT JOIN fact_lifecycle fl ON fl.fact_id = f.id
    )
    SELECT id, uid, content, category, confidence, importance, namespace, status,
           "sourceDocumentIds", "sourceSection", "createdByDeviceId", "createdByAgent", similarity,
           rrf_raw,
           access_count,
           last_accessed_at AS "lastAccessedAt",
           activation,
           (rrf_raw * activation * importance_mult * confidence_mult) AS final_score
    FROM ranked
    ORDER BY final_score DESC,
             CASE WHEN importance = 'vital' THEN 0 ELSE 1 END
    LIMIT ?
  `;

  const params = [...semanticParams, ...keywordParams, ...rrfParams];
  const { rows } = await cortexDb.raw(sql, params);

  if (!rows.length) return [];

  // Normalize against the top score so callers see [0..1] regardless of underlying scale.
  const maxScore = rows[0].final_score || rows[0].rrf_raw || 1;
  return rows.map((r) => ({
    ...r,
    rrfScore: Math.round((Number(r.final_score || r.rrf_raw) / Number(maxScore)) * 100) / 100,
  }));
}

export { hybridSearchFacts };
