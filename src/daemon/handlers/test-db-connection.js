/**
 * testDbConnection — try to open a one-shot connection using either a
 * Postgres URL or discrete host/port/etc fields, run SELECT 1 and a
 * pgvector check, return diagnostics. Does NOT touch the daemon's own
 * pool.
 *
 * URL path delegates to src/db/setup.js#probeUrlConnection so the same
 * SSL heuristics + pgvector check run during `sigil init` and from the
 * GUI Setup wizard.
 */
import pg from 'pg';

import { buildLocalConnection } from '../../db/drivers/local-postgres.js';
import { probeUrlConnection } from '../../db/setup.js';

export function registerTestDbConnection(registry) {
  registry.register('testDbConnection', async (params) => {
    if (params.url) {
      return probeUrlConnection(params.url);
    }

    let connection;
    try {
      connection = buildLocalConnection({ db: {
        host: params.host || 'localhost',
        port: Number(params.port) || 5432,
        database: params.database || 'sigil',
        user: params.user || 'sigil_app',
        password: params.password || '',
      }});
    } catch (err) {
      return { ok: false, stage: 'parse', error: err.message };
    }

    const client = new pg.Client(connection);
    const t0 = Date.now();
    try {
      await client.connect();
    } catch (err) {
      return { ok: false, stage: 'connect', provider: 'local', error: err.message, code: err.code };
    }
    try {
      const sel = await client.query('SELECT current_database() AS db, version() AS version');
      const ext = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
      return {
        ok: true,
        provider: 'local',
        connectMs: Date.now() - t0,
        database: sel.rows[0].db,
        serverVersion: sel.rows[0].version,
        pgvector: ext.rowCount > 0,
      };
    } catch (err) {
      return { ok: false, stage: 'query', provider: 'local', error: err.message, code: err.code };
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  });
}
