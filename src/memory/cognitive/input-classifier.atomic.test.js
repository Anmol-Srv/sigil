// `remember` hands the classifier one short self-contained statement — it
// rejects anything document-shaped before we get here. For that input the
// knowledge route is three wasted LLM calls that re-derive the sentence we were
// given, and the extractor is free to REWORD a fact the user asked to store as
// written. These pin the coercion, and the ways it must not lose the input.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const promptJson = vi.fn();
vi.mock('../../lib/llm.js', () => ({ promptJson: (...a) => promptJson(...a) }));

let classifyInput;
beforeEach(async () => {
  promptJson.mockReset();
  ({ classifyInput } = await import('./input-classifier.js'));
});
afterEach(() => { vi.restoreAllMocks(); });

const INPUT = 'Sigil stores facts in PGlite, a single-connection embedded Postgres';
const THOUGHT_FACT = { content: INPUT, category: 'architecture', confidence: 'high', importance: 'vital' };

describe('classifyInput — atomic callers', () => {
  it('coerces a knowledge verdict to thought', async () => {
    // The classifier calls any technical sentence "knowledge"; for a one-liner
    // that means chunk → contextualize → extract to get the same sentence back.
    promptJson.mockResolvedValue({ route: 'knowledge', facts: [], entities: [], reasoning: 'technical' });
    const r = await classifyInput(INPUT, { atomic: true });
    expect(r.route).toBe('thought');
  });

  it('stores the caller\'s own text when the coerced verdict carried no facts', async () => {
    // A thought route with zero facts stores NOTHING — the save would silently
    // vanish. The input IS the fact, so use it.
    promptJson.mockResolvedValue({ route: 'knowledge', facts: [], entities: [], reasoning: 'technical' });
    const r = await classifyInput(INPUT, { atomic: true });
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].content).toBe(INPUT);
  });

  it('keeps the classifier\'s own atomic facts when it produced them', async () => {
    // Splitting "X and Y" into two facts is real work only the LLM can do.
    promptJson.mockResolvedValue({ route: 'thought', facts: [THOUGHT_FACT, { ...THOUGHT_FACT, content: 'second' }], entities: [] });
    const r = await classifyInput(INPUT, { atomic: true });
    expect(r.facts.map((f) => f.content)).toEqual([INPUT, 'second']);
  });

  it('still lets noise through as noise', async () => {
    // Coercion is knowledge → thought only. An agent saving "ok thanks" should
    // still be dropped.
    promptJson.mockResolvedValue({ route: 'noise', facts: [], entities: [], reasoning: 'greeting' });
    expect((await classifyInput(INPUT, { atomic: true })).route).toBe('noise');
  });

  it('never loses the input when the LLM fails outright', async () => {
    // Non-atomic callers fall back to `knowledge` and let the pipeline extract.
    // An atomic caller has no pipeline to fall back to — it must store the text.
    promptJson.mockRejectedValue(new Error('provider down'));
    const r = await classifyInput(INPUT, { atomic: true });
    expect(r.route).toBe('thought');
    expect(r.facts[0].content).toBe(INPUT);
  });

  it('never loses the input when the LLM returns a garbage route', async () => {
    promptJson.mockResolvedValue({ route: 'banana', facts: [] });
    const r = await classifyInput(INPUT, { atomic: true });
    expect(r.facts[0].content).toBe(INPUT);
  });
});

describe('classifyInput — everyone else is unchanged', () => {
  it('leaves the knowledge route alone for ordinary callers', async () => {
    promptJson.mockResolvedValue({ route: 'knowledge', facts: [], entities: [], reasoning: 'technical' });
    const r = await classifyInput(INPUT, {});
    expect(r.route).toBe('knowledge');
    expect(r.facts).toEqual([]);
  });

  it('still falls back to knowledge on an LLM failure for ordinary callers', async () => {
    promptJson.mockRejectedValue(new Error('provider down'));
    expect((await classifyInput(INPUT, {})).route).toBe('knowledge');
  });

  it('keeps the long-content heuristic ahead of any coercion', async () => {
    // A caller that mislabels a 5 KB blob as atomic must not get it stored as
    // one giant "fact" — the length gate runs first and is not LLM-dependent.
    const r = await classifyInput('x'.repeat(3000), { atomic: true });
    expect(r.route).toBe('knowledge');
    expect(promptJson).not.toHaveBeenCalled();
  });
});
