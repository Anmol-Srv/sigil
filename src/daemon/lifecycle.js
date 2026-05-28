import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { SIGIL_DAEMON_PID, SIGIL_DAEMON_SOCK, SIGIL_HOME } from '../lib/paths.js';

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

/**
 * Returns the live daemon PID if one is running, otherwise null and cleans
 * up any stale pid/socket files. Call this before starting a new daemon.
 */
export async function detectRunningDaemon() {
  const pid = await readPidFile();
  if (pid && isPidAlive(pid)) return pid;
  // Stale state — clean up so a fresh start succeeds.
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
