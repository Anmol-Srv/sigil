/**
 * Run knex migrations against an arbitrary connection — a plain function so
 * setup steps can migrate a freshly-created database without going through the
 * daemon's pool or the runMigrations RPC. Pooled (PgBouncer) URLs are rewritten
 * to their direct endpoint, since advisory locks / prepared statements that
 * migrations need don't work through a transaction pooler.
 */
import knexFactory from 'knex';

import { MIGRATIONS_DIR } from '../lib/paths.js';
import { buildUrlConnection, buildLocalConnectionFromFields } from './drivers/index.js';
import { isPooledUrl, directMigrationUrl } from './drivers/url.js';

/**
 * @param {{url?: string} | {host: string, port?: number, database?: string, user?: string, password?: string}} spec
 * @returns {Promise<{ batchNo: number, ran: string[] }>}
 */
export async function runMigrationsOn(spec) {
  let connection;
  if (spec.url) {
    let migrateUrl = spec.url;
    if (isPooledUrl(spec.url)) {
      const direct = directMigrationUrl(spec.url);
      if (!direct) {
        throw new Error(
          'This is a connection-pooler URL. Migrations need the direct connection — '
          + 'paste your non-pooled connection string.',
        );
      }
      migrateUrl = direct;
    }
    connection = buildUrlConnection(migrateUrl);
  } else {
    connection = buildLocalConnectionFromFields(spec);
  }

  const knex = knexFactory({ client: 'pg', connection, pool: { min: 1, max: 2 } });
  try {
    const [batchNo, ran] = await knex.migrate.latest({ directory: MIGRATIONS_DIR });
    // Heal any serial sequence left behind its column's MAX(id) — a desync makes
    // the next INSERT collide on the pkey. No-op on a healthy DB.
    await resyncSequences(knex);
    return { batchNo, ran };
  } finally {
    await knex.destroy();
  }
}

/**
 * Run migrations against the in-process PGlite engine (embedded mode).
 *
 * Deliberately does NOT destroy() the knex instance: PGlite is a process-wide
 * singleton (src/db/pglite-adapter.js) shared with the daemon's cortex pool, and
 * destroy() would close it and break every later query. PGlite flushes to disk
 * on write and is released on process exit. pool.max:1 because PGlite is
 * single-connection — a larger pool just multiplexes onto the one engine.
 *
 * @returns {Promise<{ batchNo: number, ran: string[] }>}
 */
export async function migrateEmbedded() {
  const { ClientPGlite, PGLITE_DB_PATH } = await import('./pglite-adapter.js');
  const knex = knexFactory({
    client: ClientPGlite,
    connection: { pglitePath: PGLITE_DB_PATH },
    pool: { min: 1, max: 1 },
  });
  const [batchNo, ran] = await knex.migrate.latest({ directory: MIGRATIONS_DIR });
  await resyncSequences(knex);
  return { batchNo, ran };
}

/**
 * Re-sync every serial / IDENTITY sequence to its column's MAX value. A sequence
 * left BEHIND max(id) — e.g. after a partial data copy, a half-healed embedded
 * dir, or a restore that inserted rows with explicit ids — makes the next INSERT
 * collide on the primary key ("duplicate key value violates ..._pkey"). That is
 * exactly the embedded-DB write breakage seen in the field (finding 6.6).
 *
 * Catalog-driven (works on Postgres and PGlite, which is real Postgres in WASM),
 * idempotent, and a NO-OP on a healthy DB (it sets each sequence to the value it
 * already holds) — safe to run after every migration.
 *
 * @param {import('knex').Knex} knex
 * @returns {Promise<{ resynced: number }>}
 */
export async function resyncSequences(knex) {
  // Every column in the public schema backed by an owned sequence (serial /
  // GENERATED AS IDENTITY). pg_get_serial_sequence returns null for plain cols.
  const res = await knex.raw(`
    SELECT
      quote_ident(t.relname) AS tbl,
      quote_ident(a.attname) AS col,
      pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(t.relname), a.attname) AS seq
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE t.relkind = 'r'
      AND n.nspname = 'public'
      AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(t.relname), a.attname) IS NOT NULL
  `);
  const rows = res?.rows ?? res ?? [];
  let resynced = 0;
  for (const r of rows) {
    if (!r.seq) continue;
    // setval(seq, MAX(col), is_called): with rows present, is_called=true so the
    // next nextval() is MAX+1; on an empty table, is_called=false so it stays 1.
    // tbl/col are catalog-derived quote_ident() values — safe to interpolate.
    await knex.raw(
      `SELECT setval(?,
         COALESCE((SELECT MAX(${r.col}) FROM ${r.tbl}), 1),
         (SELECT COUNT(*) FROM ${r.tbl}) > 0)`,
      [r.seq],
    );
    resynced++;
  }
  return { resynced };
}
