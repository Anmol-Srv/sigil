// PGlite-backed integration test for re-ingest superseding (Lane H).
//
// When a source document's content changes, facts extracted from the OLD
// content that the new ingest no longer re-confirms must not linger as
// `active` forever (the stale-memory trust leak). supersedeStaleDocFacts()
// reuses the AUDM supersede path:
//   - sole-provenance fact  → status='superseded' + a SUPERSEDE history row
//   - shared-provenance fact → stays active, this doc dropped from its sources
//   - re-confirmed fact (in keptFactIds) → untouched
//
// No vectors needed — the supersede logic is plain SQL on fact/history, so
// this runs on a bare in-memory PGlite (the search path's halfvec casts are
// out of scope here).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../db/pglite-adapter.js';

let pg;
let db;
let supersedeStaleDocFacts;

// Mirror cortex.js: snake_case columns on the wire, camelCase keys in JS.
const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};
const postProcessResponse = (r) => (Array.isArray(r) ? r.map(toCamel) : toCamel(r));
const wrapIdentifier = (value, orig) => orig(value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;

  await pg.exec(`
    CREATE TABLE fact (
      id BIGSERIAL PRIMARY KEY,
      uid TEXT,
      content TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      namespace TEXT NOT NULL DEFAULT 'default',
      source_document_ids INTEGER[] NOT NULL DEFAULT '{}',
      superseded_by_id BIGINT,
      contradicted_by_id BIGINT,
      valid_until TIMESTAMP,
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
  `);

  // Document 100 changed. fact A + C are sole-provenance of 100; fact B is
  // shared (100 + 200). The re-ingest re-confirmed only C (keptFactIds=[C]).
  await pg.exec(`
    INSERT INTO fact (id, uid, content, status, source_document_ids) VALUES
      (1, 'fact-a', 'old fact A (sole, dropped)',  'active', '{100}'),
      (2, 'fact-b', 'fact B (shared 100+200)',     'active', '{100,200}'),
      (3, 'fact-c', 'fact C (sole, re-confirmed)', 'active', '{100}');
  `);

  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    postProcessResponse,
    wrapIdentifier,
  });
  db.client._injectedPglite = pg;

  vi.doMock('../db/cortex.js', () => ({ default: db }));
  // store.js statically imports the embedder + llm; stub them so importing the
  // module never reaches a provider (supersede never embeds anyway).
  vi.doMock('./embedder.js', () => ({ embed: vi.fn(), embedBatch: vi.fn() }));
  vi.doMock('../lib/llm.js', () => ({ prompt: vi.fn(), promptJson: vi.fn() }));

  ({ supersedeStaleDocFacts } = await import('../memory/facts/store.js'));
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

describe('supersedeStaleDocFacts (PGlite)', () => {
  it('supersedes sole-provenance facts, keeps re-confirmed + shared ones', async () => {
    const res = await supersedeStaleDocFacts(100, [3]); // C re-confirmed

    expect(res).toEqual({ superseded: 1, dissociated: 1 });

    const { rows } = await pg.query('SELECT id, status, source_document_ids, superseded_by_id, valid_until FROM fact ORDER BY id');
    const byId = Object.fromEntries(rows.map((r) => [Number(r.id), r]));

    // A: sole provenance, not re-confirmed → superseded (no successor).
    expect(byId[1].status).toBe('superseded');
    expect(byId[1].superseded_by_id).toBeNull();
    expect(byId[1].valid_until).not.toBeNull();

    // B: shared provenance → still active, doc 100 removed, 200 retained.
    expect(byId[2].status).toBe('active');
    expect(byId[2].source_document_ids.map(Number)).toEqual([200]);

    // C: re-confirmed this ingest → untouched.
    expect(byId[3].status).toBe('active');
    expect(byId[3].source_document_ids.map(Number)).toEqual([100]);
  });

  it('writes a SUPERSEDE history row for the retired fact', async () => {
    const { rows } = await pg.query("SELECT target_type, target_id, event, triggered_by FROM history WHERE event = 'SUPERSEDE'");
    expect(rows).toHaveLength(1);
    expect(rows[0].target_type).toBe('fact');
    expect(Number(rows[0].target_id)).toBe(1);
    expect(rows[0].triggered_by).toBe('reingest:doc=100');
  });

  it('is a no-op for a document with no stale facts (fresh ingest)', async () => {
    const res = await supersedeStaleDocFacts(999, []);
    expect(res).toEqual({ superseded: 0, dissociated: 0 });
  });
});
