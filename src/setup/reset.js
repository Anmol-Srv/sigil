/**
 * Reset / clean-rebuild helpers, shared by the GUI (setup.factoryReset RPC) and
 * the CLI (`sigil reset`).
 *
 *   - disconnectAllClients() — remove Sigil's hooks/config from every connected
 *     coding agent (claude-code, cursor, …).
 *   - wipeMemoryData()       — TRUNCATE every memory table (keeps schema, so a
 *     fresh setup re-migrates cleanly). Runs in the daemon (uses its pool).
 *   - dropConfiguredDatabase() — destroy the DB itself: remove the Docker
 *     container+volume, or DROP DATABASE for a local install. External/managed
 *     URLs are left alone (not ours to drop) — reported back to the caller.
 *   - factoryReset()         — the in-app reset: disconnect + optional memory
 *     wipe + config wipe.
 */
import { getConfig, resetConfig } from './config-store.js';

/**
 * Stop the installed supervisor (if any), then gracefully stop the daemon.
 * Used by the destructive CLI reset before it removes the database directory.
 * Returns a summary and never starts a daemon.
 */
export async function stopRuntimeForReset({ timeoutMs = 10_000 } = {}) {
  let serviceRemoved = false;
  try {
    const { isServiceInstalled, uninstallService } = await import('../supervisor/index.js');
    if (await isServiceInstalled()) {
      await uninstallService();
      serviceRemoved = true;
    }
  } catch { /* no supported/installed supervisor */ }

  const { readPidFile, isPidAlive } = await import('../daemon/lifecycle.js');
  const { setTimeout: delay } = await import('node:timers/promises');
  const pid = await readPidFile();
  if (!pid || !isPidAlive(pid)) return { serviceRemoved, daemonStopped: true, pid: null, forced: false };

  try { process.kill(pid, 'SIGTERM'); } catch {
    return { serviceRemoved, daemonStopped: !isPidAlive(pid), pid, forced: false };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) await delay(50);
  let forced = false;
  if (isPidAlive(pid)) {
    forced = true;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return { serviceRemoved, daemonStopped: !isPidAlive(pid), pid, forced };
}

/** Remove Sigil from every coding agent it's installed into. */
export async function disconnectAllClients() {
  const { listClients } = await import('../lib/clients/index.js');
  const clients = await listClients();
  const removed = [];
  for (const c of clients) {
    try {
      const v = await c.verify();
      if (v.installed) { await c.uninstall({ dryRun: false }); removed.push(c.id); }
    } catch { /* best-effort per client */ }
  }
  return removed;
}

/** TRUNCATE all memory tables (everything except knex migration bookkeeping). */
export async function wipeMemoryData() {
  const { default: cortexDb } = await import('../db/cortex.js');
  const { rows } = await cortexDb.raw(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex\\_%'",
  );
  const tables = rows.map((r) => r.tablename);
  if (!tables.length) return 0;
  await cortexDb.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  return tables.length;
}

/**
 * Destroy the configured database. Reads config BEFORE it's wiped.
 *   docker → remove the sigil-postgres container + its volume
 *   local  → DROP DATABASE (connect to the maintenance db as the OS user)
 *   url    → left intact (managed/user-owned); reported as skipped
 * @returns {Promise<{ kind, dropped: boolean, detail: string }>}
 */
export async function dropConfiguredDatabase() {
  const cfg = getConfig();
  const mode = cfg.database?.mode;

  if (mode === 'embedded') {
    return {
      kind: 'embedded',
      dropped: true,
      detail: 'built-in database scheduled for removal with ~/.sigil',
    };
  }

  if (mode === 'docker') {
    const { removeLocalPostgres } = await import('../db/provision/docker.js');
    await removeLocalPostgres({ deleteVolume: true });
    return { kind: 'docker', dropped: true, detail: 'removed sigil-postgres container + volume' };
  }

  if (mode === 'local') {
    const pg = (await import('pg')).default;
    const { userInfo } = await import('node:os');
    const name = cfg.database.name || 'sigil';
    const admin = new pg.Client({
      host: cfg.database.host || 'localhost',
      port: cfg.database.port || 5432,
      database: 'postgres',
      user: cfg.database.adminUser || userInfo().username,
      password: '',
    });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name.replace(/"/g, '""')}" WITH (FORCE)`);
      return { kind: 'local', dropped: true, detail: `dropped database "${name}"` };
    } finally {
      try { await admin.end(); } catch { /* */ }
    }
  }

  return { kind: mode || 'none', dropped: false, detail: 'external/managed database left intact' };
}

/**
 * In-app reset (GUI). Disconnect agents, optionally wipe stored memory, wipe
 * config. Leaves the daemon running on its current pool; the GUI then returns
 * to setup. The CLI `sigil reset` performs the full teardown; `--keep-db`
 * explicitly preserves the configured database.
 */
export async function factoryReset({ wipeMemory = true } = {}) {
  const disconnected = await disconnectAllClients();
  const embedded = getConfig().database?.mode === 'embedded';
  let tablesWiped = 0;
  let dbRemoved = false;
  if (wipeMemory) {
    if (embedded) {
      // The bundled DB is an in-process PGlite engine holding ~/.sigil/db open in
      // THIS (daemon) process. A bare TRUNCATE would leave that data dir behind —
      // and a version-incompatible or half-written dir aborts the WASM engine on
      // the next setup ("Aborted()"). So release the handle (resetCortexPool →
      // knex destroy → destroyPGlite) and delete the dir, so the next bundled-DB
      // setup starts from a clean, version-current database.
      try {
        const { resetCortexPool } = await import('../db/cortex.js');
        const { PGLITE_DB_PATH } = await import('../db/pglite-adapter.js');
        const { rm } = await import('node:fs/promises');
        await resetCortexPool();
        await rm(PGLITE_DB_PATH, { recursive: true, force: true });
        dbRemoved = true;
      } catch { /* best-effort; config wipe still proceeds */ }
    } else {
      try { tablesWiped = await wipeMemoryData(); } catch { /* DB may be unreachable; config wipe still proceeds */ }
    }
  }
  resetConfig();
  return { disconnected, tablesWiped, dbRemoved, configWiped: true };
}
