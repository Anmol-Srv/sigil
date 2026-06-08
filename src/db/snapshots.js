/**
 * Embedded-cluster snapshots (F2 / field-report Defect 1).
 *
 * The embedded PGlite cluster lives at ~/.sigil/db. If it's torn (a hard kill
 * mid-write, a half-flushed checkpoint), it can fail to open — and the old
 * recovery path simply `rm -rf`'d it (total data loss). This module takes
 * CONSISTENT snapshots of the cluster using PGlite's native `dumpDataDir`
 * (a Postgres-level tar, not a copy of live files, so there's no torn-snapshot
 * risk), rotates a handful of them, and exposes the read helpers F3 uses to
 * restore the latest good one instead of wiping.
 *
 * The pure filesystem helpers (write/list/latest/prune) take an explicit dir so
 * they're unit-testable without touching ~/.sigil or the WASM engine.
 */
import {
  mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, statSync, readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { SIGIL_SNAPSHOTS_DIR } from '../lib/paths.js';

const PREFIX = 'db-';
const EXT = '.tgz';
// Keep a small rolling window — enough to step back past a bad snapshot without
// hoarding disk. Each is a gzipped dump of the whole cluster.
export const SNAPSHOT_KEEP = 3;

/** A sortable snapshot filename for a Date (lexical order == chronological). */
export function snapshotName(date) {
  // 2026-06-08T13-45-09-123Z.tgz — colons/dots aren't portable in filenames.
  const iso = date.toISOString().replace(/[:.]/g, '-');
  return `${PREFIX}${iso}${EXT}`;
}

function isSnapshot(name) {
  return name.startsWith(PREFIX) && name.endsWith(EXT);
}

/**
 * List snapshots newest-first. Sorted by filename, which is chronological by
 * construction; mtime is the tiebreaker for any hand-dropped file.
 */
export function listSnapshots(dir = SIGIL_SNAPSHOTS_DIR) {
  let names;
  try { names = readdirSync(dir); } catch { return []; } // dir absent → none
  const out = [];
  for (const name of names) {
    if (!isSnapshot(name)) continue;
    const path = join(dir, name);
    let size = 0; let mtimeMs = 0;
    try { const st = statSync(path); size = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
    out.push({ name, path, size, mtimeMs });
  }
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : b.mtimeMs - a.mtimeMs));
  return out;
}

/** Newest snapshot ({name, path, size, mtimeMs}) or null. */
export function latestSnapshot(dir = SIGIL_SNAPSHOTS_DIR) {
  return listSnapshots(dir)[0] || null;
}

/** Delete all but the newest `keep` snapshots. Returns the removed names. */
export function pruneSnapshots(dir = SIGIL_SNAPSHOTS_DIR, keep = SNAPSHOT_KEEP) {
  const all = listSnapshots(dir);
  const removed = [];
  for (const s of all.slice(Math.max(0, keep))) {
    try { rmSync(s.path, { force: true }); removed.push(s.name); } catch { /* leave it */ }
  }
  return removed;
}

/**
 * Atomically write a snapshot tarball (temp + rename so a crash mid-write never
 * leaves a half-file that looks like a valid snapshot), then prune to `keep`.
 */
export function writeSnapshotBytes(buffer, { dir = SIGIL_SNAPSHOTS_DIR, date = new Date(), keep = SNAPSHOT_KEEP } = {}) {
  mkdirSync(dir, { recursive: true });
  const name = snapshotName(date);
  const finalPath = join(dir, name);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, buffer);
  renameSync(tmpPath, finalPath);
  const pruned = pruneSnapshots(dir, keep);
  return { name, path: finalPath, bytes: buffer.length, pruned };
}

/** Read a snapshot file into a Buffer (for restore — F3). */
export function readSnapshot(path) {
  return readFileSync(path);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Take a snapshot of the live embedded cluster. Embedded-only. CHECKPOINTs first
 * to flush the WAL (smaller, cleaner dump), then dumps consistently. A poisoned
 * heap makes dumpDataDir throw BEFORE any file is written, so the last good
 * snapshot is preserved — the caller logs and moves on. Returns the write result
 * or a `{ skipped }` reason.
 */
export async function takeSnapshot({ reason = 'periodic', dir = SIGIL_SNAPSHOTS_DIR, keep = SNAPSHOT_KEEP, log = () => {} } = {}) {
  const { default: config } = await import('../config.js');
  if (config.db.mode !== 'embedded') return { skipped: 'not-embedded' };

  try {
    const { default: cortexDb } = await import('./cortex.js');
    await cortexDb.raw('CHECKPOINT');
  } catch { /* non-fatal: dumpDataDir is consistent regardless of WAL state */ }

  const { dumpEmbeddedDataDir } = await import('./pglite-adapter.js');
  const bytes = await dumpEmbeddedDataDir();
  const res = writeSnapshotBytes(bytes, { dir, keep });
  log(`db: snapshot (${reason}) → ${res.name} (${formatBytes(res.bytes)}${res.pruned.length ? `, pruned ${res.pruned.length}` : ''})`);
  return res;
}
