import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import knex from 'knex';

import { ClientPGlite } from '../../db/pglite-adapter.js';
import { __setTestConfig } from '../../setup/config-store.js';

let pg;
let db;
let correctFact;

const fakeVector = Array(1024).fill(0.01);
const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
    value,
  ]));
};

beforeAll(async () => {
  __setTestConfig({
    database: { mode: 'embedded' },
    embedding: { provider: 'ollama', model: 'mxbai-embed-large' },
  });
  pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;
  await pg.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE fact (
      id BIGSERIAL PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      category TEXT,
      confidence TEXT,
      importance TEXT,
      namespace TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'active',
      source_document_ids INTEGER[] NOT NULL DEFAULT '{}',
      source_section TEXT,
      embedding HALFVEC(1024),
      search_vector TSVECTOR,
      valid_from TIMESTAMP,
      valid_until TIMESTAMP,
      superseded_by_id BIGINT,
      contradicted_by_id BIGINT,
      embedding_model TEXT,
      embedding_dim INTEGER,
      created_by_device_id TEXT,
      created_by_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE history (
      id BIGSERIAL PRIMARY KEY,
      target_type TEXT,
      target_id BIGINT,
      event TEXT,
      old_content TEXT,
      new_content TEXT,
      triggered_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    INSERT INTO fact (
      uid, content, category, confidence, importance, namespace, status,
      source_document_ids, source_section, embedding
    ) VALUES (
      'fact-old', 'The project uses MySQL.', 'domain_knowledge', 'high',
      'vital', 'default', 'active', '{}', 'direct',
      ('[' || repeat('0.01,', 1023) || '0.01]')::halfvec
    );
  `);

  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    postProcessResponse: (value) => toCamel(value),
    wrapIdentifier: (value, original) => original(value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)),
  });
  db.client._injectedPglite = pg;

  vi.doMock('../../db/cortex.js', () => ({ default: db }));
  vi.doMock('../../ingestion/embedder.js', () => ({
    embedOrThrow: vi.fn(async () => fakeVector),
  }));
  vi.doMock('../../lib/llm.js', () => ({ prompt: vi.fn() }));
  ({ correctFact } = await import('./store.js'));
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

describe('explicit fact correction', () => {
  it('atomically inserts a replacement, retires the old row, and records history', async () => {
    const result = await correctFact('fact-old', 'The project uses PGlite locally.');

    expect(result.unchanged).toBe(false);
    expect(result.previous.uid).toBe('fact-old');
    expect(result.replacement.uid).not.toBe('fact-old');

    const old = await db('fact').where({ uid: 'fact-old' }).first();
    const current = await db('fact').where({ id: old.supersededById }).first();
    const history = await db('history').where({ targetId: old.id, event: 'CORRECT' }).first();

    expect(old.status).toBe('superseded');
    expect(current.content).toBe('The project uses PGlite locally.');
    expect(current.status).toBe('active');
    expect(history.oldContent).toBe('The project uses MySQL.');
    expect(history.newContent).toBe('The project uses PGlite locally.');
    expect(history.triggeredBy).toBe('explicit');
  });
});
