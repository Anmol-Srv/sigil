// Tests for the F2 snapshot filesystem layer — atomic write, rotation, and the
// newest-first listing F3 recovery reads. (The dumpDataDir round-trip itself is
// integration-tested live; here we cover the pure fs logic that decides what's
// kept and what's restored.)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  snapshotName, listSnapshots, latestSnapshot, pruneSnapshots,
  writeSnapshotBytes, readSnapshot, recoverFromSnapshot, SNAPSHOT_KEEP,
} from './snapshots.js';

describe('snapshots', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sigil-snap-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('snapshotName is filename-safe and sorts chronologically', () => {
    const a = snapshotName(new Date('2026-06-08T13:45:09.123Z'));
    const b = snapshotName(new Date('2026-06-08T14:00:00.000Z'));
    expect(a).toMatch(/^db-2026-06-08T13-45-09-123Z\.tgz$/);
    expect(a).not.toContain(':');
    expect(a).not.toMatch(/\d\.\d/); // no dot inside the timestamp
    expect(a < b).toBe(true); // lexical order == chronological
  });

  it('writes a snapshot atomically and reads it back', () => {
    const payload = Buffer.from('fake-tarball-bytes');
    const res = writeSnapshotBytes(payload, { dir, date: new Date('2026-06-08T10:00:00Z') });
    expect(existsSync(res.path)).toBe(true);
    expect(res.bytes).toBe(payload.length);
    expect(readSnapshot(res.path).equals(payload)).toBe(true);
    // No leftover temp files.
    expect(readdirSync(dir).every((n) => !n.includes('.tmp.'))).toBe(true);
  });

  it('lists snapshots newest-first and ignores foreign files', () => {
    writeSnapshotBytes(Buffer.from('1'), { dir, date: new Date('2026-06-08T10:00:00Z') });
    writeSnapshotBytes(Buffer.from('2'), { dir, date: new Date('2026-06-08T12:00:00Z') });
    writeSnapshotBytes(Buffer.from('3'), { dir, date: new Date('2026-06-08T11:00:00Z') });
    writeFileSync(join(dir, 'README.txt'), 'not a snapshot');
    writeFileSync(join(dir, 'db-broken.txt'), 'wrong ext');

    const list = listSnapshots(dir);
    expect(list).toHaveLength(3);
    expect(list[0].name).toContain('T12-00-00'); // newest first
    expect(list[2].name).toContain('T10-00-00');
    expect(latestSnapshot(dir).name).toContain('T12-00-00');
  });

  it('returns null/empty for a missing snapshots dir', () => {
    const absent = join(dir, 'does-not-exist');
    expect(listSnapshots(absent)).toEqual([]);
    expect(latestSnapshot(absent)).toBeNull();
  });

  it('prunes to the newest N on every write', () => {
    // Write 5 with keep=2 explicitly.
    for (let h = 1; h <= 5; h++) {
      writeSnapshotBytes(Buffer.from(String(h)), {
        dir, keep: 2, date: new Date(`2026-06-08T0${h}:00:00Z`),
      });
    }
    const list = listSnapshots(dir);
    expect(list).toHaveLength(2);
    expect(list[0].name).toContain('T05-00-00'); // newest kept
    expect(list[1].name).toContain('T04-00-00');
  });

  it('pruneSnapshots keeps the newest `keep` and reports removed', () => {
    for (let h = 1; h <= 4; h++) {
      // keep high so write() doesn't prune; we prune explicitly below
      writeSnapshotBytes(Buffer.from(String(h)), {
        dir, keep: 99, date: new Date(`2026-06-08T0${h}:00:00Z`),
      });
    }
    const removed = pruneSnapshots(dir, 1);
    expect(removed).toHaveLength(3);
    expect(listSnapshots(dir)).toHaveLength(1);
    expect(latestSnapshot(dir).name).toContain('T04-00-00');
  });

  it('defaults to keeping SNAPSHOT_KEEP snapshots', () => {
    for (let h = 1; h <= SNAPSHOT_KEEP + 2; h++) {
      writeSnapshotBytes(Buffer.from(String(h)), {
        dir, date: new Date(`2026-06-08T${String(h).padStart(2, '0')}:00:00Z`),
      });
    }
    expect(listSnapshots(dir)).toHaveLength(SNAPSHOT_KEEP);
  });

  // recoverFromSnapshot's negative paths return BEFORE touching the WASM engine,
  // so they're unit-testable; the restore round-trip is integration-tested live.
  it('recoverFromSnapshot reports no-snapshot when none exist', async () => {
    const r = await recoverFromSnapshot({ which: 'latest', dir });
    expect(r).toEqual({ restored: false, reason: 'no-snapshot' });
  });

  it('recoverFromSnapshot reports snapshot-not-found for an unknown name', async () => {
    writeSnapshotBytes(Buffer.from('x'), { dir, date: new Date('2026-06-08T10:00:00Z') });
    const r = await recoverFromSnapshot({ which: 'db-9999-does-not-exist.tgz', dir });
    expect(r).toEqual({ restored: false, reason: 'snapshot-not-found' });
  });
});
