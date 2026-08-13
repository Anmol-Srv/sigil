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

// ACT-R base-level decay floor, in days.
//
// The decay term is `-0.5*ln(t_days)`, which is only decay for t > 1. Below
// that it flips sign and becomes a BONUS — at the old 0.01 floor it added a
// flat +2.30 to activation. Because retrieval itself bumps last_accessed_at,
// every fact returned by a search immediately sat at that floor, so the term
// stopped discriminating entirely and activation collapsed to raw frequency.
// Anderson's formulation assumes t is large in its native units; expressing t
// in days is what exposes the sub-1 region. Flooring at one full day keeps the
// term in [-inf, 0] where it belongs.
export const ACTIVATION_MIN_AGE_DAYS = 1.0;

// How much activation is allowed to move the fused relevance score.
//
// Activation used to multiply RRF directly, which handed frequency a wider
// dynamic range than relevance: on a real store, access counts spanned 1.91x
// while RRF spanned 1.75x, so a fact with 29 uses outranked a near-exact
// semantic match with 1 use. Frequency is a tiebreaker, not the signal.
// `(1 + w*activation)` keeps the ordering influence but bounds it.
//
// w is set from the spread it produces, not by feel. Across 0..29 uses
// (the range on a real store) the multiplier spans (1+w*3.434)/(1+w*0.693):
//
//   w=0.15 → 1.37x   still flips a 30% relevance gap — not a tiebreaker
//   w=0.10 → 1.26x   flips only within ~25%
//   w=0.05 → 1.13x   effectively inert
//
// 0.10 is the largest value at which the observed misranking cannot recur:
// the weakest preference fact in that table led its rival on relevance by
// 1.30x, which must survive a 29-vs-1 access-count deficit.
export const ACTIVATION_WEIGHT = 0.10;
