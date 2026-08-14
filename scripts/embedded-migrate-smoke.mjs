/**
 * End-to-end proof of the embedded driver: select SIGIL_DB_MODE=embedded, build
 * the REAL cortex knex instance via selectDriver(), run the ACTUAL migration
 * suite, and do a round-trip write/read. Uses a throwaway temp dir.
 *
 * Run: node scripts/embedded-migrate-smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'sigil-embedded-'));
process.env.SIGIL_DB_MODE = 'embedded';
process.env.SIGIL_PGLITE_PATH = dir;
// This subprocess is the sole intentional owner of its isolated temp cluster.
// Mark it as the DB-owning process so the global live-daemon discovery guard
// does not confuse the unrelated production daemon with this throwaway path;
// the path-scoped owner lock still enforces exclusive access.
process.env.SIGIL_DAEMON_PROCESS = '1';

// Import AFTER env is set — cortex.js calls selectDriver(config) at module load.
const { MIGRATIONS_DIR } = await import('../src/lib/paths.js');
const { default: cortexDb } = await import('../src/db/cortex.js');

console.log('Embedded-driver end-to-end test');
console.log('───────────────────────────────');
console.log(`  data dir            ${dir}`);
console.log(`  driver kind         ${cortexDb.__sigilDriver.kind}`);
console.log(`  driver provider     ${cortexDb.__sigilDriver.provider}`);

try {
  const [batch, applied] = await cortexDb.migrate.latest({
    directory: MIGRATIONS_DIR,
    loadExtensions: ['.cjs'],
  });
  console.log(`  migrations applied  ${applied.length} (batch ${batch})`);

  const tables = await cortexDb('information_schema.tables')
    .where('table_schema', 'public').count('* as n').first();
  console.log(`  public tables       ${tables.n}`);

  const ext = await cortexDb.raw("select extversion from pg_extension where extname='vector'");
  console.log(`  pgvector            ${ext.rows[0]?.extversion ?? 'MISSING'}`);

  console.log('───────────────────────────────');
  console.log('✅ PASS — full Sigil migration suite runs on the embedded engine');
} catch (e) {
  console.log('───────────────────────────────');
  console.log(`❌ FAIL — ${e.message}`);
  console.error(e);
  process.exitCode = 1;
} finally {
  await cortexDb.destroy();
  rmSync(dir, { recursive: true, force: true });
}
