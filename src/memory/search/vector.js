import cortexDb from '../../db/cortex.js';
import { pgHalfvecColumn, pgHalfvecParam, pgVector } from '../../lib/vectors.js';
import config from '../../config.js';
import { CONFIDENCE_CASE, buildFactFilters, buildChunkPodFilter } from './filters.js';

// Cosine search. The HNSW index is an expression index over embedding::halfvec(N),
// so the query must use the same expression for Postgres to take the ANN path.

async function searchChunks(embedding, { namespaces, limit = 20, podIds = null }) {
  const vec = pgVector(embedding);
  const embeddingDistance = `${pgHalfvecColumn('embedding')} <=> ${pgHalfvecParam()}`;
  const pod = buildChunkPodFilter(podIds);

  const { rows } = await cortexDb.raw(`
    SELECT id, document_id AS "documentId", chunk_index AS "chunkIndex",
           content, section_heading AS "sectionHeading", namespace,
           1 - (${embeddingDistance}) as similarity
    FROM chunk
    WHERE namespace = ANY(?)
      AND embedding IS NOT NULL
      ${pod.clause}
    ORDER BY ${embeddingDistance}
    LIMIT ?
  `, [vec, namespaces, ...pod.params, vec, limit]);

  return rows;
}

async function searchFacts(embedding, { namespaces, limit = 20, minConfidence = 'medium', pointInTime, categories, viewer = null }) {
  const vec = pgVector(embedding);
  const embeddingDistance = `${pgHalfvecColumn('embedding')} <=> ${pgHalfvecParam()}`;
  const { temporalClause, categoryClause, visibilityClause, filterParams } = buildFactFilters({ minConfidence, pointInTime, categories, viewer });

  const params = [vec, namespaces, ...filterParams, vec, config.memory.minFactSimilarity, vec, limit];

  const { rows } = await cortexDb.raw(`
    SELECT id, uid, content, category, confidence, importance, namespace, status,
           source_document_ids AS "sourceDocumentIds",
           source_section AS "sourceSection",
           1 - (${embeddingDistance}) as similarity
    FROM fact
    WHERE namespace = ANY(?)
      AND status = 'active'
      AND embedding IS NOT NULL
      AND ${CONFIDENCE_CASE} >= ?
      ${temporalClause}
      ${categoryClause}
      ${visibilityClause}
      AND 1 - (${embeddingDistance}) >= ?
    ORDER BY ${embeddingDistance}
    LIMIT ?
  `, params);

  return rows;
}

export { searchChunks, searchFacts };
