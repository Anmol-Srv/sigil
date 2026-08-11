// The batch matcher replaces N sequential yes/no calls with one merge plan.
// The speedup is the easy part; the risk is that a model's malformed answer
// silently FUSES two unrelated things in the user's memory. Everything below
// pins the direction we fail in: drop the decision, create a new entity.

import { describe, it, expect } from 'vitest';

import { buildPrompt, parsePlan } from './batch-matcher.js';

const MENTIONS = [
  { name: 'Sigil', entityType: 'product', candidates: [{ id: 7, name: 'Smara', types: ['product'], similarity: 0.41 }] },
  { name: 'PGlite', entityType: 'tool', candidates: [] },
];

const plan = (decisions, mentions = MENTIONS) => parsePlan(JSON.stringify({ decisions }), mentions);

describe('buildPrompt', () => {
  it('offers each mention only its own candidates', () => {
    const p = buildPrompt(MENTIONS, 'Smara is now named Sigil.');
    expect(p).toContain('id 7: "Smara"');
    expect(p).toContain('"Sigil" (type: product)');
    expect(p).toContain('"PGlite" (type: tool)');
  });

  it('carries the source passage — it is the only rename signal there is', () => {
    // "Smara" and "Sigil" are vector-distant strings; without the sentence
    // saying so, no amount of similarity reveals the rename.
    expect(buildPrompt(MENTIONS, 'Smara is now named Sigil.')).toContain('Smara is now named Sigil.');
  });

  it('says "none" rather than leaving an empty list the model can misread', () => {
    expect(buildPrompt([MENTIONS[1]], 'x')).toContain('(none)');
  });

  it('caps the passage so one long episode cannot blow the prompt', () => {
    const p = buildPrompt(MENTIONS, 'x'.repeat(50_000));
    expect(p.length).toBeLessThan(10_000);
  });
});

describe('parsePlan — accepting good answers', () => {
  it('reads a merge against a stored candidate', () => {
    const m = plan([{ mention: 'Sigil', same_as_id: 7, rename: true, current_name: 'Sigil', reason: 'renamed' }]);
    expect(m.get('Sigil')).toMatchObject({ sameAsId: 7, rename: true, currentName: 'Sigil' });
  });

  it('reads a merge against a sibling mention in the same batch', () => {
    // The whole reason batching beats the per-pair path: this decision is not
    // expressible when you only ever compare one mention to one stored row.
    const m = plan([{ mention: 'PGlite', same_as_id: null, same_as_mention: 'Sigil', rename: false }]);
    expect(m.get('PGlite')).toMatchObject({ sameAsMention: 'Sigil', sameAsId: null });
  });

  it('reads "new entity" as null on both axes', () => {
    const m = plan([{ mention: 'PGlite', same_as_id: null, same_as_mention: null, rename: false }]);
    expect(m.get('PGlite')).toMatchObject({ sameAsId: null, sameAsMention: null, rename: false });
  });
});

describe('parsePlan — refusing bad answers', () => {
  it('drops an id the mention was never offered', () => {
    // A hallucinated id is a merge into an arbitrary unrelated entity.
    expect(plan([{ mention: 'Sigil', same_as_id: 999, rename: false }]).get('Sigil').sameAsId).toBeNull();
  });

  it('drops a candidate id that belongs to a DIFFERENT mention', () => {
    // Candidates are per-mention; borrowing another's id is the same bug.
    expect(plan([{ mention: 'PGlite', same_as_id: 7, rename: false }]).get('PGlite').sameAsId).toBeNull();
  });

  it('ignores a decision for a mention that is not in the batch', () => {
    expect(plan([{ mention: 'Invented', same_as_id: 7, rename: false }])).toBeNull();
  });

  it('refuses a self-reference', () => {
    expect(plan([{ mention: 'Sigil', same_as_mention: 'Sigil', rename: false }]).get('Sigil').sameAsMention).toBeNull();
  });

  it('refuses a sibling reference to a mention that is not in the batch', () => {
    expect(plan([{ mention: 'Sigil', same_as_mention: 'Nowhere', rename: false }]).get('Sigil').sameAsMention).toBeNull();
  });

  it('prefers the stored candidate when the model answers both', () => {
    const d = plan([{ mention: 'Sigil', same_as_id: 7, same_as_mention: 'PGlite', rename: false }]).get('Sigil');
    expect(d).toMatchObject({ sameAsId: 7, sameAsMention: null });
  });

  it('never reports a rename without something to rename INTO', () => {
    // rename:true with no target used to be actionable-looking nonsense.
    expect(plan([{ mention: 'Sigil', same_as_id: null, rename: true, current_name: 'Sigil' }]).get('Sigil').rename).toBe(false);
  });
});

describe('parsePlan — falling back', () => {
  it('returns null on unparseable output so the caller uses the per-pair path', () => {
    expect(parsePlan('I think they are the same!', MENTIONS)).toBeNull();
    expect(parsePlan('{"decisions": "nope"}', MENTIONS)).toBeNull();
    expect(parsePlan(undefined, MENTIONS)).toBeNull();
  });

  it('digs the object out of a markdown fence', () => {
    const raw = '```json\n{"decisions":[{"mention":"Sigil","same_as_id":7,"rename":false}]}\n```';
    expect(parsePlan(raw, MENTIONS).get('Sigil').sameAsId).toBe(7);
  });

  it('returns null when every decision was dropped, rather than an empty plan', () => {
    // An empty map would read as "all new" — a real answer. It isn't one.
    expect(plan([{ mention: 'ghost', same_as_id: 1 }])).toBeNull();
  });
});
