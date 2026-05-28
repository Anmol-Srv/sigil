/**
 * testDbConnection — try to open a one-shot connection using either a
 * Postgres URL or discrete host/port/etc fields, run SELECT 1 and
 * pg_extension check, return diagnostics. Does NOT touch the daemon's
 * own pool.
 */
import pg from 'pg';

import { buildLocalConnection } from '../../db/drivers/local-postgres.js';
import { buildUrlConnection, classifyProvider } from '../../db/drivers/url.js';

export function registerTestDbConnection(registry) {
  registry.register('testDbConnection', async (params) => {
    let connection;
    let provider = 'unknown';
    try {
      if (params.url) {
        connection = buildUrlConnection(params.url);
        provider = classifyProvider(params.url);
      } else {
        connection = buildLocalConnection({ db: {
          host: params.host || 'localhost',
          port: Number(params.port) || 5432,
          database: params.database || 'sigil',
          user: params.user || 'sigil_app',
          password: params.password || '',
        }});
        provider = 'local';
      }
    } catch (err) {
      return { ok: false, stage: 'parse', error: err.message };
    }

    const client = new pg.Client(connection);
    const t0 = Date.now();
    try {
      await client.connect();
    } catch (err) {
      return { ok: false, stage: 'connect', provider, error: err.message, code: err.code };
    }

    try {
      const sel = await client.query('SELECT 1 AS ok, current_database() AS db, version() AS version');
      const ext = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
      const ms = Date.now() - t0;
      return {
        ok: true,
        provider,
        connectMs: ms,
        database: sel.rows[0].db,
        serverVersion: sel.rows[0].version,
        pgvector: ext.rowCount > 0,
      };
    } catch (err) {
      return { ok: false, stage: 'query', provider, error: err.message, code: err.code };
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  });
}
