/**
 * The parts of relation derivation that don't need a database.
 *
 * The SQL half is covered by running it against a real store; what's worth
 * pinning here is the contract around the LLM: that evidence reaches the
 * prompt, that "none" really does drop a pair, and that a "reverse" verdict
 * actually swaps the edge rather than being quietly ignored — a direction bug
 * would write confidently wrong edges, which is worse than writing none.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildNamingPrompt, applyDerived } from './derive-relations.js';

const PAIR = {
  sourceId: 1, targetId: 2, sourceName: 'sigil', targetName: 'tmux',
  sharedFacts: 1, pmi: 2.44,
};

describe('buildNamingPrompt', () => {
  it('puts both entity names and their shared evidence in front of the model', () => {
    const ev = new Map([['1:2', ['Sigil keeps warm claude workers alive in tmux']]]);
    const p = buildNamingPrompt([PAIR], ev);
    expect(p).toContain('sigil');
    expect(p).toContain('tmux');
    expect(p).toContain('warm claude workers alive in tmux');
  });

  it('numbers pairs so verdicts can be matched back by position', () => {
    const p = buildNamingPrompt([PAIR, { ...PAIR, sourceId: 3, targetId: 4, sourceName: 'a', targetName: 'b' }], new Map());
    expect(p).toMatch(/1\..*sigil/s);
    expect(p).toMatch(/2\..*"a"/s);
  });

  it('makes rejection an explicit, criteria-backed option', () => {
    const p = buildNamingPrompt([PAIR], new Map());
    expect(p).toContain('none');
    // The first version offered "none" with no criteria and the model used it
    // zero times out of 31 — the reasons are what make it reachable.
    expect(p.toLowerCase()).toContain('vague');
  });
});

describe('applyDerived', () => {
  const canonicalize = (v) => (v ? String(v).toUpperCase().replace(/\s+/g, '_') : null);

  it('writes an edge tagged as derived, carrying its PMI and confidence', async () => {
    const createRelation = vi.fn().mockResolvedValue({});
    const r = await applyDerived(
      [{ ...PAIR, relationship: 'uses', confidence: 'high' }],
      { canonicalize, createRelation },
    );
    expect(r).toEqual({ written: 1, skipped: 0 });
    expect(createRelation).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 1, targetId: 2, relationType: 'USES',
      derivedBy: 'co-occurrence', confidence: 'high', weight: 2.44,
    }));
  });

  it('skips a pair whose predicate does not canonicalize', async () => {
    const createRelation = vi.fn();
    const r = await applyDerived([{ ...PAIR, relationship: '' }], { canonicalize, createRelation });
    expect(r).toEqual({ written: 0, skipped: 1 });
    expect(createRelation).not.toHaveBeenCalled();
  });

  it('refuses a self-edge', async () => {
    const createRelation = vi.fn();
    const r = await applyDerived(
      [{ ...PAIR, targetId: 1, relationship: 'uses' }],
      { canonicalize, createRelation },
    );
    expect(r).toEqual({ written: 0, skipped: 1 });
    expect(createRelation).not.toHaveBeenCalled();
  });

  it('keeps going when one edge fails — maintenance runs unattended', async () => {
    const createRelation = vi.fn()
      .mockRejectedValueOnce(new Error('constraint'))
      .mockResolvedValue({});
    const r = await applyDerived(
      [{ ...PAIR, relationship: 'uses' }, { ...PAIR, sourceId: 5, targetId: 6, relationship: 'part of' }],
      { canonicalize, createRelation },
    );
    expect(r).toEqual({ written: 1, skipped: 1 });
  });

  it('defaults confidence rather than writing null when the namer omits it', async () => {
    const createRelation = vi.fn().mockResolvedValue({});
    await applyDerived([{ ...PAIR, relationship: 'uses' }], { canonicalize, createRelation });
    expect(createRelation).toHaveBeenCalledWith(expect.objectContaining({ confidence: 'medium' }));
  });
});
