// End-to-end memory loop — the whole point of the product in one test:
// capture facts, then have the RIGHT ones (and only the right ones) come back
// for a later prompt. Exercises the real path embed → store → vector search →
// scope → floor → retrieve, exactly as the UserPromptSubmit hook drives it
// (podScope:'auto'-equivalent + applyFloor:true).
//
// Note: a true subprocess-level hook test (spawn node dist/hooks/... with stdin)
// needs a separately-connectable Postgres, so it lives in the Docker tier;
// in-process PGlite can't be reached by a child process. This covers the
// memory-loop contract the hook depends on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('e2e memory loop (capture → scoped+floored recall)', () => {
  let ctx;
  let projectPod;

  beforeAll(async () => {
    ctx = await createReliabilityContext();
    projectPod = await ctx.seedPod({ type: 'project', externalId: '/proj/billing-service' });

    // Things "learned" while working in the billing service.
    for (const content of [
      'Stripe webhooks burned us on April 23 — signatures were not verified.',
      'We moved off Redis to Postgres LISTEN/NOTIFY for the job queue.',
      'Invoices are finalized in a single transaction with a row-level lock.',
    ]) {
      await ctx.seedFact({ content, podUid: projectPod.uid });
    }
    // A fact from an unrelated project (no billing pod).
    await ctx.seedFact({ content: 'The marketing site is built with Astro and deployed to Netlify.' });
  });

  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('an on-topic prompt recalls the captured billing facts (scoped + floored)', async () => {
    const r = await ctx.doSearch('what went wrong with our stripe webhooks', {
      podScope: [projectPod.uid], applyFloor: true, limit: 10,
    });
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.facts.some((f) => /stripe/i.test(f.content))).toBe(true);
    // No leak from the unrelated project.
    expect(r.facts.some((f) => /astro|netlify/i.test(f.content))).toBe(false);
  });

  it('an off-topic prompt in this project injects nothing (no noise in the window)', async () => {
    const r = await ctx.doSearch('what is the capital of France', {
      podScope: [projectPod.uid], applyFloor: true, limit: 10,
    });
    expect(r.facts).toHaveLength(0);
  });
});
