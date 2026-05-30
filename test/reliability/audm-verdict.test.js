// AUDM verdict plumbing — when a new fact lands in the ambiguous zone, the LLM
// judge's verdict (UPDATE / CONTRADICT) must actually rewire the fact graph:
// UPDATE supersedes the old row, CONTRADICT marks it contradicted, both with a
// history trail. Real embeddings put related facts in the zone; the LLM is
// stubbed so we test the PLUMBING deterministically (the judge's quality is a
// separate eval). Thresholds are widened so any related pair triggers the
// judge (set before any import so config reads them).

process.env.MEMORY_SKIP_THRESHOLD = '0.999';
process.env.MEMORY_AMBIGUOUS_THRESHOLD = '0.40';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('AUDM verdict plumbing (forced ambiguous + stubbed judge)', () => {
  let ctx;
  const factById = async (id) => (await ctx.db('fact').where({ id }).first());
  const historyFor = async (id, event) =>
    ctx.db('history').where({ targetType: 'fact', targetId: id, event });

  beforeAll(async () => { ctx = await createReliabilityContext(); });
  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('UPDATE verdict supersedes the prior fact + writes history', async () => {
    ctx.llmPrompt.mockResolvedValue('UPDATE');
    const base = await ctx.seedFact({ content: 'The API rate limit is 100 requests per minute.' });
    const next = await ctx.seedFact({ content: 'The API now allows 200 requests per minute before throttling.' });

    expect(next.action).toBe('UPDATE');
    const old = await factById(base.factId);
    expect(old.status).toBe('superseded');
    expect(old.supersededById).toBe(next.factId);
    expect((await historyFor(base.factId, 'UPDATE')).length).toBe(1);
  });

  it('CONTRADICT verdict marks the prior fact contradicted + writes history', async () => {
    ctx.llmPrompt.mockResolvedValue('CONTRADICT');
    const base = await ctx.seedFact({ content: 'Deploys go out every Friday afternoon.' });
    const next = await ctx.seedFact({ content: 'We never deploy on Fridays; releases are Tuesday mornings.' });

    expect(next.action).toBe('CONTRADICT');
    const old = await factById(base.factId);
    expect(old.status).toBe('contradicted');
    expect(old.contradictedById).toBe(next.factId);
    expect((await historyFor(base.factId, 'CONTRADICT')).length).toBe(1);
  });
});
