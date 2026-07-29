import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../../db/pglite-adapter.js';

let pg;
let db;
let store;

const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
    value,
  ]));
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    CREATE TABLE document (
      id BIGSERIAL PRIMARY KEY,
      uid TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT,
      content_hash TEXT,
      namespace TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      fact_count INTEGER NOT NULL DEFAULT 0,
      last_ingested_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (source_path, namespace)
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
  store = await import('./store.js');
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

describe('document upsert change detection', () => {
  it('distinguishes new, unchanged, and changed content', async () => {
    const base = {
      sourcePath: '/tmp/guide.md',
      sourceType: 'markdown',
      title: 'Guide',
      namespace: 'default',
    };

    const first = await store.upsert({ ...base, contentHash: 'hash-a' });
    const unchanged = await store.upsert({ ...base, contentHash: 'hash-a' });
    const changed = await store.upsert({ ...base, contentHash: 'hash-b' });

    expect(first.changed).toBe(true);
    expect(unchanged.changed).toBe(false);
    expect(changed.changed).toBe(true);
    expect(changed.doc.id).toBe(first.doc.id);
    expect(changed.doc.contentHash).toBe('hash-b');
  });

  it('does not erase fact counts during a chunks-only update', async () => {
    const row = await store.upsert({
      sourcePath: '/tmp/counts.md',
      sourceType: 'markdown',
      title: 'Counts',
      namespace: 'default',
      contentHash: 'counts-a',
    });
    await store.updateCounts(row.doc.id, { chunkCount: 4, factCount: 7 });
    await store.updateCounts(row.doc.id, { chunkCount: 5 });

    const [saved] = await db('document').where({ id: row.doc.id });
    expect(saved.chunkCount).toBe(5);
    expect(saved.factCount).toBe(7);
  });
});
