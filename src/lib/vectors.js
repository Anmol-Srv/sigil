import config from '../config.js';

/**
 * Format a numeric array as a pgvector-compatible string literal.
 * Centralizes the `[1,2,3]` formatting used across all stores and search modules.
 */
function pgVector(arr) {
  if (!arr) return null;
  return `[${arr.join(',')}]`;
}

function embeddingDimensions() {
  const dim = Number(config.embedding.dimensions) || 768;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`Invalid EMBEDDING_DIMENSIONS: ${config.embedding.dimensions}`);
  }
  return dim;
}

function pgHalfvecColumn(column = 'embedding') {
  return `(${column}::halfvec(${embeddingDimensions()}))`;
}

function pgHalfvecParam() {
  return `?::halfvec(${embeddingDimensions()})`;
}

export { pgVector, pgHalfvecColumn, pgHalfvecParam };
