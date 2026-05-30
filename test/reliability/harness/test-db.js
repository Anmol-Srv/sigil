/**
 * Reliability test DB — an in-memory PGlite running the REAL migrations.
 *
 * The whole point of the reliability infra is to stop testing against mocks.
 * This spins up a fresh in-process Postgres (PGlite + the pgvector extension),
 * applies the actual src/db/migrations/*.cjs (so vector(768), tsvector, GIN,
 * hnsw, every column and constraint match production), and hands back a knex
 * instance wired with the SAME camelCase<->snake_case mappers as
 * src/db/cortex.js. App code (ingest pipeline, hybrid search, fact store) runs
 * unchanged against it — no hand-rolled tables, no mocked SQL.
 *
 * Vector ops are real: the probe confirmed PGlite supports vector / halfvec /
 * hnsw, so hybrid-sql.js's `::halfvec(768)` casts and `<=>` distance run for
 * real. That's exactly the layer the unit-test mocks hid.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import knex from 'knex';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

import { ClientPGlite } from '../../../src/db/pglite-adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '../../../src/db/migrations');

// Mirror src/db/cortex.js exactly so query results are camelCased and column
// identifiers are snaked — app code reads f.sourceDocumentIds, writes
// { createdByAgent }, etc.
const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return out;
};
const postProcessResponse = (r) => (Array.isArray(r) ? r.map(toCamel) : toCamel(r));
const wrapIdentifier = (value, orig) => orig(value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));

/**
 * @returns {Promise<{ db: import('knex').Knex, pg: PGlite }>}
 */
export async function createTestDb() {
  const pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;

  const db = knex({
    client: ClientPGlite,
    // pglitePath is a placeholder; the real instance is injected below (knex
    // deep-clones `connection`, which would choke on the PGlite WASM handle).
    connection: { pglitePath: '__inmemory__' },
    pool: { min: 1, max: 1 },
    postProcessResponse,
    wrapIdentifier,
    migrations: { directory: MIGRATIONS_DIR, loadExtensions: ['.cjs'] },
  });
  db.client._injectedPglite = pg;

  await db.migrate.latest();
  return { db, pg };
}

export async function destroyTestDb({ db, pg }) {
  try { if (db) await db.destroy(); } catch { /* ignore */ }
  try { if (pg) await pg.close(); } catch { /* ignore */ }
}
