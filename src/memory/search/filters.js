const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

const CONFIDENCE_CASE = `CASE confidence
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 1
            ELSE 0
          END`;

function buildFactFilters({ minConfidence = 'medium', pointInTime, categories }) {
  const minRank = CONFIDENCE_RANK[minConfidence] ?? 1;
  const params = [minRank];
  let temporalClause = '';
  let categoryClause = '';

  if (pointInTime) {
    temporalClause = 'AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)';
    params.push(pointInTime, pointInTime);
  }

  if (categories?.length) {
    categoryClause = 'AND category = ANY(?)';
    params.push(categories);
  }

  return { minRank, temporalClause, categoryClause, filterParams: params };
}

/**
 * Pod-scope clause for CHUNK queries.
 *
 * Chunks aren't pod members — their DOCUMENT is (pod_membership.member_type =
 * 'document'), so the filter goes through document_id. Without this, chunk
 * retrieval ignored pod scope entirely: attaching a document to a project pod
 * changed nothing at read time and one project's document text could surface
 * while searching another. Facts have had this filter since hybrid-sql.js; this
 * is the chunk-side equivalent, with the same three-state contract.
 *
 *   null  → unscoped (global)
 *   []    → scope requested but nothing active → match nothing
 *   [ids] → restrict to documents in those pods
 */
function buildChunkPodFilter(podIds) {
  if (!Array.isArray(podIds)) return { clause: '', params: [] };
  // Unpodded documents stay visible, matching the fact-side rule in
  // hybrid-sql.js: no membership means "unknown subject", not "someone else's".
  const UNPODDED = `NOT EXISTS (
    SELECT 1 FROM pod_membership pm
    WHERE pm.member_type = 'document' AND pm.member_id = document_id
  )`;
  if (podIds.length === 0) return { clause: `AND ${UNPODDED}`, params: [] };
  return {
    clause: `AND (document_id = ANY(
      SELECT member_id FROM pod_membership
      WHERE member_type = 'document' AND pod_id = ANY(?::int[])
    ) OR ${UNPODDED})`,
    params: [podIds],
  };
}

export { CONFIDENCE_CASE, buildFactFilters, buildChunkPodFilter };
