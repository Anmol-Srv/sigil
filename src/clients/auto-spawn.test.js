// Tests for the F5 spawn lock + busy error — the concurrency cap that stops a
// burst of CLI/hook processes from each forking a daemon, and the typed error
// that tells callers "alive but wedged, do not respawn".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acquireSpawnLock,
  releaseSpawnLock,
  SigilDaemonBusyError,
  SPAWN_LOCK_TTL_MS,
} from './auto-spawn.js';

describe('spawn lock (F5 concurrency cap)', () => {
  let dir;
  let lock;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sigil-spawnlock-'));
    lock = join(dir, '.spawn.lock');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('grants the lock to exactly one of two contenders', () => {
    expect(acquireSpawnLock(lock)).toBe(true);
    // A second acquire while the first holds a FRESH lock (our own live pid) must fail.
    expect(acquireSpawnLock(lock)).toBe(false);
    releaseSpawnLock(lock);
    expect(existsSync(lock)).toBe(false);
    // After release the lock is grantable again.
    expect(acquireSpawnLock(lock)).toBe(true);
  });

  it('steals a lock held by a dead pid', () => {
    // A pid that is (almost certainly) not alive.
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 31 - 1, ts: Date.now() }));
    expect(acquireSpawnLock(lock)).toBe(true);
  });

  it('steals a lock older than the TTL even if the pid is live', () => {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() - SPAWN_LOCK_TTL_MS - 1 }));
    expect(acquireSpawnLock(lock)).toBe(true);
  });

  it('steals a corrupt lock file rather than deadlocking', () => {
    writeFileSync(lock, 'garbage{');
    expect(acquireSpawnLock(lock)).toBe(true);
  });

  it('does NOT steal a fresh lock owned by a live pid', () => {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    expect(acquireSpawnLock(lock)).toBe(false);
  });
});

describe('SigilDaemonBusyError', () => {
  it('carries the pid, a daemon_busy code, and an actionable message', () => {
    const e = new SigilDaemonBusyError(4242);
    expect(e.name).toBe('SigilDaemonBusyError');
    expect(e.code).toBe('daemon_busy');
    expect(e.pid).toBe(4242);
    expect(e.message).toContain('4242');
    expect(e.message).toContain('daemon restart');
  });
});
