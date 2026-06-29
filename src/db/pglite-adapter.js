/**
 * PGlite adapter for Knex — drops the Docker/Postgres requirement entirely.
 *
 * Extends Knex's built-in pg client but overrides the connection acquisition
 * layer to return a PGlite connection instead of a real pg.Client.
 * Everything above (query compiler, schema builder, migrations) stays unchanged.
 */

import { createRequire } from 'node:module';
import {
  mkdirSync, existsSync, renameSync,
  openSync, writeSync, closeSync, readFileSync, unlinkSync,
} from 'node:fs';

import { PKG_ROOT, SIGIL_DB_PATH } from '../lib/paths.js';

const _require = createRequire(import.meta.url);
const ClientPG = _require('knex/lib/dialects/postgres/index.js');

// PGlite version, recorded in the owner lock so a future PGlite upgrade can
// reason about on-disk data-dir compatibility. Best-effort.
let PGLITE_VERSION = null;
try { PGLITE_VERSION = _require('@electric-sql/pglite/package.json').version; } catch { /* unknown */ }

// In-process PGlite data directory (~/.sigil/db). Override with SIGIL_PGLITE_PATH.
export const PGLITE_DB_PATH = process.env.SIGIL_PGLITE_PATH || SIGIL_DB_PATH;

let pgliteInstance = null;
let pgliteInstancePath = null;

/**
 * True for a PGlite WASM-heap abort (field-report Defect 3 / F4). Once the
 * Emscripten heap `abort()`s, the module is unrecoverable and every later call
 * returns the same error — the only fix is to dispose the instance and
 * re-instantiate. Detect it so the query layer can recycle rather than wedge.
 */
export function isPgliteAbort(err) {
  if (!err) return false;
  if (typeof WebAssembly !== 'undefined' && WebAssembly.RuntimeError
      && err instanceof WebAssembly.RuntimeError) return true;
  return err.name === 'RuntimeError' || /Aborted\(\)/.test(err.message || '');
}

/**
 * Honest diagnostics (F7 / field-report Defect 6). PGlite surfaces a heap abort
 * as a bare `Aborted(). Build with -sASSERTIONS for more info` — the real
 * Postgres PANIC/FATAL behind it is swallowed. Setting SIGIL_PGLITE_DEBUG=1..5
 * raises PGlite's debug level so that underlying log line is printed, turning an
 * opaque abort into an actionable cause. Returns undefined (PGlite's default)
 * when unset/invalid so normal runs stay quiet.
 */
export function pgliteDebugLevel() {
  const raw = process.env.SIGIL_PGLITE_DEBUG;
  if (!raw) return undefined;
  const n = raw === '1' || raw.toLowerCase() === 'true' ? 1 : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
}

/**
 * Single-process guard (finding 6.1). PGlite is single-process: a second process
 * opening the same data dir while another holds it aborts the WASM engine
 * ("Aborted()") and poisons the holder too. Only the daemon (which sets
 * SIGIL_DAEMON_PROCESS) may open the embedded engine; every other process must
 * route DB access through the daemon. When NO daemon is running, a direct open is
 * fine (solo CLI: provision/migrate/reset, or a verb before the daemon starts),
 * so we only block when a live daemon is detected. Fail-open if we can't tell.
 */
async function assertEmbeddedOpenable() {
  if (process.env.SIGIL_DAEMON_PROCESS === '1') return; // the daemon — legit owner
  let pid = null;
  try {
    const { detectRunningDaemon } = await import('../daemon/lifecycle.js');
    pid = await detectRunningDaemon();
  } catch { return; /* can't determine — don't block */ }
  if (!pid) return; // no daemon → safe to open the engine solo
  const err = new Error(
    `Sigil's daemon (pid ${pid}) holds the built-in database — it is single-process, so this `
    + 'command cannot open it directly. Stop the daemon and retry (it restarts on next use):\n'
    + '  sigil daemon stop',
  );
  err.code = 'embedded_in_use';
  throw err;
}

/**
 * DB-owner lockfile (S4). PGlite is single-process: two processes opening the
 * same data dir abort the WASM engine and corrupt the cluster. assertEmbeddedOpenable
 * above blocks a NON-daemon open while a daemon is live, but it can't stop two
 * DAEMONS from different installs (both exempt themselves) — the exact dueling
 * -install state behind the recurring corruption. This lock is the structural
 * backstop: a sibling `<dbPath>.owner.lock` recording who owns the dir. We key
 * the lock on the data-dir path (outside the dir, so dump/restore never touch
 * it) and record pid + install root + PGlite version.
 */
export function ownerLockPath(dbPath) {
  return `${String(dbPath).replace(/\/+$/, '')}.owner.lock`;
}

function readOwnerLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; } // exists but not ours → alive
}

/**
 * Pure decision for what to do with an existing lock record. Split out so the
 * acquire/reclaim/refuse logic is unit-testable without real processes/files.
 * @returns {'create'|'held'|'reclaim'|'refuse'}
 */
export function ownerLockDecision(existing, { selfPid, isAlive }) {
  if (!existing || !Number.isInteger(existing.pid)) return 'create'; // missing/garbage
  if (existing.pid === selfPid) return 'held';                       // already ours
  if (!isAlive(existing.pid)) return 'reclaim';                      // stale → take it
  return 'refuse';                                                   // live, different owner
}

let heldLockPath = null;

function acquireOwnerLock(dbPath) {
  const lockPath = ownerLockPath(dbPath);
  const record = JSON.stringify({
    pid: process.pid, root: PKG_ROOT, pgliteVersion: PGLITE_VERSION, startedAt: Date.now(),
  });
  // At most two passes: the second covers a reclaim losing the create race to
  // another reclaimer (its `wx` then fails and we re-evaluate the new owner).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx'); // atomic exclusive create — wins the race
      writeSync(fd, record);
      closeSync(fd);
      heldLockPath = lockPath;
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readOwnerLock(lockPath);
      const decision = ownerLockDecision(existing, { selfPid: process.pid, isAlive: pidAlive });
      if (decision === 'held') { heldLockPath = lockPath; return; }
      if (decision === 'refuse') {
        const e = new Error(
          `Sigil's built-in database is already owned by another process (pid ${existing.pid}`
          + `${existing.root ? ` at ${existing.root}` : ''}). PGlite is single-process — two installs `
          + 'opening ~/.sigil/db corrupts it. Stop that process first (or, if it is dead, remove '
          + `${lockPath}).`,
        );
        e.code = 'embedded_owned';
        throw e;
      }
      // create / reclaim → drop the stale (or garbage) lock and retry the create.
      try { unlinkSync(lockPath); } catch { /* already gone — fine */ }
    }
  }
  // Lost the create race twice — re-read and refuse rather than open unguarded.
  const owner = readOwnerLock(lockPath);
  const e = new Error(`Could not acquire the built-in DB lock (${lockPath}); another process holds it.`);
  e.code = 'embedded_owned';
  e.owner = owner;
  throw e;
}

function releaseOwnerLock() {
  if (!heldLockPath) return;
  const existing = readOwnerLock(heldLockPath);
  // Only remove a lock we still own — never clobber a successor's lock.
  if (existing && existing.pid === process.pid) {
    try { unlinkSync(heldLockPath); } catch { /* already gone */ }
  }
  heldLockPath = null;
}

async function getPGlite(dbPath) {
  // Re-open if the cached singleton is bound to a DIFFERENT path than requested
  // — e.g. a reset wiped + recreated ~/.sigil/db within this same process. The
  // old instance's WASM heap is then inconsistent with the backing files and
  // aborts ("Aborted()") on the next query. Close it, then open the new path.
  if (pgliteInstance && pgliteInstancePath !== dbPath) {
    await destroyPGlite();
  }
  if (!pgliteInstance) {
    await assertEmbeddedOpenable();
    acquireOwnerLock(dbPath); // S4: refuse to open a dir another live process owns
    const { PGlite } = await import('@electric-sql/pglite');
    // Every extension Sigil's migrations CREATE must be registered here, or
    // `CREATE EXTENSION` fails ("control file not found"). Keep in sync with
    // `grep -ri 'create extension' src/db/migrations`: currently vector
    // (pgvector — embeddings) and pg_trgm (entity-name trigram index).
    const { vector } = await import('@electric-sql/pglite/vector');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    mkdirSync(dbPath, { recursive: true });
    const debug = pgliteDebugLevel();
    pgliteInstance = new PGlite(`file://${dbPath}`, {
      extensions: { vector, pg_trgm },
      ...(debug ? { debug } : {}), // SIGIL_PGLITE_DEBUG → surface the real PANIC/FATAL behind Aborted()
    });
    await pgliteInstance.waitReady;
    pgliteInstancePath = dbPath;
  }
  return pgliteInstance;
}

/**
 * Close + clear the process-wide PGlite singleton. Safe to call when none is
 * open. MUST run before removing the on-disk data dir (~/.sigil/db): a live WASM
 * instance whose backing files vanish goes inconsistent and aborts the next
 * query. Resolves once the engine is fully closed.
 */
export async function destroyPGlite() {
  const inst = pgliteInstance;
  pgliteInstance = null;
  pgliteInstancePath = null;
  if (inst) {
    try { await inst.close(); } catch { /* already closed */ }
  }
  releaseOwnerLock(); // S4: hand off ownership once the engine is closed
}

/**
 * Snapshot the embedded data dir (F2). Uses PGlite's native dumpDataDir, which
 * produces a CONSISTENT tarball of the cluster (no torn-file risk from copying
 * a live dir) — returns a gzipped tar as a Buffer. Runs against the live
 * singleton (the daemon's), opening one if needed. Throws on a poisoned heap so
 * the caller can skip the snapshot and keep the last good one.
 */
export async function dumpEmbeddedDataDir(dbPath = PGLITE_DB_PATH) {
  const db = await getPGlite(dbPath);
  const blob = await db.dumpDataDir('gzip');
  return Buffer.from(await blob.arrayBuffer());
}

/**
 * Restore the embedded cluster from a snapshot tarball (F3 / field-report
 * Defect 1). NON-DESTRUCTIVE: the existing (torn) data dir is renamed aside to
 * `${dbPath}.corrupt-<ts>` — never deleted — so nothing is lost irrecoverably,
 * then the snapshot is extracted into a fresh dir via PGlite's loadDataDir, and
 * verified with a probe query before we trust it. Disposes the live singleton
 * first (a WASM instance whose backing files move goes inconsistent). Returns
 * `{ movedAside }` (the path the old dir was preserved at, or null).
 */
export async function restoreEmbeddedDataDir(snapshotBuffer, dbPath = PGLITE_DB_PATH) {
  await destroyPGlite(); // close any live instance before the dir moves

  let movedAside = null;
  if (existsSync(dbPath)) {
    movedAside = `${dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(dbPath, movedAside); // preserve the bad cluster, don't rm
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite/vector');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  mkdirSync(dbPath, { recursive: true });
  // loadDataDir extracts the tarball into the (now-empty) dir on init.
  const restored = new PGlite(`file://${dbPath}`, {
    loadDataDir: new Blob([snapshotBuffer]),
    extensions: { vector, pg_trgm },
  });
  try {
    await restored.waitReady;
    await restored.query('select 1'); // verify the restored cluster opens
  } finally {
    await restored.close().catch(() => {});
  }
  // Leave the singleton null — the next acquireRawConnection reopens the fresh dir.
  return { movedAside };
}

/**
 * Thin wrapper that makes PGlite look like a pg.Client to Knex.
 * Handles both string and object query configs, and both callback and promise styles.
 */
class PGliteConnection {
  constructor(db) {
    this._db = db;
  }

  query(textOrObj, callback) {
    const text = typeof textOrObj === 'string' ? textOrObj : textOrObj.text;
    const values = (textOrObj?.values) || [];

    // PGlite's query() uses prepared statement protocol — single statement only.
    // For parameterless multi-statement SQL (DDL migrations), use exec() instead.
    const isMultiStatement = !values.length && text.split(';').filter((s) => s.trim()).length > 1;

    const p = (isMultiStatement
      ? this._db.exec(text).then((results) => {
          const last = results[results.length - 1] || {};
          return {
            command: text.trim().split(/\s+/)[0].toUpperCase(),
            rows: last.rows || [],
            fields: last.fields || [],
            rowCount: last.affectedRows ?? last.rows?.length ?? 0,
          };
        })
      : this._db.query(text, values).then((result) => ({
          command: (text || '').trim().split(/\s+/)[0].toUpperCase(),
          rows: result.rows,
          fields: result.fields || [],
          rowCount: result.affectedRows ?? result.rows.length,
        }))
    ).catch((err) => {
      // F4 / field-report Defect 3: an Aborted() / WebAssembly.RuntimeError means
      // the WASM heap is dead and every later call repeats it. Dispose the singleton
      // so the next acquireRawConnection rebuilds a fresh PGlite, and tag the error
      // so the daemon drops the dead pooled connection (resetCortexPool in dispatch).
      if (isPgliteAbort(err)) {
        pgliteInstance = null;
        pgliteInstancePath = null;
        err.sigilPoisoned = true;
      }
      throw err;
    });

    if (typeof callback === 'function') {
      p.then((r) => callback(null, r)).catch((e) => callback(e));
    } else {
      return p;
    }
  }

  // Called by destroyRawConnection — no-op since PGlite is a singleton
  end(callback) {
    if (typeof callback === 'function') return callback(null);
    return Promise.resolve();
  }

  on() {}
  removeListener() {}
}

export class ClientPGlite extends ClientPG {
  constructor(config) {
    super(config);
    this._pglitePath = config?.connection?.pglitePath || PGLITE_DB_PATH;
    // Tests can pass a pre-built PGlite (e.g. in-memory) to bypass the
    // on-disk singleton entirely. Keeps integration tests hermetic.
    this._injectedPglite = config?.connection?.pgliteInstance || null;
  }

  // Override raw connection acquisition — return PGliteConnection, bypass pg.Pool entirely
  acquireRawConnection() {
    if (!this.version) this.version = '17.0'; // PGlite is built on PG17
    if (this._injectedPglite) {
      return Promise.resolve(new PGliteConnection(this._injectedPglite));
    }
    return getPGlite(this._pglitePath).then((db) => new PGliteConnection(db));
  }

  // Don't end the connection — PGlite is a singleton, stays alive until knex.destroy()
  async destroyRawConnection() {}

  // Close PGlite when the knex instance is torn down. Injected instances are
  // owned by the caller (e.g. test fixtures) and not closed here.
  async destroy() {
    await super.destroy();
    if (this._injectedPglite) return;
    await destroyPGlite();
  }
}
