// Deterministic direct-memory writes — preserve the fact-store guarantee on
// the same PGlite schema used in production. Similar-looking statements must
// remain independent; only a normalized exact repeat in the same namespace is
// known already.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('deterministic fact storage (real PGlite + embeddings)', () => {
  let ctx;
  const namespace = 'project:ci-service';

  beforeAll(async () => { ctx = await createReliabilityContext(); });
  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('skips only a normalized exact repeat in the same namespace', async () => {
    const content = 'The CI pipeline runs lint before unit tests.';
    const first = await ctx.seedFact({ content, namespace });
    const duplicate = await ctx.seedFact({ content: `  ${content.toUpperCase()}  `, namespace });

    expect(first.action).toBe('ADD');
    expect(duplicate.action).toBe('SKIP');
    expect(duplicate.factId).toBe(first.factId);
    const [{ count }] = await ctx.db('fact').where({ namespace, status: 'active' }).count('id as count');
    expect(Number(count)).toBe(1);
  });

  it('keeps a distinct statement and a separate namespace', async () => {
    const distinct = await ctx.seedFact({
      content: 'The CI pipeline uploads coverage after unit tests finish.',
      namespace,
    });
    const sameTextElsewhere = await ctx.seedFact({
      content: 'The CI pipeline runs lint before unit tests.',
      namespace: 'project:docs-site',
    });

    expect(distinct.action).toBe('ADD');
    expect(sameTextElsewhere.action).toBe('ADD');
  });
});
