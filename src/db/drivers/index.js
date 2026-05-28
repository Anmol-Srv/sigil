/**
 * DB driver selection.
 *
 *   - If SIGIL_DATABASE_URL or DATABASE_URL is set, use the URL driver
 *     (Neon, Supabase, RDS, Render, Railway, self-hosted, etc.).
 *   - Otherwise, use the local-postgres driver (back-compat with the
 *     SIGIL_DB_HOST / PORT / NAME / USER / PASSWORD env vars).
 *
 * Returns a pg-shape connection object suitable for passing to knex's
 * `connection` field. Pool config and post-processing are applied by
 * the caller (cortex.js).
 */
import { buildLocalConnection } from './local-postgres.js';
import { buildUrlConnection, classifyProvider } from './url.js';

export function selectDriver(config) {
  const url = config.db.url;
  if (url) {
    return {
      kind: 'url',
      provider: classifyProvider(url),
      connection: buildUrlConnection(url),
    };
  }
  return {
    kind: 'local',
    provider: 'local',
    connection: buildLocalConnection(config),
  };
}

export { buildLocalConnection, buildUrlConnection, classifyProvider };
