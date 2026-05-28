/**
 * runMigrations — invoke knex.migrate.latest() against the daemon's
 * pool. Returns the migration batch report.
 */
export function registerRunMigrations(registry) {
  registry.register('runMigrations', async () => {
    const { default: cortexDb } = await import('../../db/cortex.js');
    const { MIGRATIONS_DIR } = await import('../../lib/paths.js');
    const [batchNo, ranFiles] = await cortexDb.migrate.latest({ directory: MIGRATIONS_DIR });
    return { batchNo, ran: ranFiles };
  });
}
