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
 * Apply pending migrations with an AUTO-REVERT safety net — the engine behind
 * `sigil update`'s self-migrating step.
 *
 * Runs against the daemon's live pool (the legitimate owner of the single-process
 * embedded engine), so it works in embedded mode where a CLI process can't open
 * the DB. The contract: the DB is ALWAYS left in a consistent, known state —
 * either fully migrated, or rolled back to exactly where it started. The caller
 * (update.js) reads the returned status to keep the *code* in lockstep with the
 * *schema* (revert the code if the schema couldn't move forward).
 *
 * Safety layers, in order:
 *   1. A pre-migration snapshot (embedded only, best-effort) — a full-cluster
 *      restore point for the catastrophic "rollback also failed" case.
 *   2. migrate.latest. On success → 'migrated'.
 *   3. On failure → free any stuck lock, then migrate.rollback to undo the
 *      partial batch. If the schema is back to where it started → 'reverted'.
 *   4. If rollback can't restore it → 'dirty' (snapshot path returned so the
 *      operator — or the daemon's boot-recovery — can restore).
 *
 * @param {object} [opts]
 *   knex            — injectable knex-like handle (default: the cortex pool)
 *   takeSnapshotFn  — injectable snapshot taker (default: db/snapshots.takeSnapshot)
 *   log             — (msg) => void
 * @returns {Promise<{status:'migrated'|'reverted'|'dirty', ran?:string[], error?:string, rollbackError?:string, snapshot?:string|null}>}
 */
export async function migrateWithRollback({ knex, takeSnapshotFn, log = () => {} } = {}) {
  const db = knex || (await import('./cortex.js')).default;
  const dir = { directory: MIGRATIONS_DIR };

  const completedCount = async () => {
    const res = await db.migrate.list(dir);
    const done = Array.isArray(res) ? res[0] : [];
    return (done || []).length;
  };

  const before = await completedCount();

  // (1) Pre-migration restore point — embedded best-effort; never blocks.
  let snapshot = null;
  try {
    const take = takeSnapshotFn || (await import('./snapshots.js')).takeSnapshot;
    const snap = await take({ reason: 'pre-update-migration', log });
    snapshot = snap && snap.name ? snap.name : null;
  } catch (err) {
    log(`migrate: pre-migration snapshot skipped (${err.message.split('\n')[0]})`);
  }

  // (2) Apply.
  try {
    const [, ran] = await db.migrate.latest(dir);
    if (ran.length) await resyncSequences(db);
    return { status: 'migrated', ran, snapshot };
  } catch (err) {
    // How much of THIS run's batch actually landed? Critical: if the first
    // pending migration threw, knex recorded nothing — and calling rollback now
    // would undo the *previous* legitimate batch. Only roll back what we added.
    const mid = await completedCount().catch(() => before);
    if (mid <= before) {
      // Nothing from this run applied — the schema is untouched (already at the
      // prior state). Don't rollback. Report 'reverted' so the caller reverts the
      // code to match (the migration the new code expects didn't land).
      log(`migrate: latest failed before applying anything (${oneLine(err)}) — schema unchanged`);
      return { status: 'reverted', error: oneLine(err), snapshot, ran: [] };
    }

    log(`migrate: latest failed after a partial batch (${oneLine(err)}) — rolling back`);
    // (3) Undo the partial batch. Free a lock a crashed migration may have left.
    try {
      try { await db.migrate.forceFreeMigrationsLock?.(dir); } catch { /* best-effort */ }
      await db.migrate.rollback(dir);
      const after = await completedCount();
      if (after <= before) {
        await resyncSequences(db).catch(() => {});
        return { status: 'reverted', error: oneLine(err), snapshot };
      }
      return { status: 'dirty', error: oneLine(err), snapshot };
    } catch (rbErr) {
      // (4) Rollback itself failed — DB may be inconsistent; snapshot is the net.
      return { status: 'dirty', error: oneLine(err), rollbackError: oneLine(rbErr), snapshot };
    }
  }
}

function oneLine(err) {
  return String(err?.message || err || 'unknown error').split('\n')[0];
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
