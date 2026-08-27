// Reliability test context — wires the real ingest/search/store code to an
// in-memory PGlite running the real schema, with real Ollama embeddings.
//
// Usage (in a suite):
//   let ctx;
//   beforeAll(async () => { ctx = await createReliabilityContext(); });
//   afterAll(async () => { await ctx.destroy(); });
//   ...
//   await ctx.seedFact({ content: '...', podUid });
//   const r = await ctx.search('query', { podScope: [podUid] });
//
// The point: nothing here is mocked except the LLM-judge paths (AUDM-decide,
// classifier, query-router, synthesizer) which are orchestration, not
// retrieval. Vectors, RRF, ACT-R, the scope membership join, the floor — all
// run for real.

import { vi } from 'vitest';

import { createTestDb, destroyTestDb } from './test-db.js';

export async function createReliabilityContext() {
  const { db, pg } = await createTestDb();

  // Redirect the daemon DB pool to the in-memory test DB. The path is relative
  // to THIS file and resolves to the same module every app file imports.
  vi.doMock('../../../src/db/cortex.js', () => ({ default: db }));

  // Stub the LLM wrapper: deterministic, no network. Suites that test AUDM
  // UPDATE/CONTRADICT override prompt() to return the verdict they're
  // exercising. Default 'ADD' keeps distinct seeds distinct.
  const llmPrompt = vi.fn(async () => 'ADD');

  // AUDM's judge calls promptJson, NOT prompt, and expects the batch shape
  // {decisions:[{input_index, candidate_key, action}]} — one entry per offered
  // pair. The old stub returned {}, which every batch read as "0 of N
  // decisions" and threw, so the verdict suites failed for a reason that had
  // nothing to do with what they test. Synthesize a faithful answer from the
  // cases carried in the prompt, still steered by llmPrompt so suites keep
  // setting the verdict the way they always have.
  const promptJson = vi.fn(async (input) => {
    const tail = String(input).split('\n\n').pop();
    let cases;
    try { cases = JSON.parse(tail); } catch { return {}; }
    if (!Array.isArray(cases)) return {};
    const action = String(await llmPrompt()).trim().toUpperCase();
    return {
      decisions: cases.map((c) => ({
        input_index: c.input_index,
        candidate_key: c.candidate_key,
        action,
      })),
    };
  });

  vi.doMock('../../../src/lib/llm.js', () => ({
    prompt: llmPrompt,
    promptJson,
  }));

  // Import app code AFTER the mocks so the transitive cortex/llm imports hit
  // the stubs. Embedder is the REAL one (Ollama nomic via setup.js env).
  const store = await import('../../../src/memory/facts/store.js');
  const search = await import('../../../src/memory/search/hybrid.js');
  const podStore = await import('../../../src/memory/pods/store.js');
  const membership = await import('../../../src/memory/pods/membership.js');
  const pipeline = await import('../../../src/ingestion/pipeline.js');
  const hotContext = await import('../../../src/memory/facts/hot-context.js');
  const { embed } = await import('../../../src/ingestion/embedder.js');

  async function seedPod({ type = 'project', externalId, name, namespace = 'default', attrs = {} }) {
    const { pod } = await podStore.upsertPod({
      podType: type, externalId, name: name || externalId, namespace, attrs, startedAt: new Date(),
    });
    return pod;
  }

  // Seed a single fact with a REAL embedding, optionally attached to a pod and
  // aged (backdates the lifecycle row so ACT-R decay applies). Goes through the
  // real saveFact (real findSimilar / AUDM), so near-duplicate seeds dedupe
  // exactly as production would.
  async function seedFact({
    content, namespace = 'default', category = 'domain_knowledge',
    confidence = 'high', importance = 'supplementary', podUid = null, agedDays = 0,
  }) {
    const embedding = await embed(content);
    const res = await store.saveFact({
      content, category, confidence, importance, namespace,
      sourceDocumentIds: [], sourceSection: null, embedding,
    });
    const factId = res.fact?.id ?? res.existing?.id ?? null;
    if (podUid && factId) {
      const pod = await podStore.findByUid(podUid);
      if (pod) await membership.attachFact(pod.id, factId, 'primary');
    }
    if (agedDays && factId) {
      await db('factLifecycle')
        .insert({ factId, accessCount: 1, lastAccessedAt: db.raw(`NOW() - INTERVAL '${Number(agedDays)} days'`) })
        .onConflict('factId').merge();
    }
    return { ...res, factId };
  }

  // Thin wrappers so suites read clearly.
  const doSearch = (query, opts = {}) =>
    search.search(query, { namespaces: ['default'], route: false, synthesize: false, ...opts });

  return {
    db, pg,
    store, search, podStore, membership, pipeline, hotContext, embed, llmPrompt, promptJson,
    seedPod, seedFact, doSearch,
    getHotFacts: (opts) => hotContext.getHotFacts(opts),
    async destroy() {
      vi.doUnmock('../../../src/db/cortex.js');
      vi.doUnmock('../../../src/lib/llm.js');
      await destroyTestDb({ db, pg });
    },
  };
}
