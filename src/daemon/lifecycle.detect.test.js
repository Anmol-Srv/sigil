// Regression tests for detectRunningDaemon's "is a daemon already running?"
// decision. The bug these guard against: a live PID alone was trusted, so a
// stale pidfile naming a *recycled* PID (now held by an unrelated process, e.g.
// after a hard kill or reboot) made the booting daemon declare itself a
// duplicate and exit without binding its socket — the CLI then timed out.
//
// The GUI is no longer part of liveness detection. We sandbox $HOME so
// SIGIL_HOME points at a throwaway dir; modules are re-imported per case because
// paths.js caches SIGIL_HOME from $HOME at import time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home;
const origHome = process.env.HOME;

function seed({ pid, heartbeat }) {
  const sigilHome = join(home, '.sigil');
  mkdirSync(sigilHome, { recursive: true });
  if (pid !== undefined) writeFileSync(join(sigilHome, 'sigild.pid'), String(pid), 'utf8');
  if (heartbeat !== undefined) {
    writeFileSync(join(sigilHome, 'heartbeat.json'), JSON.stringify(heartbeat), 'utf8');
  }
  return sigilHome;
}

async function loadDetect() {
  vi.resetModules(); // re-evaluate paths.js so SIGIL_HOME picks up the new $HOME
  return import('./lifecycle.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sigil-detect-test-'));
  process.env.HOME = home;
  const sigilHome = join(home, '.sigil');
  mkdirSync(sigilHome, { recursive: true });
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  rmSync(home, { recursive: true, force: true });
});

describe('detectRunningDaemon', () => {
  it('treats a live PID with NO heartbeat as stale (the recycled-PID case) and cleans up', async () => {
    // process.pid is unquestionably alive, but it is not our daemon and there
    // is no heartbeat to confirm it. This is exactly the recycled-PID scenario.
    const sigilHome = seed({ pid: process.pid });
    const { detectRunningDaemon } = await loadDetect();

    expect(await detectRunningDaemon()).toBeNull();
    expect(existsSync(join(sigilHome, 'sigild.pid'))).toBe(false); // stale pidfile removed
  });

  it('treats a live PID with a STALE heartbeat as stale and cleans up', async () => {
    const sigilHome = seed({
      pid: process.pid,
      heartbeat: { pid: process.pid, ts: Date.now() - 60_000 }, // older than the 45s window
    });
    const { detectRunningDaemon } = await loadDetect();

    expect(await detectRunningDaemon()).toBeNull();
    expect(existsSync(join(sigilHome, 'sigild.pid'))).toBe(false);
  });

  it('reports the PID as running when a FRESH heartbeat confirms it', async () => {
    const sigilHome = seed({
      pid: process.pid,
      heartbeat: { pid: process.pid, ts: Date.now() },
    });
    const { detectRunningDaemon } = await loadDetect();

    expect(await detectRunningDaemon()).toBe(process.pid);
    expect(existsSync(join(sigilHome, 'sigild.pid'))).toBe(true); // incumbent's files left intact
  });

  it('does not trust a fresh heartbeat whose pid disagrees with the pidfile', async () => {
    // Live pidfile PID, fresh heartbeat — but for a *different* pid. Without the
    // pid-match guard a recycled PID could ride in on a leftover heartbeat.
    seed({
      pid: process.pid,
      heartbeat: { pid: process.pid + 1, ts: Date.now() },
    });
    const { detectRunningDaemon } = await loadDetect();

    expect(await detectRunningDaemon()).toBeNull();
  });

  it('returns null on a clean slate (no pidfile, nothing serving)', async () => {
    mkdirSync(join(home, '.sigil'), { recursive: true });
    const { detectRunningDaemon } = await loadDetect();

    expect(await detectRunningDaemon()).toBeNull();
  });
});

describe('daemon lifetime lock', () => {
  it('refuses a lock held by another live process and reclaims a stale owner', async () => {
    const { daemonLockDecision } = await loadDetect();

    expect(daemonLockDecision(
      { pid: 200, root: '/old' },
      { selfPid: 100, isAlive: (pid) => pid === 200 },
    )).toBe('refuse');
    expect(daemonLockDecision(
      { pid: 200, root: '/old' },
      { selfPid: 100, isAlive: () => false },
    )).toBe('reclaim');
  });

  it('atomically acquires and releases an explicit lock path', async () => {
    const lockPath = join(home, '.sigil', '.test-daemon.lock');
    const { acquireDaemonLock, releaseDaemonLock } = await loadDetect();

    expect(acquireDaemonLock(lockPath)).toEqual({ acquired: true });
    expect(existsSync(lockPath)).toBe(true);

    releaseDaemonLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });
});
