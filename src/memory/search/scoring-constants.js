/**
 * Hybrid-search ranking constants, shared by the JS-side merge (`hybrid.js`)
 * and the SQL-side merge (`hybrid-sql.js`) so the two paths can never drift.
 */

// Reciprocal-rank-fusion constant.
// K=20 gives good score spread for our result set sizes (5-50).
// K=60 (original paper) compresses scores into a ~0.001 band with small sets.
export const RRF_K = 20;

// Vector results get higher weight — better for semantic/natural language queries.
export const VECTOR_WEIGHT = 1.0;
export const KEYWORD_WEIGHT = 0.7;
