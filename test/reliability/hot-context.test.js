// Hot-context composition — the always-on top-N snapshot must stay SCOPED to
// the active project and must NOT pad itself with off-project recency (the
// Lane A fix). Uses a real (non-git) cwd → project pod so resolveActiveScope
// finds it for real.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReliabilityContext } from './harness/index.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ready = await ollamaReady();
if (!ready) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = ready ? describe : describe.skip;

suite('hot-context composition (real embeddings)', () => {
  let ctx;
  let projectDir;
  let pod;
  const inPod = [];

  beforeAll(async () => {
    ctx = await createReliabilityContext();
    // Non-git dir → deriveProjectRoot returns the dir itself → pod externalId.
    projectDir = mkdtempSync(join(tmpdir(), 'sigil-hotctx-'));
    pod = await ctx.seedPod({ type: 'project', externalId: projectDir });

    for (const content of [
      'This project uses Drizzle ORM against Postgres 15.',
      'The API layer is Next.js 15 app-router with server components by default.',
    ]) {
      const r = await ctx.seedFact({ content, podUid: pod.uid });
      inPod.push(r.factId);
    }
    // An off-project fact with NO pod and only supplementary importance — must
    // never be backfilled into this project's hot-context.
    await ctx.seedFact({ content: 'Unrelated: the cafeteria serves dosa on Thursdays.' });
  });

  afterAll(async () => { if (ctx) await ctx.destroy(); });

  it('hot-context for the active project surfaces ONLY in-project facts', async () => {
    const facts = await ctx.getHotFacts({ ctx: { cwd: projectDir }, limit: 20 });
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((c) => c.includes('Drizzle') || c.includes('Next.js'))).toBe(true);
    // The off-project supplementary fact must NOT be backfilled in.
    expect(facts.some((c) => c.includes('dosa'))).toBe(false);
  });

  it('factsInPodsByRecency is a hard scope: only the pod\'s facts come back', async () => {
    const rows = await ctx.hotContext.factsInPodsByRecency([pod.uid], 'default', 10);
    expect(rows.length).toBe(inPod.length);
    expect(rows.some((c) => c.includes('dosa'))).toBe(false);
  });
});
