/**
 * Embedded-database service (PGlite).
 *
 * The zero-prerequisite path: no Postgres install, no Docker, no connection
 * string. A full Postgres 17 + pgvector compiled to WebAssembly runs in-process
 * and persists to ~/.sigil/db. This provisioner just records the mode and runs
 * the migrations against the in-process engine.
 *
 * Single-process caveat: PGlite can only be opened by ONE process at a time. In
 * Sigil that owner is the daemon (the CLI and hooks reach the DB through it over
 * the Unix socket), so the constraint holds — but a direct-DB CLI path (e.g.
 * `sigil migrate`) must run while the daemon is stopped, or go through it.
 */
import { existsSync } from 'node:fs';

import { migrateEmbedded } from '../../db/migrate.js';
import { PGLITE_DB_PATH } from '../../db/pglite-adapter.js';
import { StepError, fromError, persistDatabase } from './shared.js';

/**
 * Self-heal a stale ~/.sigil/db before migrating. A data dir left by an older
 * PGlite/Postgres version, copied from another device, or half-written by a
 * crash aborts the WASM engine ("Aborted()") on the first catalog query — which
 * is exactly what a fresh bundled-DB setup hits after a GUI reset that didn't
 * clear it. Release any in-process handle, verify the dir actually opens, and
 * recover NON-DESTRUCTIVELY if not.
 *
 * Recovery never deletes data (field-report Defect 1, F3): the old path here
 * `rm -rf`'d an unreadable dir, silently destroying everything. Now we prefer
 * restoring the latest snapshot (F2), and when there's no snapshot we still move
 * the dir aside rather than delete it, so the bytes survive for manual recovery.
 */
async function ensureUsableEmbeddedDir(emit) {
  // Drop any live handle (daemon pool + PGlite singleton) bound to this dir — a
  // second concurrent opener would itself violate PGlite's one-process rule.
  const { resetCortexPool } = await import('../../db/cortex.js');
  await resetCortexPool();
  if (!existsSync(PGLITE_DB_PATH)) return;
  let probe = null;
  try {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite/vector');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    probe = new PGlite(`file://${PGLITE_DB_PATH}`, { extensions: { vector, pg_trgm } });
    await probe.waitReady;
    await probe.query('select 1');
    await probe.close();
    return; // dir is healthy
  } catch {
    if (probe) { try { await probe.close(); } catch { /* half-open */ } }
  }

  // Unreadable. Prefer a snapshot restore (moves the torn dir aside, extracts a
  // good cluster). If none exists, move the bad dir aside so migrate creates a
  // fresh one — but the data is preserved, never silently deleted.
  const { latestSnapshot, recoverFromSnapshot } = await import('../../db/snapshots.js');
  if (latestSnapshot()) {
    emit({ pct: 30, label: 'Existing database is unreadable — restoring from snapshot…' });
    await recoverFromSnapshot({});
    return;
  }
  emit({ pct: 30, label: 'Existing database is unreadable — setting it aside and recreating…' });
  const { rename } = await import('node:fs/promises');
  const aside = `${PGLITE_DB_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(PGLITE_DB_PATH, aside);
}

/**
 * @param {object} _input  unused — embedded mode takes no connection fields
 * @param {(p:{pct:number,label:string})=>void} emit  progress sink
 */
export async function provisionEmbedded(_input = {}, emit = () => {}) {
  try {
    // Persist mode FIRST so any later cortex.js import in this process builds an
    // embedded pool (selectDriver reads db.mode live from the config store).
    emit({ pct: 10, label: 'Configuring the in-process database…' });
    persistDatabase({ mode: 'embedded', url: null, password: null });

    // Make sure the on-disk engine actually opens before we migrate — recreate a
    // version-incompatible / corrupt dir rather than aborting the WASM engine.
    emit({ pct: 25, label: 'Checking the in-process database…' });
    await ensureUsableEmbeddedDir(emit);

    emit({ pct: 40, label: 'Creating tables (Postgres + pgvector, no server)…' });
    const m = await migrateEmbedded();

    emit({ pct: 100, label: 'Embedded database ready.' });
    return {
      mode: 'embedded',
      engine: 'pglite',
      dataDir: PGLITE_DB_PATH,
      migrationsRan: m.ran.length,
    };
  } catch (err) {
    throw err instanceof StepError ? err : fromError(err);
  }
}
