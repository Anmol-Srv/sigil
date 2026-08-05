// Reliability test context — wires the real ingest/search/store code to an
// in-memory PGlite running the real schema, with real Ollama embeddings.
//
// Usage (in a suite):
//   let ctx;
//   beforeAll(async () => { ctx = await createReliabilityContext(); });
//   afterAll(async () => { await ctx.destroy(); });
//   ...
//   await ctx.seedFact({ content: '...', namespace: 'project:auth' });
//   const r = await ctx.search('query', { namespaces: ['project:auth'] });
//
// The point: fact persistence, embeddings, deterministic hybrid search,
// namespace isolation, and the automatic-recall floor all run for real.

import { vi } from 'vitest';

import { createTestDb, destroyTestDb } from './test-db.js';

export async function createReliabilityContext() {
  const { db, pg } = await createTestDb();

  // Redirect the daemon DB pool to the in-memory test DB. The path is relative
  // to THIS file and resolves to the same module every app file imports.
  vi.doMock('../../../src/db/cortex.js', () => ({ default: db }));

  // Import app code AFTER the mocks so the transitive cortex/llm imports hit
  // the test database. Embedder is the REAL one (Ollama mxbai via setup.js).
  const store = await import('../../../src/memory/facts/store.js');
  const search = await import('../../../src/memory/search/hybrid.js');
  const { embed } = await import('../../../src/ingestion/embedder.js');

  // Seed a single fact with a REAL embedding through the same deterministic
  // direct-memory path used by `sigil remember`.
  async function seedFact({
    content, namespace = 'default', category = 'domain_knowledge',
    confidence = 'high', importance = 'supplementary',
  }) {
    const embedding = await embed(content);
    const res = await store.saveFactDeterministic({
      content, category, confidence, importance, namespace,
      sourceDocumentIds: [], sourceSection: null, embedding,
    });
    const factId = res.fact?.id ?? res.existing?.id ?? null;
    return { ...res, factId };
  }

  // Thin wrappers so suites read clearly.
  const doSearch = (query, opts = {}) =>
    search.search(query, { namespaces: ['default'], ...opts });

  return {
    db, pg, store, search, embed, seedFact, doSearch,
    async destroy() {
      vi.doUnmock('../../../src/db/cortex.js');
      await destroyTestDb({ db, pg });
    },
  };
}
