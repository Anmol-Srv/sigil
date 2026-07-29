/**
 * runMigrations — apply knex migrations.
 *
 * Two modes:
 *   - No params:    use the daemon's existing pool (cortexDb singleton).
 *                   For users who want to re-run migrations after a schema bump.
 *   - With params:  build a fresh knex against the supplied URL or host/port.
 *                   This is what the onboarding wizard uses, because the
 *                   daemon's existing pool may be bound to the prior config;
 *                   an explicit candidate connection must be tested before
 *                   it becomes the active configuration.
 */
import knexFactory from 'knex';

import { MIGRATIONS_DIR } from '../../lib/paths.js';
import { buildLocalConnection } from '../../db/drivers/local-postgres.js';
import { buildUrlConnection, isPooledUrl, directMigrationUrl } from '../../db/drivers/url.js';

export function registerRunMigrations(registry) {
  // migrateSafe — apply pending migrations daemon-side with auto-revert, the
  // engine behind `sigil update`'s self-migrating step. The daemon is the
  // legitimate owner of the single-process embedded engine, so this works where
  // a CLI `sigil migrate` can't even open the DB. Always leaves the DB
  // consistent; returns a status the updater uses to keep code ⇄ schema in sync.
  registry.register('migrateSafe', async () => {
    const { default: config } = await import('../../config.js');

    // Not set up yet — the onboarding wizard runs the first migration.
    let mode;
    try { mode = config.db.mode; } catch { mode = null; }
    if (!mode) return { status: 'skipped', reason: 'not-configured' };

    // A transaction-pooler URL can't run migrations (advisory locks / prepared
    // statements). The daemon pool is bound to it, so migrate.latest would fail;
    // skip cleanly and tell the user to migrate against the direct endpoint.
    if (mode === 'url' && isPooledUrl(config.db.url) && !directMigrationUrl(config.db.url)) {
      return { status: 'skipped', reason: 'pooled-url' };
    }

    const { migrateWithRollback } = await import('../../db/migrate.js');
    return migrateWithRollback({ log: (m) => console.error(`[migrate] ${m}`) });
  });

  registry.register('runMigrations', async (params = {}) => {
    if (params.url || params.host) {
      // One-shot migrate against the supplied connection.
      let connection;
      if (params.url) {
        // Pooled connections (PgBouncer txn mode) can't run migrations —
        // advisory locks / prepared statements fail. Migrate against the
        // direct endpoint when we can derive it; otherwise surface a clear,
        // diagnoseError-classifiable message rather than a cryptic failure.
        let migrateUrl = params.url;
        if (isPooledUrl(params.url)) {
          const direct = directMigrationUrl(params.url);
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
        connection = buildLocalConnection({ db: {
          host: params.host || 'localhost',
          port: Number(params.port) || 5432,
          database: params.database || 'sigil',
          user: params.user || 'sigil_app',
          password: params.password || '',
        }});
      }
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

  // Explicit rollback remains available for operators, but it runs through the
  // daemon's pool so the CLI never opens a second embedded engine.
  registry.register('rollbackMigrations', async () => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    let snapshot = null;
    try {
      const { takeSnapshot } = await import('../../db/snapshots.js');
      const result = await takeSnapshot({ reason: 'pre-rollback' });
      snapshot = result?.name || null;
    } catch { /* external DB or snapshot unavailable */ }
    const [batchNo, ranFiles] = await cortexDb.migrate.rollback({ directory: MIGRATIONS_DIR });
    return { batchNo, ran: ranFiles, snapshot, against: 'daemon-pool' };
  });
}
