// Scope isolation — THE bug class this whole effort started from: a query in
// one project leaking facts from another (the "Maya Iyer payment webhooks in a
// gstack session" injection). Run against real embeddings so the scope wall is
// tested as a hard boundary, not a mock.
//
// Strongest assertion: scope to project A, ask about project B's content — B's
// facts must NOT appear even though they're the relevant match. That proves
// pod scope is a wall, not a ranking nudge. Plus the empty-scope fix: [] means
// "nothing", not "global".

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('scope isolation (real embeddings)', () => {
  let ctx;
  let podA;
  let podB;
  const aIds = [];
  const bIds = [];

  beforeAll(async () => {
    ctx = await createReliabilityContext();

    podA = await ctx.seedPod({ type: 'project', externalId: '/proj/auth-service' });
    podB = await ctx.seedPod({ type: 'project', externalId: '/proj/recipe-app' });

    // Project A: authentication domain.
    for (const content of [
      'The login flow issues JWT access tokens signed with RS256.',
      'User sessions expire after 30 minutes of inactivity.',
      'Password reset links are single-use and valid for one hour.',
    ]) {
      const r = await ctx.seedFact({ content, podUid: podA.uid });
      aIds.push(r.factId);
    }

    // Project B: cooking domain — deliberately unrelated to A.
    for (const content of [
      'Sourdough bread needs a 24 hour cold ferment in the fridge.',
      'Sear the steak at high heat to build a crust before resting it.',
      'Caramelizing onions takes about 40 minutes on low heat.',
    ]) {
      const r = await ctx.seedFact({ content, podUid: podB.uid });
      bIds.push(r.factId);
    }
  });

  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('scoped to A, a B-topic query never returns B facts (scope is a wall)', async () => {
    // Ask about B's content while scoped to A. Without floor so we see whatever
    // is in scope — the point is that NO B fact leaks in.
    const r = await ctx.doSearch('how do I sear a steak for a good crust', {
      podScope: [podA.uid], applyFloor: false, limit: 10,
    });
    const returned = r.facts.map((f) => f.id);
    for (const bId of bIds) expect(returned).not.toContain(bId);
  });

  it('the same B-topic query DOES find B facts when scoped to B (scope works both ways)', async () => {
    const r = await ctx.doSearch('how do I sear a steak for a good crust', {
      podScope: [podB.uid], applyFloor: false, limit: 10,
    });
    const returned = r.facts.map((f) => f.id);
    expect(returned.some((id) => bIds.includes(id))).toBe(true);
    for (const aId of aIds) expect(returned).not.toContain(aId);
  });

  it('empty scope [] returns NOTHING (not the whole brain — the SQL leak fix)', async () => {
    const r = await ctx.doSearch('authentication login session', {
      podScope: [], applyFloor: false, limit: 10,
    });
    expect(r.facts).toHaveLength(0);
  });

  it('an on-topic A query scoped to A returns A facts', async () => {
    const r = await ctx.doSearch('how does login and token signing work', {
      podScope: [podA.uid], applyFloor: false, limit: 10,
    });
    const returned = r.facts.map((f) => f.id);
    expect(returned.some((id) => aIds.includes(id))).toBe(true);
  });
});
