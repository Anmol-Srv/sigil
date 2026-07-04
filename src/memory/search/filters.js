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

// Owner-scoped read enforcement (P2, refined by P7). Builds the WHERE-clause
// fragment that hides 'private'-kind facts (claude_session, person) created by a
// DIFFERENT owner. The rule, in plain terms — a fact is HIDDEN only when ALL hold:
//   1. it belongs to a pod whose kind visibility is 'private', AND
//   2. its created_by_origin is NOT NULL, AND
//   3. that origin differs from the current owner's origin.
// Everything else stays visible:
//   - shared/public-kind facts (project, playbook, vital) — never gated here.
//   - facts not in any private pod — never gated.
//   - legacy rows with created_by_origin IS NULL (pre-P7) — always visible to
//     everyone; owner-scoping must not hide pre-existing data.
//
// Returns '' (no filter) when enforcement is disabled, when there are no
// private kinds registered, or when the current device id is unknown — in those
// cases the prior global-visibility behaviour is preserved.
//
// The clause references the outer `fact` row via its `id` column, so it can be
// dropped into either the semantic or keyword CTE unchanged. It emits two
// placeholders in order: [currentDeviceId, privateKinds(text[])].
function buildVisibilityClause({ currentDeviceId, privateKinds, scopeEnabled = true } = {}) {
  if (!scopeEnabled || !currentDeviceId || !Array.isArray(privateKinds) || privateKinds.length === 0) {
    return { visibilityClause: '', visibilityParams: [] };
  }

  // P7: scope on `created_by_origin` (TEXT), the stable ownership identity
  // stamped on EVERY write (paired device id or local install UUID). This
  // supersedes the original P2 predicate on `created_by_device_id` — an INTEGER
  // FK only populated for paired devices, which left local CLI/hook writes
  // NULL and therefore let two PEOPLE in one DB see each other's private facts.
  // `created_by_origin` is plain text, so the compare is type-safe and the same
  // value the writer stamped (currentOrigin) is what we filter against here.
  // Legacy rows with created_by_origin IS NULL (pre-P7) stay visible to all.
  const visibilityClause = `
        AND NOT (
          created_by_origin IS NOT NULL
          AND created_by_origin <> ?
          AND id = ANY(
            SELECT pm.member_id
            FROM pod_membership pm
            JOIN pod p ON p.id = pm.pod_id
            WHERE pm.member_type = 'fact'
              AND p.pod_type = ANY(?::text[])
          )
        )`;

  // `currentDeviceId` here carries the ownership ORIGIN (see resolvePrivacyScope
  // → currentOrigin). Bound as text to match the TEXT column.
  return { visibilityClause, visibilityParams: [String(currentDeviceId), privateKinds] };
}

export { CONFIDENCE_CASE, buildFactFilters, buildVisibilityClause };
