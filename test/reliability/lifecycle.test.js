// Lifecycle reliability — two properties that protect against stale memory:
//   1. ACT-R recency: between two equally-relevant facts, the more recently
//      accessed one ranks higher (the decay signal actually fires on real
//      data, not just in a mocked SQL string).
//   2. Superseded facts are invisible to retrieval — once a fact is retired
//      (re-ingest / contradiction), it never surfaces in search again.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('lifecycle (real embeddings)', () => {
  let ctx;

  beforeAll(async () => { ctx = await createReliabilityContext(); });
  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('a superseded fact never appears in search results', async () => {
    const r = await ctx.seedFact({ content: 'The staging database lives in the eu-west-1 region.' });
    // Retire it (what re-ingest / contradiction does under the hood).
    await ctx.store.markSuperseded(r.factId, null);

    const res = await ctx.doSearch('which region is the staging database in', {
      podScope: null, applyFloor: false, limit: 10,
    });
    expect(res.facts.map((f) => f.id)).not.toContain(r.factId);
  });

  it('ACT-R activation decays with age (fresh fact has higher activation than a stale one)', async () => {
    // Two DISTINCT facts (so AUDM doesn't merge them) that both match a broad
    // monitoring query. Age one by 120 days. The ACT-R activation is a pure
    // function of access-count + recency (independent of cosine), so the fresh
    // fact's activation must exceed the stale one's — the decay signal firing
    // for real, not just in a mocked SQL string.
    const stale = await ctx.seedFact({
      content: 'Grafana serves the metrics dashboard for the team.',
      agedDays: 120,
    });
    const fresh = await ctx.seedFact({
      content: 'Prometheus scrapes service metrics every 15 seconds.',
    });

    const res = await ctx.doSearch('metrics monitoring grafana prometheus', {
      podScope: null, applyFloor: false, limit: 10,
    });
    const byId = Object.fromEntries(res.facts.map((f) => [f.id, f]));
    const freshFact = byId[fresh.factId];
    const staleFact = byId[stale.factId];

    expect(freshFact).toBeDefined();
    expect(staleFact).toBeDefined();
    expect(Number(freshFact.activation)).toBeGreaterThan(Number(staleFact.activation));
  });
});
