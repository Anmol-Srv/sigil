const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

const CONFIDENCE_CASE = `CASE confidence
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 1
            ELSE 0
          END`;

// Normalize a device filter value to the integer fact.created_by_device_id key.
// Accepts a number, a numeric string ("3"), or null/undefined (no filter).
// Non-numeric strings (a device *name*) must be resolved to an id by the caller
// before reaching here — this layer only knows the integer FK.
function normalizeDeviceId(deviceId) {
  if (deviceId == null) return null;
  const n = Number(deviceId);
  return Number.isInteger(n) ? n : null;
}

// Build the additive WHERE fragments + ordered params shared by both search
// CTEs. Author predicates (agent / device) are PROVENANCE filters: opt-in,
// never part of the default WHERE. When absent, results are identical to before.
//
// The returned `authorClause` is concatenated AFTER temporal/category in the
// SQL, and its params are appended to `filterParams` in the same order, so the
// existing `[minRank, ...extras]` threading in hybrid-sql.js keeps working.
function buildFactFilters({ minConfidence = 'medium', pointInTime, categories, agent, deviceId } = {}) {
  const minRank = CONFIDENCE_RANK[minConfidence] ?? 1;
  const params = [minRank];
  let temporalClause = '';
  let categoryClause = '';
  let authorClause = '';

  if (pointInTime) {
    temporalClause = 'AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)';
    params.push(pointInTime, pointInTime);
  }

  if (categories?.length) {
    categoryClause = 'AND category = ANY(?)';
    params.push(categories);
  }

  if (agent) {
    authorClause += ' AND created_by_agent = ?';
    params.push(agent);
  }

  const devId = normalizeDeviceId(deviceId);
  if (devId != null) {
    authorClause += ' AND created_by_device_id = ?';
    params.push(devId);
  }

  return { minRank, temporalClause, categoryClause, authorClause, filterParams: params };
}

export { buildFactFilters, CONFIDENCE_CASE, normalizeDeviceId };
