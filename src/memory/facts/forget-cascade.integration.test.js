// PGlite-backed integration test for deleteFact (the `sigil forget` engine).
//
// deleteFact previously only cleared fact_entity before deleting the fact row.
// Every other FK that references fact — relation.source_fact_id,
// fact.superseded_by_id / contradicted_by_id, hebbian_edge.fact_a_id/b_id,
// fact_lifecycle.fact_id — was left intact, so `forget` threw (e.g.
// "violates foreign key constraint relation_source_fact_id_foreign") for any
// fact that was a relation source or a supersede/contradict target.
//
// This test recreates that schema with real FK constraints and asserts the
// cascade succeeds and leaves no dangling references. Without the fix the
// first assertion throws the FK error.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../../db/pglite-adapter.js';

let pg;
let db;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;

  await pg.exec(`
    CREATE TABLE fact (
      id SERIAL PRIMARY KEY,
      uid TEXT UNIQUE NOT NULL,
      content TEXT,
      status TEXT DEFAULT 'active',
      superseded_by_id INTEGER REFERENCES fact(id),
      contradicted_by_id INTEGER REFERENCES fact(id)
    );
    CREATE TABLE pod (
      id SERIAL PRIMARY KEY,
      member_fact_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE pod_membership (
      id SERIAL PRIMARY KEY,
      pod_id INTEGER NOT NULL,
      member_type TEXT NOT NULL,
      member_id INTEGER NOT NULL
    );
    CREATE TABLE relation (
      id SERIAL PRIMARY KEY,
      source_fact_id INTEGER REFERENCES fact(id)
    );
    CREATE TABLE hebbian_edge (
      fact_a_id INTEGER NOT NULL REFERENCES fact(id),
      fact_b_id INTEGER NOT NULL REFERENCES fact(id),
      strength NUMERIC DEFAULT 1,
      PRIMARY KEY (fact_a_id, fact_b_id)
    );
    CREATE TABLE fact_entity (
      id SERIAL PRIMARY KEY,
      fact_id INTEGER NOT NULL REFERENCES fact(id)
    );
    CREATE TABLE fact_lifecycle (
      fact_id INTEGER PRIMARY KEY REFERENCES fact(id),
      stage TEXT DEFAULT 'fresh'
    );
  `);

  // Seed: target T(1) to delete; superseder S(2) points at T via
  // superseded_by_id; partner O(3) for the hebbian edge.
  await pg.exec(`
    INSERT INTO fact (id, uid, content) VALUES
      (1, 'fact-target-0001', 'doomed'),
      (2, 'fact-superseder1', 'survives, points at T'),
      (3, 'fact-partner0001', 'hebbian partner');
    SELECT setval('fact_id_seq', 3);
    UPDATE fact SET superseded_by_id = 1 WHERE id = 2;
    INSERT INTO pod (id, member_fact_count) VALUES (10, 2);
    INSERT INTO pod_membership (pod_id, member_type, member_id) VALUES (10, 'fact', 1);
    INSERT INTO relation (source_fact_id) VALUES (1);
    INSERT INTO hebbian_edge (fact_a_id, fact_b_id) VALUES (1, 3);
    INSERT INTO fact_entity (fact_id) VALUES (1);
    INSERT INTO fact_lifecycle (fact_id) VALUES (1);
  `);

  db = knex({
    client: ClientPGlite,
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    wrapIdentifier: (value, origImpl) => origImpl(value.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)),
  });
  db.client._injectedPglite = pg;

  vi.doMock('../../db/cortex.js', () => ({ default: db }));
  vi.doMock('../../ingestion/embedder.js', () => ({
    embed: vi.fn(), embedBatch: vi.fn(), embedOrThrow: vi.fn(), embedBatchOrThrow: vi.fn(),
  }));
  vi.doMock('../../lib/llm.js', () => ({ prompt: vi.fn(), promptJson: vi.fn(), parseJson: vi.fn() }));
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
  vi.resetModules();
});

describe('deleteFact FK cascade (PGlite)', () => {
  it('forgets a fact that is a relation source + supersede target without FK errors', async () => {
    const { deleteFact } = await import('./store.js');

    const deleted = await deleteFact('fact-target-0001');
    expect(deleted).toBeTruthy();
    expect(deleted.uid).toBe('fact-target-0001');

    const gone = await pg.query('SELECT 1 FROM fact WHERE id = 1');
    expect(gone.rows).toHaveLength(0);

    // The superseder survives, with its dangling pointer nulled.
    const s = await pg.query('SELECT superseded_by_id FROM fact WHERE id = 2');
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].superseded_by_id).toBeNull();

    // Partner fact untouched.
    const o = await pg.query('SELECT 1 FROM fact WHERE id = 3');
    expect(o.rows).toHaveLength(1);

    // All hard references removed.
    for (const [tbl, col] of [['relation', 'source_fact_id'], ['fact_entity', 'fact_id'], ['fact_lifecycle', 'fact_id']]) {
      const r = await pg.query(`SELECT 1 FROM ${tbl} WHERE ${col} = 1`);
      expect(r.rows).toHaveLength(0);
    }
    const heb = await pg.query('SELECT 1 FROM hebbian_edge WHERE fact_a_id = 1 OR fact_b_id = 1');
    expect(heb.rows).toHaveLength(0);

    // Membership detached and pod counter decremented (2 -> 1).
    const mem = await pg.query(`SELECT 1 FROM pod_membership WHERE member_type = 'fact' AND member_id = 1`);
    expect(mem.rows).toHaveLength(0);
    const pod = await pg.query('SELECT member_fact_count FROM pod WHERE id = 10');
    expect(Number(pod.rows[0].member_fact_count)).toBe(1);
  });

  it('returns null for an unknown id', async () => {
    const { deleteFact } = await import('./store.js');
    await expect(deleteFact('fact-does-not-exist')).resolves.toBeNull();
  });
});
