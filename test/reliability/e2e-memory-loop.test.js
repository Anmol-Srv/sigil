// End-to-end memory loop — the whole point of the product in one test:
// save facts, then have the RIGHT ones (and only the right ones) come back for
// a later prompt. Exercises the real path embed → store → vector search →
// project namespace → floor → retrieve, exactly as UserPromptSubmit recall
// drives it.
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

suite('e2e memory loop (save → namespaced + floored recall)', () => {
  let ctx;
  const billingProject = 'project:billing-service';
  const marketingProject = 'project:marketing-site';

  beforeAll(async () => {
    ctx = await createReliabilityContext();
    // Things "learned" while working in the billing service.
    for (const content of [
      'Stripe webhooks burned us on April 23 — signatures were not verified.',
      'We moved off Redis to Postgres LISTEN/NOTIFY for the job queue.',
      'Invoices are finalized in a single transaction with a row-level lock.',
    ]) {
      await ctx.seedFact({ content, namespace: billingProject });
    }
    // A fact from an unrelated project.
    await ctx.seedFact({ content: 'The marketing site is built with Astro and deployed to Netlify.', namespace: marketingProject });
  });

  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('an on-topic prompt recalls the saved billing facts (namespaced + floored)', async () => {
    const r = await ctx.doSearch('what went wrong with our stripe webhooks', {
      namespaces: [billingProject], applyFloor: true, limit: 10,
    });
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.facts.some((f) => /stripe/i.test(f.content))).toBe(true);
    // No leak from the unrelated project.
    expect(r.facts.some((f) => /astro|netlify/i.test(f.content))).toBe(false);
  });

  it('an off-topic prompt in this project injects nothing (no noise in the window)', async () => {
    const r = await ctx.doSearch('what is the capital of France', {
      namespaces: [billingProject], applyFloor: true, limit: 10,
    });
    expect(r.facts).toHaveLength(0);
  });
});
