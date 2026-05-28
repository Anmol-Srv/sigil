/**
 * ensurePgvector — issue CREATE EXTENSION IF NOT EXISTS vector against
 * either a one-shot URL or the daemon's currently-configured pool.
 *
 * Required for managed Postgres providers (Neon, Supabase) where the
 * extension is available but not enabled by default. Most providers'
 * project-owner role has CREATE EXTENSION privilege.
 */
import pg from 'pg';

import { buildLocalConnection } from '../../db/drivers/local-postgres.js';
import { buildUrlConnection, classifyProvider } from '../../db/drivers/url.js';

export function registerEnsurePgvector(registry) {
  registry.register('ensurePgvector', async (params = {}) => {
    let connection;
    let provider = 'local';
    try {
      if (params.url) {
        connection = buildUrlConnection(params.url);
        provider = classifyProvider(params.url);
      } else if (params.host) {
        connection = buildLocalConnection({ db: {
          host: params.host || 'localhost',
          port: Number(params.port) || 5432,
          database: params.database || 'sigil',
          user: params.user || 'sigil_app',
          password: params.password || '',
        }});
      } else {
        // Use the daemon's currently-configured connection
        const { default: config } = await import('../../config.js');
        const { selectDriver } = await import('../../db/drivers/index.js');
        const driver = selectDriver(config);
        connection = driver.connection;
        provider = driver.provider;
      }
    } catch (err) {
      return { ok: false, stage: 'parse', error: err.message };
    }

    const client = new pg.Client(connection);
    try {
      await client.connect();
    } catch (err) {
      return { ok: false, stage: 'connect', provider, error: err.message, code: err.code };
    }
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      const ext = await client.query("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'");
      return {
        ok: true,
        provider,
        installed: ext.rowCount > 0,
        version: ext.rows[0]?.extversion ?? null,
      };
    } catch (err) {
      return { ok: false, stage: 'extension', provider, error: err.message, code: err.code };
    } finally {
      try { await client.end(); } catch { /* ignore */ }
    }
  });
}
