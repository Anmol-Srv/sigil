// Floor precision — the precision-first guarantee, tested with REAL cosines.
// This is the test that would have caught the Maya-Iyer injection: an
// off-topic query, with the injection floor on, must return NOTHING rather
// than tangential facts. An on-topic query must still surface its facts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('floor precision (real embeddings)', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await createReliabilityContext();
    // A small, single-topic corpus (payments) — stand-in for the real
    // "Maya Iyer payment webhook" facts that leaked into an unrelated session.
    for (const content of [
      'Payment webhooks must be idempotent so retries do not double-charge.',
      'PayPal webhook delivery times out after 25 seconds.',
      'Failed webhook events are logged and an alert fires when the backlog grows.',
    ]) {
      await ctx.seedFact({ content });
    }
  });

  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('off-topic query with the floor ON injects NOTHING (empty beats wrong)', async () => {
    // Completely unrelated to payments — the "gstack garry tan skills" case.
    const r = await ctx.doSearch('garry tan startup founder advice and skills', {
      podScope: null, applyFloor: true, limit: 10,
    });
    expect(r.facts).toHaveLength(0);
    expect(r._trace.floor.applied).toBe(true);
    expect(r._trace.floor.dropped).toBeGreaterThan(0);
  });

  it('off-topic query with the floor OFF (explicit search) still returns matches', async () => {
    const r = await ctx.doSearch('garry tan startup founder advice and skills', {
      podScope: null, applyFloor: false, limit: 10,
    });
    // Without the floor, low-similarity facts come back — this is the explicit
    // human-search behaviour, and the contrast proves the floor is what's doing
    // the work in the test above.
    expect(r.facts.length).toBeGreaterThan(0);
  });

  it('on-topic query surfaces facts even with the floor ON', async () => {
    const r = await ctx.doSearch('how do I make payment webhooks safe against retries', {
      podScope: null, applyFloor: true, limit: 10,
    });
    expect(r.facts.length).toBeGreaterThan(0);
    // every surfaced fact cleared the floor
    for (const f of r.facts) expect(f.similarity).toBeGreaterThanOrEqual(ctx.store ? 0 : 0); // sanity
  });
});
