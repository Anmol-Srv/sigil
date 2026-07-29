/**
 * One-round-trip fact retrieval: semantic and keyword candidates fused with
 * reciprocal-rank fusion. Ranking depends only on current evidence; it does not
 * join lifecycle counters or mutate future retrieval behavior.
 */
import cortexDb from '../../db/cortex.js';
import { pgHalfvecColumn, pgHalfvecParam, pgVector } from '../../lib/vectors.js';
import { CONFIDENCE_CASE, buildFactFilters } from './filters.js';
import { RRF_K, VECTOR_WEIGHT, KEYWORD_WEIGHT } from './scoring-constants.js';

const OVERFETCH = 3;

export async function hybridSearchFacts(query, queryEmbedding, {
  namespaces,
  limit = 5,
  minConfidence = 'medium',
  pointInTime,
  categories,
}) {
  const vec = pgVector(queryEmbedding);
  const embeddingDistance = `${pgHalfvecColumn('embedding')} <=> ${pgHalfvecParam()}`;
  const { temporalClause, categoryClause, filterParams } = buildFactFilters({
    minConfidence,
    pointInTime,
    categories,
  });
  const overfetchLimit = limit * OVERFETCH;
  const [minRank, ...extraFilters] = filterParams;

  const semanticParams = [
    vec,
    vec,
    namespaces,
    minRank,
    ...extraFilters,
    vec,
    overfetchLimit,
  ];
  const keywordParams = [
    query,
    query,
    namespaces,
    minRank,
    query,
    ...extraFilters,
    overfetchLimit,
  ];
  const fusionParams = [overfetchLimit, overfetchLimit, limit];

  const sql = `
    WITH semantic AS (
      SELECT id, uid, content, category, confidence, importance, namespace, status,
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
      ORDER BY ${embeddingDistance}
      LIMIT ?
    ),
    keyword AS (
      SELECT id, uid, content, category, confidence, importance, namespace, status,
             source_document_ids AS "sourceDocumentIds",
             source_section AS "sourceSection",
             created_by_device_id AS "createdByDeviceId",
             created_by_agent AS "createdByAgent",
             created_at,
             ts_rank_cd(search_vector, plainto_tsquery('english', ?)) AS keyword_rank,
             ROW_NUMBER() OVER (
               ORDER BY ts_rank_cd(search_vector, plainto_tsquery('english', ?)) DESC
             ) AS rank_ix
      FROM fact
      WHERE namespace = ANY(?)
        AND status = 'active'
        AND ${CONFIDENCE_CASE} >= ?
        AND search_vector @@ plainto_tsquery('english', ?)
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
    )
    SELECT id, uid, content, category, confidence, importance, namespace, status,
           "sourceDocumentIds", "sourceSection", "createdByDeviceId", "createdByAgent",
           similarity, rrf_raw
    FROM fused
    ORDER BY rrf_raw DESC,
             CASE WHEN importance = 'vital' THEN 0 ELSE 1 END,
             created_at DESC
    LIMIT ?
  `;

  const { rows } = await cortexDb.raw(sql, [
    ...semanticParams,
    ...keywordParams,
    ...fusionParams,
  ]);
  if (!rows.length) return [];

  const maxScore = Number(rows[0].rrf_raw) || 1;
  return rows.map((row) => ({
    ...row,
    rrfScore: Math.round((Number(row.rrf_raw) / maxScore) * 100) / 100,
  }));
}
