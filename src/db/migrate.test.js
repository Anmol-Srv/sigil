// Regression test for resyncSequences (finding 6.6): a serial sequence left
// behind its column's MAX(id) must be healed so the next INSERT doesn't collide
// on the primary key. Runs against an in-memory PGlite (real Postgres in WASM,
// no external services) so it lives in the fast unit suite.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knexFactory from 'knex';

import { resyncSequences } from './migrate.js';

// PGlite is an optional dependency; skip cleanly if it can't load rather than
// breaking the fast gate.
let available = true;
let PGlite;
let ClientPGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ ClientPGlite } = await import('./pglite-adapter.js'));
} catch {
  available = false;
}
const suite = available ? describe : describe.skip;

const rowsOf = (res) => res?.rows ?? res ?? [];

suite('resyncSequences', () => {
  let db;
  let pg;

  beforeAll(async () => {
    pg = new PGlite(); // in-memory
    await pg.waitReady;
    db = knexFactory({ client: ClientPGlite, connection: { pglitePath: '__inmemory__' }, pool: { min: 1, max: 1 } });
    db.client._injectedPglite = pg;
    await db.raw('CREATE TABLE t (id serial PRIMARY KEY, v text)');
  });

  afterAll(async () => {
    try { if (db) await db.destroy(); } catch { /* */ }
    try { if (pg) await pg.close(); } catch { /* */ }
  });

  it('heals a sequence left behind MAX(id) so the next auto-insert does not collide', async () => {
    // Simulate the desync: insert rows with EXPLICIT ids — the sequence does NOT
    // advance, so it still points at 1 while max(id) is 3.
    await db.raw("INSERT INTO t (id, v) VALUES (1,'a'), (2,'b'), (3,'c')");

    // Confirm the broken state: a plain (auto-id) insert collides on the pkey.
    let collided = false;
    try {
      await db.raw("INSERT INTO t (v) VALUES ('x')");
    } catch (e) {
      collided = /duplicate key/i.test(e.message);
    }
    expect(collided).toBe(true);

    // Heal.
    const { resynced } = await resyncSequences(db);
    expect(resynced).toBeGreaterThanOrEqual(1);

    // Now an auto-id insert succeeds and lands above the existing max.
    const r = await db.raw("INSERT INTO t (v) VALUES ('y') RETURNING id");
    expect(Number(rowsOf(r)[0].id)).toBeGreaterThan(3);
  });

  it('is a no-op on a fresh/empty table — next id is still 1', async () => {
    await db.raw('CREATE TABLE t2 (id serial PRIMARY KEY, v text)');
    await resyncSequences(db); // covers all tables; must not disturb the empty one
    const r = await db.raw("INSERT INTO t2 (v) VALUES ('first') RETURNING id");
    expect(Number(rowsOf(r)[0].id)).toBe(1);
  });
});
