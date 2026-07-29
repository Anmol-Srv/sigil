import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  PKG_ROOT,
  SIGIL_DAEMON_LOCK,
  SIGIL_DAEMON_PID,
  SIGIL_DAEMON_SOCK,
  SIGIL_HEARTBEAT,
  SIGIL_HOME,
} from '../lib/paths.js';

/**
 * Check whether a PID is alive. `process.kill(pid, 0)` is the POSIX trick:
 * signal 0 doesn't deliver anything, but the kernel still validates that
 * the target exists and the caller has permission to signal it.
 */
export function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (treat as alive)
    return err.code === 'EPERM';
  }
}

export async function readPidFile() {
  if (!existsSync(SIGIL_DAEMON_PID)) return null;
  try {
    const raw = (await readFile(SIGIL_DAEMON_PID, 'utf8')).trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function writePidFile() {
  await mkdir(SIGIL_HOME, { recursive: true });
  await writeFile(SIGIL_DAEMON_PID, String(process.pid), 'utf8');
}

export async function removePidFile() {
  try { await unlink(SIGIL_DAEMON_PID); } catch { /* missing is fine */ }
}

export async function removeSocketFile() {
  try { await unlink(SIGIL_DAEMON_SOCK); } catch { /* missing is fine */ }
}

function readDaemonLock(path = SIGIL_DAEMON_LOCK) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * The daemon lifetime lock replaces the GUI port as the split-brain guard.
 * Keeping storage safe must not require loading an HTTP/WebSocket server.
 */
export function daemonLockDecision(existing, { selfPid = process.pid, isAlive = isPidAlive } = {}) {
  if (!existing || !Number.isInteger(existing.pid)) return 'reclaim';
  if (existing.pid === selfPid) return 'held';
  return isAlive(existing.pid) ? 'refuse' : 'reclaim';
}

let heldDaemonLock = null;

export function acquireDaemonLock(path = SIGIL_DAEMON_LOCK) {
  const record = JSON.stringify({
    pid: process.pid,
    root: PKG_ROOT,
    startedAt: Date.now(),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, record, 'utf8'); } finally { closeSync(fd); }
      heldDaemonLock = path;
      return { acquired: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readDaemonLock(path);
      const decision = daemonLockDecision(existing);
      if (decision === 'held') {
        heldDaemonLock = path;
        return { acquired: true };
      }
      if (decision === 'refuse') {
        const lockErr = new Error(
          `sigild is already owned by process ${existing.pid}`
          + `${existing.root ? ` at ${existing.root}` : ''}`,
        );
        lockErr.code = 'daemon_owned';
        lockErr.owner = existing;
        throw lockErr;
      }
      try { unlinkSync(path); } catch { /* another contender reclaimed it */ }
    }
  }

  const lockErr = new Error(`could not acquire daemon lock ${path}`);
  lockErr.code = 'daemon_owned';
  lockErr.owner = readDaemonLock(path);
  throw lockErr;
}

export function releaseDaemonLock(path = heldDaemonLock || SIGIL_DAEMON_LOCK) {
  if (!path) return;
  const existing = readDaemonLock(path);
  if (existing?.pid === process.pid) {
    try { unlinkSync(path); } catch { /* missing is fine */ }
  }
  if (heldDaemonLock === path) heldDaemonLock = null;
}

// The daemon refreshes heartbeat.json every 15s. Treat a heartbeat as stale
// after three missed beats — long enough to absorb scheduling jitter / a busy
// event loop, short enough that a recycled PID can't masquerade as live for
// long.
const HEARTBEAT_STALE_MS = 45_000;

/** Best-effort read of the full heartbeat record ({ pid, ts, ... }). */
async function readHeartbeat() {
  try {
    return JSON.parse(await readFile(SIGIL_HEARTBEAT, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Returns the live daemon PID if one is running, otherwise null and cleans
 * up any stale pid/socket files. Call this before starting a new daemon.
 *
 * A live PID is NOT sufficient on its own: `process.kill(pid, 0)` only proves
 * *some* process owns that PID, not that it's our daemon. After a hard kill or
 * a reboot the pidfile can name a recycled PID now held by an unrelated process
 * (or, via the EPERM branch in isPidAlive, another user's process) — which used
 * to make the booting daemon declare itself a duplicate and exit without ever
 * binding its socket. A fresh heartbeat confirms identity. The separate
 * lifetime lock closes the race between two processes that both observe stale
 * state at the same time.
 */
export async function detectRunningDaemon() {
  const pid = await readPidFile();
  const hb = await readHeartbeat();
  const freshHeartbeat = hb
    && Number.isFinite(hb.ts)
    && (Date.now() - hb.ts) < HEARTBEAT_STALE_MS
    && Number.isFinite(hb.pid)
    && isPidAlive(hb.pid);

  // A live PID only counts as *our* daemon if a fresh heartbeat confirms it.
  if (pid && isPidAlive(pid)) {
    if (freshHeartbeat && hb.pid === pid) return pid;
  }

  // A fresh daemon writes its heartbeat immediately before or after the pidfile.
  // Trust that short startup window only when no conflicting pidfile exists.
  if (!pid && freshHeartbeat) return hb.pid;

  // Genuinely stale — clean up so a fresh start succeeds.
  if (pid) await removePidFile();
  if (existsSync(SIGIL_DAEMON_SOCK)) await removeSocketFile();
  return null;
}

/**
 * Install signal handlers and an idempotent shutdown hook. The shutdown
 * callback is called at most once even if multiple signals arrive.
 */
export function installShutdownHooks(shutdown) {
  let firing = false;
  const fire = async (signal) => {
    if (firing) return;
    firing = true;
    try {
      await shutdown(signal);
    } catch (err) {
      process.stderr.write(`[sigild] shutdown error: ${err.message}\n`);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => fire('SIGTERM'));
  process.on('SIGINT',  () => fire('SIGINT'));
  process.on('SIGHUP',  () => fire('SIGHUP'));
}

export async function ensureSigilHome() {
  await mkdir(SIGIL_HOME, { recursive: true });
}

export { dirname };
