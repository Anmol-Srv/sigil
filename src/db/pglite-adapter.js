/**
 * PGlite adapter for Knex — drops the Docker/Postgres requirement entirely.
 *
 * Extends Knex's built-in pg client but overrides the connection acquisition
 * layer to return a PGlite connection instead of a real pg.Client.
 * Everything above (query compiler, schema builder, migrations) stays unchanged.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

import { SIGIL_DB_PATH } from '../lib/paths.js';

const _require = createRequire(import.meta.url);
const ClientPG = _require('knex/lib/dialects/postgres/index.js');

// In-process PGlite data directory (~/.sigil/db). Override with SIGIL_PGLITE_PATH.
export const PGLITE_DB_PATH = process.env.SIGIL_PGLITE_PATH || SIGIL_DB_PATH;

let pgliteInstance = null;
let pgliteInstancePath = null;

/**
 * Single-process guard (finding 6.1). PGlite is single-process: a second process
 * opening the same data dir while another holds it aborts the WASM engine
 * ("Aborted()") and poisons the holder too. Only the daemon (which sets
 * SIGIL_DAEMON_PROCESS) may open the embedded engine; every other process must
 * route DB access through the daemon. When NO daemon is running, a direct open is
 * fine (solo CLI: provision/migrate/reset, or a verb before the daemon starts),
 * so we only block when a live daemon is detected. Fail-open if we can't tell.
 */
async function assertEmbeddedOpenable() {
  if (process.env.SIGIL_DAEMON_PROCESS === '1') return; // the daemon — legit owner
  let pid = null;
  try {
    const { detectRunningDaemon } = await import('../daemon/lifecycle.js');
    pid = await detectRunningDaemon();
  } catch { return; /* can't determine — don't block */ }
  if (!pid) return; // no daemon → safe to open the engine solo
  const err = new Error(
    `Sigil's daemon (pid ${pid}) holds the built-in database — it is single-process, so this `
    + 'command cannot open it directly. Stop the daemon and retry (it restarts on next use):\n'
    + '  sigil daemon stop',
  );
  err.code = 'embedded_in_use';
  throw err;
}

async function getPGlite(dbPath) {
  // Re-open if the cached singleton is bound to a DIFFERENT path than requested
  // — e.g. a reset wiped + recreated ~/.sigil/db within this same process. The
  // old instance's WASM heap is then inconsistent with the backing files and
  // aborts ("Aborted()") on the next query. Close it, then open the new path.
  if (pgliteInstance && pgliteInstancePath !== dbPath) {
    await destroyPGlite();
  }
  if (!pgliteInstance) {
    await assertEmbeddedOpenable();
    const { PGlite } = await import('@electric-sql/pglite');
    // Every extension Sigil's migrations CREATE must be registered here, or
    // `CREATE EXTENSION` fails ("control file not found"). Keep in sync with
    // `grep -ri 'create extension' src/db/migrations`: currently vector
    // (pgvector — embeddings) and pg_trgm (entity-name trigram index).
    const { vector } = await import('@electric-sql/pglite/vector');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    mkdirSync(dbPath, { recursive: true });
    pgliteInstance = new PGlite(`file://${dbPath}`, { extensions: { vector, pg_trgm } });
    await pgliteInstance.waitReady;
    pgliteInstancePath = dbPath;
  }
  return pgliteInstance;
}

/**
 * Close + clear the process-wide PGlite singleton. Safe to call when none is
 * open. MUST run before removing the on-disk data dir (~/.sigil/db): a live WASM
 * instance whose backing files vanish goes inconsistent and aborts the next
 * query. Resolves once the engine is fully closed.
 */
export async function destroyPGlite() {
  const inst = pgliteInstance;
  pgliteInstance = null;
  pgliteInstancePath = null;
  if (inst) {
    try { await inst.close(); } catch { /* already closed */ }
  }
}

/**
 * Thin wrapper that makes PGlite look like a pg.Client to Knex.
 * Handles both string and object query configs, and both callback and promise styles.
 */
class PGliteConnection {
  constructor(db) {
    this._db = db;
  }

  query(textOrObj, callback) {
    const text = typeof textOrObj === 'string' ? textOrObj : textOrObj.text;
    const values = (textOrObj?.values) || [];

    // PGlite's query() uses prepared statement protocol — single statement only.
    // For parameterless multi-statement SQL (DDL migrations), use exec() instead.
    const isMultiStatement = !values.length && text.split(';').filter((s) => s.trim()).length > 1;

    const p = isMultiStatement
      ? this._db.exec(text).then((results) => {
          const last = results[results.length - 1] || {};
          return {
            command: text.trim().split(/\s+/)[0].toUpperCase(),
            rows: last.rows || [],
            fields: last.fields || [],
            rowCount: last.affectedRows ?? last.rows?.length ?? 0,
          };
        })
      : this._db.query(text, values).then((result) => ({
          command: (text || '').trim().split(/\s+/)[0].toUpperCase(),
          rows: result.rows,
          fields: result.fields || [],
          rowCount: result.affectedRows ?? result.rows.length,
        }));

    if (typeof callback === 'function') {
      p.then((r) => callback(null, r)).catch((e) => callback(e));
    } else {
      return p;
    }
  }

  // Called by destroyRawConnection — no-op since PGlite is a singleton
  end(callback) {
    if (typeof callback === 'function') return callback(null);
    return Promise.resolve();
  }

  on() {}
  removeListener() {}
}

export class ClientPGlite extends ClientPG {
  constructor(config) {
    super(config);
    this._pglitePath = config?.connection?.pglitePath || PGLITE_DB_PATH;
    // Tests can pass a pre-built PGlite (e.g. in-memory) to bypass the
    // on-disk singleton entirely. Keeps integration tests hermetic.
    this._injectedPglite = config?.connection?.pgliteInstance || null;
  }

  // Override raw connection acquisition — return PGliteConnection, bypass pg.Pool entirely
  acquireRawConnection() {
    if (!this.version) this.version = '17.0'; // PGlite is built on PG17
    if (this._injectedPglite) {
      return Promise.resolve(new PGliteConnection(this._injectedPglite));
    }
    return getPGlite(this._pglitePath).then((db) => new PGliteConnection(db));
  }

  // Don't end the connection — PGlite is a singleton, stays alive until knex.destroy()
  async destroyRawConnection() {}

  // Close PGlite when the knex instance is torn down. Injected instances are
  // owned by the caller (e.g. test fixtures) and not closed here.
  async destroy() {
    await super.destroy();
    if (this._injectedPglite) return;
    await destroyPGlite();
  }
}
