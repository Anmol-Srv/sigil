// Pod scoping has to answer three questions correctly, and the third one is
// where a real store lost 60 of its 82 facts:
//
//   1. a fact in MY pod            → visible
//   2. a fact in ANOTHER pod       → hidden (no cross-project leak)
//   3. a fact in NO pod            → VISIBLE
//
// (3) is the one that regressed. "No membership" means "we don't know what this
// is about", not "this belongs to someone else". Excluding it made every fact
// saved before pods existed — and every fact from `remember`, which never
// attached to anything — invisible from every directory the moment the first
// pod was created.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import knex from 'knex';

import { ClientPGlite } from '../../db/pglite-adapter.js';
import { buildChunkPodFilter } from './filters.js';

let pg;
let db;

const toCamel = (o) => {
  if (!o || typeof o !== 'object' || o instanceof Date) return o;
  if (Array.isArray(o)) return o.map(toCamel);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]));
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    CREATE TABLE fact (id BIGSERIAL PRIMARY KEY, content TEXT);
    CREATE TABLE chunk (id BIGSERIAL PRIMARY KEY, document_id INTEGER, content TEXT);
    CREATE TABLE pod_membership (
      id SERIAL PRIMARY KEY, pod_id INTEGER NOT NULL,
      member_type TEXT NOT NULL, member_id BIGINT NOT NULL, role TEXT
    );
    INSERT INTO fact (id, content) VALUES
      (1,'mine'), (2,'other project'), (3,'unpodded — subject unknown');
    INSERT INTO chunk (id, document_id, content) VALUES
      (1, 10, 'doc in my pod'), (2, 20, 'doc in another pod'), (3, 30, 'unpodded doc');
    INSERT INTO pod_membership (pod_id, member_type, member_id) VALUES
      (1,'fact',1), (2,'fact',2),
      (1,'document',10), (2,'document',20);
  `);
  db = knex({ client: ClientPGlite, connection: { pglitePath: '__inmemory__' }, pool: { min: 1, max: 1 }, postProcessResponse: (r) => (Array.isArray(r) ? r.map(toCamel) : toCamel(r)) });
  db.client._injectedPglite = pg;
});

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.close();
});

// Mirrors the clause hybrid-sql.js builds for the fact CTEs.
// Qualified `fact.id` — bare `id` binds to pod_membership.id inside the
// subquery, which is exactly the bug this file caught in production.
const UNPODDED_FACT = `NOT EXISTS (SELECT 1 FROM pod_membership pm WHERE pm.member_type='fact' AND pm.member_id = fact.id)`;
async function factsInScope(podIds) {
  if (podIds === null) return (await pg.query('SELECT content FROM fact ORDER BY id')).rows.map((r) => r.content);
  const sql = podIds.length === 0
    ? `SELECT content FROM fact WHERE ${UNPODDED_FACT} ORDER BY id`
    : `SELECT content FROM fact WHERE (fact.id = ANY(SELECT member_id FROM pod_membership WHERE member_type='fact' AND pod_id = ANY($1::int[])) OR ${UNPODDED_FACT}) ORDER BY id`;
  const res = podIds.length === 0 ? await pg.query(sql) : await pg.query(sql, [podIds]);
  return res.rows.map((r) => r.content);
}

describe('fact pod scoping', () => {
  it('shows my pod AND unpodded, never another project', async () => {
    expect(await factsInScope([1])).toEqual(['mine', 'unpodded — subject unknown']);
  });

  it('keeps a known-elsewhere fact out', async () => {
    expect(await factsInScope([1])).not.toContain('other project');
  });

  it('with nothing active, shows unpodded rather than nothing', async () => {
    // The old behaviour was `AND FALSE` — a directory with no pod saw zero
    // facts, which is how recall silently died outside a known project.
    expect(await factsInScope([])).toEqual(['unpodded — subject unknown']);
  });

  it('unscoped still sees everything', async () => {
    expect(await factsInScope(null)).toHaveLength(3);
  });
});

describe('chunk pod scoping (documents)', () => {
  const run = async (podIds) => {
    const f = buildChunkPodFilter(podIds);
    const sql = `SELECT content FROM chunk WHERE 1=1 ${f.clause.replace('?::int[]', '$1::int[]')} ORDER BY id`;
    const res = f.params.length ? await pg.query(sql, f.params) : await pg.query(sql);
    return res.rows.map((r) => r.content);
  };

  it('mirrors the fact rule — mine plus unpodded', async () => {
    expect(await run([1])).toEqual(['doc in my pod', 'unpodded doc']);
  });

  it('excludes another project\'s document', async () => {
    expect(await run([1])).not.toContain('doc in another pod');
  });

  it('nothing active → unpodded only', async () => {
    expect(await run([])).toEqual(['unpodded doc']);
  });

  it('unscoped → all', async () => {
    expect(await run(null)).toHaveLength(3);
  });
});
