/**
 * Single-query hybrid search for facts: vector + keyword merged in SQL via RRF.
 *
 * Previously we did two DB round-trips and merged in Node. This version runs
 * one query with CTEs + FULL OUTER JOIN and RRF fusion, returning pre-ranked
 * facts. Saves a round-trip and lets Postgres plan the whole pipeline.
 *
 * Design follows Ogham's `hybrid_search_memories` pattern (see OGHAM-LEARNINGS.md §B):
 *   - Over-fetch 3x from each stage for RRF headroom
 *   - FULL OUTER JOIN preserves items appearing in only one list
 *   - Position-based RRF (scale-invariant)
 *   - Vital-importance tiebreak
 */

import cortexDb from '../../db/cortex.js';
import { pgVector } from '../../lib/vectors.js';
import config from '../../config.js';
import { CONFIDENCE_CASE, buildFactFilters } from './filters.js';

// Match the JS-side constants
const RRF_K = 20;
const VECTOR_WEIGHT = 1.0;
const KEYWORD_WEIGHT = 0.7;
const OVERFETCH = 3;

async function hybridSearchFacts(query, queryEmbedding, { namespaces, limit = 5, minConfidence = 'medium', pointInTime, categories }) {
  const vec = pgVector(queryEmbedding);
  const { temporalClause, categoryClause, filterParams } = buildFactFilters({ minConfidence, pointInTime, categories });
  const overfetchLimit = limit * OVERFETCH;

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

  const semanticParams = [vec, vec, namespaces, ...filterParams, vec, overfetchLimit];
  const keywordParams  = [query, query, namespaces, ...filterParams, query, overfetchLimit];
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
             1 - (embedding <=> ?) AS similarity,
             ROW_NUMBER() OVER (ORDER BY embedding <=> ?) AS rank_ix
      FROM fact
      WHERE namespace = ANY(?)
        AND status = 'active'
        AND embedding IS NOT NULL
        AND ${CONFIDENCE_CASE} >= ?
        ${temporalClause}
        ${categoryClause}
      ORDER BY embedding <=> ?
      LIMIT ?
    ),
    keyword AS (
      SELECT id,
             uid,
             content, category, confidence, importance, namespace, status,
             source_document_ids AS "sourceDocumentIds",
             source_section AS "sourceSection",
             ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', ?)) AS keyword_rank,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', ?)) DESC) AS rank_ix
      FROM fact
      WHERE namespace = ANY(?)
        AND status = 'active'
        AND ${CONFIDENCE_CASE} >= ?
        AND to_tsvector('english', content) @@ plainto_tsquery('english', ?)
        ${temporalClause}
        ${categoryClause}
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
             COALESCE(s.similarity, 0) AS similarity,
             (
               ${VECTOR_WEIGHT} * (1.0 / (${RRF_K} + COALESCE(s.rank_ix, ?)))
             + ${KEYWORD_WEIGHT} * (1.0 / (${RRF_K} + COALESCE(k.rank_ix, ?)))
             ) AS rrf_raw
      FROM semantic s
      FULL OUTER JOIN keyword k ON s.id = k.id
    )
    SELECT id, uid, content, category, confidence, importance, namespace, status,
           "sourceDocumentIds", "sourceSection", similarity,
           rrf_raw
    FROM fused
    ORDER BY rrf_raw DESC,
             CASE WHEN importance = 'vital' THEN 0 ELSE 1 END
    LIMIT ?
  `;

  const params = [...semanticParams, ...keywordParams, ...rrfParams];
  const { rows } = await cortexDb.raw(sql, params);

  if (!rows.length) return [];

  const maxScore = rows[0].rrf_raw || 1;
  return rows.map((r) => ({
    ...r,
    rrfScore: Math.round((r.rrf_raw / maxScore) * 100) / 100,
  }));
}

export { hybridSearchFacts };
