/**
 * Format a numeric array as a pgvector-compatible string literal.
 * Centralizes the `[1,2,3]` formatting used across all stores and search modules.
 */
function pgVector(arr) {
  if (!arr) return null;
  return `[${arr.join(',')}]`;
}

export { pgVector };
