/**
 * PGlite adapter for Knex — drops the Docker/Postgres requirement entirely.
 *
 * Extends Knex's built-in pg client but overrides the connection acquisition
 * layer to return a PGlite connection instead of a real pg.Client.
 * Everything above (query compiler, schema builder, migrations) stays unchanged.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const _require = createRequire(import.meta.url);
const ClientPG = _require('knex/lib/dialects/postgres/index.js');

export const PGLITE_DB_PATH = join(homedir(), '.cortex', 'db');

let pgliteInstance = null;

async function getPGlite(dbPath) {
  if (!pgliteInstance) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite/vector');
    mkdirSync(dbPath, { recursive: true });
    pgliteInstance = new PGlite(`file://${dbPath}`, { extensions: { vector } });
    await pgliteInstance.waitReady;
  }
  return pgliteInstance;
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
  }

  // Override raw connection acquisition — return PGliteConnection, bypass pg.Pool entirely
  acquireRawConnection() {
    return getPGlite(this._pglitePath).then((db) => {
      if (!this.version) this.version = '17.0'; // PGlite is built on PG17
      return new PGliteConnection(db);
    });
  }

  // Don't end the connection — PGlite is a singleton, stays alive until knex.destroy()
  async destroyRawConnection() {}

  // Close PGlite when the knex instance is torn down
  async destroy() {
    await super.destroy();
    if (pgliteInstance) {
      await pgliteInstance.close();
      pgliteInstance = null;
    }
  }
}
