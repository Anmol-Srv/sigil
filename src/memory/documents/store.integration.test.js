// PGlite-backed integration test for the whole-document read path.
//
// The gap this covers: Sigil could ingest a document and never hand it back.
// There was no getDocument, the `document` table held no content, and chunks
// overlap by ~50 tokens so concatenating them duplicates text at every seam.
// These pin the three things that had to be true for "store a doc, get it back,
// scoped to its project":
//   1. stored content comes back byte-exact
//   2. a pre-migration document (content IS NULL) reassembles from chunks
//      without duplicating the overlap
//   3. listDocuments honours pod scope, so one project's docs stay out of
//      another's — the thing that makes "this project's documents" meaningful

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../../db/pglite-adapter.js';

let pg;
let db;
let store;

const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};
const postProcessResponse = (r) => (Array.isArray(r) ? r.map(toCamel) : toCamel(r));
const wrapIdentifier = (value, orig) => orig(value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

const EXACT_TEXT = '# Design\n\nFirst paragraph.\n\nSecond paragraph.\n';

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;

  await pg.exec(`
    CREATE TABLE document (
      id SERIAL PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      source_type TEXT NOT NULL,
      title TEXT,
      content_hash TEXT,
      content TEXT,
      namespace TEXT NOT NULL DEFAULT 'default',
      chunk_count INTEGER DEFAULT 0,
      fact_count INTEGER DEFAULT 0,
      last_ingested_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE chunk (
      id SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'default'
    );
    -- Mirrors the REAL pod table (migration 20260512120000). Getting a column
    -- name wrong here silently hides a broken query: an earlier draft of this
    -- fixture used "kind" instead of "pod_type" and every test passed while the
    -- live query failed with "column pod.kind does not exist".
    CREATE TABLE pod (
      id SERIAL PRIMARY KEY,
      uid TEXT NOT NULL UNIQUE,
      pod_type TEXT NOT NULL,
      name TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE pod_membership (
      id SERIAL PRIMARY KEY,
      pod_id INTEGER NOT NULL,
      member_type TEXT NOT NULL,
      member_id BIGINT NOT NULL,
      role TEXT
    );
  `);

  await pg.exec(`
    INSERT INTO pod (id, uid, name, pod_type) VALUES
      (1, 'pod-alpha', 'alpha', 'project'),
      (2, 'pod-beta',  'beta',  'project');

    -- 1: stored content (post-migration ingest)
    INSERT INTO document (id, uid, source_path, source_type, title, content, chunk_count)
      VALUES (1, 'doc-stored', '/p/alpha/DESIGN.md', 'file', 'Design', ${quote(EXACT_TEXT)}, 2);

    -- 2: pre-migration document — content IS NULL, only chunks exist, and the
    -- chunker overlapped them ("Second paragraph." repeats at the seam).
    INSERT INTO document (id, uid, source_path, source_type, title, content, chunk_count)
      VALUES (2, 'doc-legacy', '/p/alpha/OLD.md', 'file', 'Old', NULL, 2);
    INSERT INTO chunk (document_id, chunk_index, content) VALUES
      (2, 0, 'First paragraph.\nSecond paragraph.'),
      (2, 1, 'Second paragraph.\nThird paragraph.');

    -- 3: belongs to a DIFFERENT project
    INSERT INTO document (id, uid, source_path, source_type, title, content)
      VALUES (3, 'doc-other', '/p/beta/NOTES.md', 'file', 'Beta notes', 'beta only');

    INSERT INTO pod_membership (pod_id, member_type, member_id, role) VALUES
      (1, 'document', 1, 'primary'),
      (1, 'document', 2, 'primary'),
      (2, 'document', 3, 'primary');
  `);

  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    postProcessResponse,
    wrapIdentifier,
  });
  db.client._injectedPglite = pg;

  vi.doMock('../../db/cortex.js', () => ({ default: db }));
  store = await import('./store.js');
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

function quote(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

describe('getDocument', () => {
  it('returns stored content byte-exact', async () => {
    const doc = await store.getDocument({ uid: 'doc-stored' });
    expect(doc.content).toBe(EXACT_TEXT);
    expect(doc.exact).toBe(true);
    expect(doc.title).toBe('Design');
  });

  it('reassembles a pre-migration document without duplicating the chunk overlap', async () => {
    const doc = await store.getDocument({ uid: 'doc-legacy' });
    expect(doc.exact).toBe(false);
    // The overlap must appear once, not twice — that is the whole point.
    expect(doc.content.match(/Second paragraph\./g)).toHaveLength(1);
    expect(doc.content).toBe('First paragraph.\nSecond paragraph.\nThird paragraph.');
  });

  it('truncates on request and reports it', async () => {
    const doc = await store.getDocument({ uid: 'doc-stored', maxChars: 10 });
    expect(doc.truncated).toBe(true);
    expect(doc.content).toHaveLength(10);
    expect(doc.totalChars).toBe(EXACT_TEXT.length);
  });

  it('returns null for an unknown uid', async () => {
    expect(await store.getDocument({ uid: 'doc-nope' })).toBeNull();
  });

  it('reports the pods a document belongs to', async () => {
    const pods = await store.podsForDocument(1);
    expect(pods.map((p) => p.uid)).toEqual(['pod-alpha']);
    expect(pods[0].podType).toBe('project');
  });
});

describe('listDocuments pod scoping', () => {
  it('returns only the requested project\'s documents', async () => {
    const docs = await store.listDocuments({ podIds: [1] });
    expect(docs.map((d) => d.uid).sort()).toEqual(['doc-legacy', 'doc-stored']);
  });

  it('does not leak another project\'s documents', async () => {
    const docs = await store.listDocuments({ podIds: [2] });
    expect(docs.map((d) => d.uid)).toEqual(['doc-other']);
  });

  it('treats an empty scope as "nothing active", not "everything"', async () => {
    expect(await store.listDocuments({ podIds: [] })).toEqual([]);
  });

  it('returns every document when unscoped', async () => {
    const docs = await store.listDocuments({ podIds: null });
    expect(docs).toHaveLength(3);
  });

  it('never drags content into a listing', async () => {
    const [doc] = await store.listDocuments({ podIds: [1] });
    expect(doc.content).toBeUndefined();
  });
});
