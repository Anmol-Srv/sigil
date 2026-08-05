// Project-namespace isolation — a query in one project must not inject facts
// from another project. Run against real embeddings so the namespace wall is
// tested as a hard boundary, not a mock.
//
// Strongest assertion: search project A for project B's content — B's facts
// must NOT appear even though they're the relevant match. That proves the
// namespace is a wall, not a ranking nudge. Plus the empty-namespace fix: []
// means "nothing", not "global".

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('namespace isolation (real embeddings)', () => {
  let ctx;
  const projectA = 'project:auth-service';
  const projectB = 'project:recipe-app';
  const aIds = [];
  const bIds = [];

  beforeAll(async () => {
    ctx = await createReliabilityContext();

    // Project A: authentication domain.
    for (const content of [
      'The login flow issues JWT access tokens signed with RS256.',
      'User sessions expire after 30 minutes of inactivity.',
      'Password reset links are single-use and valid for one hour.',
    ]) {
      const r = await ctx.seedFact({ content, namespace: projectA });
      aIds.push(r.factId);
    }

    // Project B: cooking domain — deliberately unrelated to A.
    for (const content of [
      'Sourdough bread needs a 24 hour cold ferment in the fridge.',
      'Sear the steak at high heat to build a crust before resting it.',
      'Caramelizing onions takes about 40 minutes on low heat.',
    ]) {
      const r = await ctx.seedFact({ content, namespace: projectB });
      bIds.push(r.factId);
    }
  });

  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('in namespace A, a B-topic query never returns B facts (namespace is a wall)', async () => {
    // Ask about B's content in namespace A. Without floor so we see whatever
    // is in scope — the point is that NO B fact leaks in.
    const r = await ctx.doSearch('how do I sear a steak for a good crust', {
      namespaces: [projectA], applyFloor: false, limit: 10,
    });
    const returned = r.facts.map((f) => f.id);
    for (const bId of bIds) expect(returned).not.toContain(bId);
  });

  it('the same B-topic query finds B facts in namespace B', async () => {
    const r = await ctx.doSearch('how do I sear a steak for a good crust', {
      namespaces: [projectB], applyFloor: false, limit: 10,
    });
    const returned = r.facts.map((f) => f.id);
    expect(returned.some((id) => bIds.includes(id))).toBe(true);
    for (const aId of aIds) expect(returned).not.toContain(aId);
  });

  it('empty namespaces [] returns nothing (not the whole brain)', async () => {
    const r = await ctx.doSearch('authentication login session', {
      namespaces: [], applyFloor: false, limit: 10,
    });
    expect(r.facts).toHaveLength(0);
  });

  it('an on-topic A query in namespace A returns A facts', async () => {
    const r = await ctx.doSearch('how does login and token signing work', {
      namespaces: [projectA], applyFloor: false, limit: 10,
    });
    const returned = r.facts.map((f) => f.id);
    expect(returned.some((id) => aIds.includes(id))).toBe(true);
  });
});
