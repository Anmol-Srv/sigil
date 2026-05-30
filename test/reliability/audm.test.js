// AUDM dedup — does the memory actually avoid storing the same thing twice,
// and not falsely merge distinct things? Tested on REAL embeddings with the
// default thresholds (skip 0.88 / ambiguous 0.78). Identical content is a
// deterministic similarity of ~1.0 → SKIP; clearly distinct content has no
// candidate above the recall floor → ADD.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('AUDM dedup (real embeddings, default thresholds)', () => {
  let ctx;
  const factCount = async () => Number((await ctx.db('fact').count({ c: '*' }))[0].c);

  beforeAll(async () => { ctx = await createReliabilityContext(); });
  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('a brand-new fact is ADDed', async () => {
    const r = await ctx.seedFact({ content: 'The CI pipeline runs lint, then unit tests, then the build.' });
    expect(r.action).toBe('ADD');
  });

  it('re-saving identical content is SKIPped (no duplicate row)', async () => {
    const before = await factCount();
    const r = await ctx.seedFact({ content: 'The CI pipeline runs lint, then unit tests, then the build.' });
    expect(r.action).toBe('SKIP');
    expect(await factCount()).toBe(before);
  });

  it('a clearly-distinct fact is ADDed (no false merge)', async () => {
    const before = await factCount();
    const r = await ctx.seedFact({ content: 'The office coffee machine is on the third floor by the windows.' });
    expect(r.action).toBe('ADD');
    expect(await factCount()).toBe(before + 1);
  });
});
