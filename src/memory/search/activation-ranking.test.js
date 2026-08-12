// The observed failure: searching "prefers short crisp explanations" on a real
// store returned a payment-sync design doc at #1 — cosine 0.43 — ahead of the
// near-verbatim preference fact at 0.76, because the doc had been read 15 times
// during unrelated work while the preference had been read once.
//
// Two defects combined to produce it, and both are pinned here:
//
//   1. The decay term `-0.5*ln(t_days)` is only decay for t > 1. Floored at
//      0.01 it paid a flat +2.30 BONUS, and since retrieval refreshes
//      last_accessed_at, every fact a search touched immediately qualified.
//      Recency stopped discriminating and activation became raw frequency.
//   2. Activation multiplied the fused score outright, giving frequency a
//      wider dynamic range (1.91x) than relevance (1.75x).
//
// These are arithmetic properties of the scoring expression, so they're tested
// as arithmetic — against real Postgres, evaluating the real SQL, because the
// bug lived in an operator's sign and not in any JS.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

import { ACTIVATION_WEIGHT, ACTIVATION_MIN_AGE_DAYS } from './scoring-constants.js';

let pg;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
});

afterAll(async () => {
  await pg?.close();
});

/**
 * Evaluate the shipped activation expression for a fact accessed `uses` times,
 * `ageDays` ago. Mirrors hybrid-sql.js exactly — if that SQL changes without
 * this changing, the assertions below stop describing the product.
 */
async function activation(uses, ageDays) {
  const res = await pg.query(`
    SELECT ln(1.0 + exp(
      ln($1::numeric + 1.0)
      - 0.5 * ln(GREATEST($2::numeric, ${ACTIVATION_MIN_AGE_DAYS}))
    )) AS activation
  `, [uses, ageDays]);
  return Number(res.rows[0].activation);
}

const score = (rrf, act) => rrf * (1 + ACTIVATION_WEIGHT * act);

describe('the decay term is decay, never a bonus', () => {
  it('does not reward a fact for having just been retrieved', async () => {
    // The exact regression: a fact read moments ago used to collect +2.30 for
    // nothing but being fresh, and search itself made it fresh.
    const justRead = await activation(1, 0.001);
    const dayOld = await activation(1, 1.0);
    expect(justRead).toBeCloseTo(dayOld, 6);
  });

  it('never exceeds the no-decay ceiling of ln(uses+1)', async () => {
    // softplus(x) > x always, so compare against softplus of the undecayed
    // value: the point is that the decay term contributes <= 0, not that
    // softplus is the identity.
    for (const [uses, age] of [[1, 0.001], [15, 0.01], [29, 0.5], [4, 1.0]]) {
      const ceiling = Math.log(1 + Math.exp(Math.log(uses + 1)));
      expect(await activation(uses, age)).toBeLessThanOrEqual(ceiling + 1e-9);
    }
  });

  it('still decays a genuinely stale fact below a fresh one', async () => {
    // Flooring at one day must not flatten decay altogether — an equally-used
    // fact untouched for a month should rank below one touched yesterday.
    expect(await activation(10, 30)).toBeLessThan(await activation(10, 1));
  });
});

describe('relevance outranks access count', () => {
  it('puts a near-exact match above a much-read weak match', async () => {
    // Numbers taken from the real ranking table that exposed this.
    //   payment doc:  cosine 0.4327, RRF 0.0353, 15 uses  → was #1
    //   preference:   cosine 0.7550, RRF 0.0616,  3 uses  → was #5
    const paymentDoc = score(0.0353, await activation(15, 0.01));
    const preference = score(0.0616, await activation(3, 0.01));
    expect(preference).toBeGreaterThan(paymentDoc);
  });

  it('rescues even the single-use preference from the bottom half', async () => {
    //   "Anmol prefers short, crisp explanations": RRF 0.0575, 1 use → was #8
    //   "Landing page 185":                        RRF 0.0443, 29 uses → was #2
    const crisp = score(0.0575, await activation(1, 0.01));
    const landing = score(0.0443, await activation(29, 0.01));
    expect(crisp).toBeGreaterThan(landing);
  });

  it('keeps frequency as a tiebreaker when relevance is equal', async () => {
    // Bounding activation must not neuter it — that would throw away the
    // signal ACT-R exists to provide.
    const RRF = 0.05;
    const hot = score(RRF, await activation(20, 1));
    const cold = score(RRF, await activation(0, 1));
    expect(hot).toBeGreaterThan(cold);
  });

  it('holds frequency to a narrower range than relevance', async () => {
    // The structural property behind every assertion above: across the full
    // spread of access counts seen on a real store (0..29), the activation
    // multiplier must vary less than RRF does across the observed similarity
    // range. Otherwise how often a fact was read decides the ordering.
    const lo = 1 + ACTIVATION_WEIGHT * (await activation(0, 1));
    const hi = 1 + ACTIVATION_WEIGHT * (await activation(29, 1));
    const activationSpread = hi / lo;
    const rrfSpread = 0.0616 / 0.0353; // observed: 1.75x

    expect(activationSpread).toBeLessThan(rrfSpread);
  });
});
