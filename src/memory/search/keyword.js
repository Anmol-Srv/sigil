import cortexDb from '../../db/cortex.js';
import { CONFIDENCE_CASE, buildFactFilters } from './filters.js';

async function searchChunks(query, { namespaces, limit = 20 }) {
  const { rows } = await cortexDb.raw(`
    SELECT id, document_id AS "documentId", chunk_index AS "chunkIndex",
           content, section_heading AS "sectionHeading", namespace,
           ts_rank(search_vector, plainto_tsquery('english', ?)) as rank
    FROM chunk
    WHERE namespace = ANY(?)
      AND search_vector @@ plainto_tsquery('english', ?)
    ORDER BY rank DESC
    LIMIT ?
  `, [query, namespaces, query, limit]);

  return rows;
}

async function searchFacts(query, { namespaces, limit = 20, minConfidence = 'medium', pointInTime, categories }) {
  const { temporalClause, categoryClause, filterParams } = buildFactFilters({ minConfidence, pointInTime, categories });

  const params = [query, namespaces, query, ...filterParams, limit];

  const { rows } = await cortexDb.raw(`
    SELECT id, uid, content, category, confidence, importance, namespace, status,
           source_document_ids AS "sourceDocumentIds",
           source_section AS "sourceSection",
           ts_rank(search_vector, plainto_tsquery('english', ?)) as rank
    FROM fact
    WHERE namespace = ANY(?)
      AND status = 'active'
      AND search_vector @@ plainto_tsquery('english', ?)
      AND ${CONFIDENCE_CASE} >= ?
      ${temporalClause}
      ${categoryClause}
    ORDER BY rank DESC
    LIMIT ?
  `, params);

  return rows;
}

export { searchChunks, searchFacts };
