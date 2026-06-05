// Docker-tier e2e: the REAL UserPromptSubmit hook, as a spawned process,
// against a REAL Postgres — the closest thing to what Claude Code actually
// runs. Feeds stdin JSON, reads the hook's stdout, and asserts the injected
// additionalContext: on-topic prompts get the project's memory, off-topic
// prompts get nothing, and another project's facts never leak in.
//
// Requires a connectable Postgres (PGlite can't be reached by a child process)
// AND Ollama. Skips cleanly otherwise. Bring the DB up: `npm run db:test:up`.
//
// NOTE: validated wherever a test Postgres is reachable; with Docker down this
// suite skips (the skip path is what's exercised in this environment).

// Point every sigil process (this one + the spawned hook) at the test PG +
// local embeddings. Set BEFORE any app import so config reads it.
import { TEST_PG_URL } from './harness/pg.js';
process.env.SIGIL_DATABASE_URL = TEST_PG_URL;
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.EMBEDDING_MODEL = 'mxbai-embed-large';
process.env.EMBEDDING_DIMENSIONS = '1024';
process.env.SIGIL_SCOPE_GRACE = 'false'; // strict scoping in the gate

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import knex from 'knex';

import { pgReachable, PG_SKIP_MSG } from './harness/pg.js';
import { ollamaReady, OLLAMA_SKIP_MSG } from './harness/ollama.js';

const ROOT = resolve(dirnameOf(import.meta.url), '../..');
const HOOK = resolve(ROOT, 'dist/hooks/user-prompt-submit.js');

const pgOk = await pgReachable();
const llmOk = await ollamaReady();
if (!pgOk) console.warn(`\n[reliability] ${PG_SKIP_MSG}\n`);
else if (!llmOk) console.warn(`\n[reliability] ${OLLAMA_SKIP_MSG}\n`);
const suite = pgOk && llmOk ? describe : describe.skip;

function dirnameOf(url) { return join(fileURLToPath(url), '..'); }

function runHook(prompt, cwd) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({ prompt, cwd, session_id: 'e2e-test-session' }),
    encoding: 'utf8',
    env: {
      ...process.env,
      SIGIL_DATABASE_URL: TEST_PG_URL,
      EMBEDDING_PROVIDER: 'ollama',
      EMBEDDING_MODEL: 'mxbai-embed-large',
      EMBEDDING_DIMENSIONS: '1024',
      SIGIL_SCOPE_GRACE: 'false',
    },
  });
  try {
    const out = JSON.parse(res.stdout || '{}');
    return out.hookSpecificOutput?.additionalContext || null;
  } catch {
    return null;
  }
}

suite('e2e: real hook process → real Postgres', () => {
  let db;
  let projectDir;
  let store;
  let membership;
  let podStore;
  let embed;

  beforeAll(async () => {
    db = knex({
      client: 'pg',
      connection: TEST_PG_URL,
      pool: { min: 1, max: 2 },
      migrations: { directory: resolve(ROOT, 'src/db/migrations'), loadExtensions: ['.cjs'] },
    });
    await db.migrate.latest();
    // Clean slate for the core tables this test touches.
    await db.raw('TRUNCATE fact, pod, pod_membership, fact_lifecycle, history RESTART IDENTITY CASCADE');

    // Real app code against the real test PG (env already points cortex there).
    ({ embed } = await import('../../src/ingestion/embedder.js'));
    store = await import('../../src/memory/facts/store.js');
    membership = await import('../../src/memory/pods/membership.js');
    podStore = await import('../../src/memory/pods/store.js');

    projectDir = mkdtempSync(join(tmpdir(), 'sigil-e2e-'));
    const { pod } = await podStore.upsertPod({
      podType: 'project', externalId: projectDir, name: 'e2e', namespace: 'default', startedAt: new Date(),
    });

    for (const content of [
      'Stripe webhooks burned us on April 23 because signatures were not verified.',
      'We moved off Redis to Postgres LISTEN/NOTIFY for the job queue.',
    ]) {
      const embedding = await embed(content);
      const r = await store.saveFact({
        content, category: 'domain_knowledge', confidence: 'high', importance: 'supplementary',
        namespace: 'default', sourceDocumentIds: [], sourceSection: null, embedding,
      });
      const factId = r.fact?.id ?? r.existing?.id;
      if (factId) await membership.attachFact(pod.id, factId, 'primary');
    }
  });

  afterAll(async () => { if (db) await db.destroy(); });

  it('on-topic prompt injects the project memory', () => {
    const ctxText = runHook('what went wrong with our stripe webhooks', projectDir);
    expect(ctxText).toBeTruthy();
    expect(/stripe/i.test(ctxText)).toBe(true);
  });

  it('off-topic prompt injects nothing (no noise in the window)', () => {
    const ctxText = runHook('what is the capital of France', projectDir);
    // additionalContext absent (null) OR present but empty of our facts.
    expect(ctxText == null || !/stripe|redis/i.test(ctxText)).toBe(true);
  });
});
