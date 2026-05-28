/**
 * runMigrations — apply knex migrations.
 *
 * Two modes:
 *   - No params:    use the daemon's existing pool (cortexDb singleton).
 *                   For users who want to re-run migrations after a schema bump.
 *   - With params:  build a fresh knex against the supplied URL or host/port.
 *                   This is what the onboarding wizard uses, because the
 *                   daemon's existing pool was bound at boot to whatever
 *                   was in env at startup — the new SIGIL_DATABASE_URL just
 *                   written by the wizard isn't picked up until restart.
 */
import knexFactory from 'knex';

import { MIGRATIONS_DIR } from '../../lib/paths.js';
import { buildLocalConnection } from '../../db/drivers/local-postgres.js';
import { buildUrlConnection } from '../../db/drivers/url.js';

export function registerRunMigrations(registry) {
  registry.register('runMigrations', async (params = {}) => {
    if (params.url || params.host) {
      // One-shot migrate against the supplied connection.
      const connection = params.url
        ? buildUrlConnection(params.url)
        : buildLocalConnection({ db: {
            host: params.host || 'localhost',
            port: Number(params.port) || 5432,
            database: params.database || 'sigil',
            user: params.user || 'sigil_app',
            password: params.password || '',
          }});
      const knex = knexFactory({
        client: 'pg',
        connection,
        pool: { min: 1, max: 2 },
      });
      try {
        const [batchNo, ranFiles] = await knex.migrate.latest({ directory: MIGRATIONS_DIR });
        return { batchNo, ran: ranFiles, against: params.url ? 'url' : 'fields' };
      } finally {
        await knex.destroy();
      }
    }

    const { default: cortexDb } = await import('../../db/cortex.js');
    const [batchNo, ranFiles] = await cortexDb.migrate.latest({ directory: MIGRATIONS_DIR });
    return { batchNo, ran: ranFiles, against: 'daemon-pool' };
  });
}
