/**
 * Parse a pod's `attrs` column into a plain object.
 *
 * The column is JSONB, so a driver may hand it back either as an already-parsed
 * object or as a raw JSON string. Returns `{}` for null/undefined/invalid input.
 */
export function parseAttrs(attrs) {
  if (!attrs) return {};
  if (typeof attrs === 'object') return attrs;
  try { return JSON.parse(attrs); } catch { return {}; }
}
