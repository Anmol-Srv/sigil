/**
 * Cross-platform "always-up" supervisor. Picks a backend by platform
 * (launchd / systemd / scheduled-task) and exposes a uniform interface used by
 * `sigil service …` (CLI) and the service* RPCs (GUI finish step).
 *
 *   installService()   — stop any unsupervised daemon, then install + start the
 *                        OS service (RunAtLoad/KeepAlive semantics).
 *   uninstallService() — remove the service unit.
 *   serviceStatus()    — { platform, supervisor:{installed,running,manager,…},
 *                          heartbeat:{pid,ts,ageMs,…} }
 *   start/stop/restartService()
 */
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { AppError } from '../lib/errors.js';
import { SIGIL_HEARTBEAT } from '../lib/paths.js';

function backendLoader() {
  switch (process.platform) {
    case 'darwin': return () => import('./launchd.js');
    case 'linux': return () => import('./systemd.js');
    case 'win32': return () => import('./windows.js');
    default: return null;
  }
}

async function backend() {
  const load = backendLoader();
  if (!load) {
    throw new AppError({
      errorCode: 'SUPERVISOR_UNSUPPORTED_PLATFORM',
      message: `no always-up backend for platform "${process.platform}"`,
    });
  }
  return load();
}

export function platformSupported() {
  return backendLoader() !== null;
}

function readHeartbeat() {
  try {
    const raw = JSON.parse(readFileSync(SIGIL_HEARTBEAT, 'utf8'));
    return { ...raw, ageMs: typeof raw.ts === 'number' ? Date.now() - raw.ts : null };
  } catch {
    return null;
  }
}

// Stop a non-supervised daemon so the OS service can bind the socket cleanly.
// Without this, the supervised instance would exit on the "already running"
// guard and KeepAlive would crash-loop it.
async function stopUnsupervisedDaemon() {
  const { readPidFile, isPidAlive } = await import('../daemon/lifecycle.js');
  const pid = await readPidFile();
  if (!pid || !isPidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isPidAlive(pid)) await delay(50);
  if (isPidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
}

// Write + load the service unit WITHOUT stopping any running daemon. Safe to
// call from inside the daemon itself (it then hands off by self-exiting, and
// launchd KeepAlive / systemd Restart rebinds the socket).
export async function installServiceUnit() {
  const mod = await backend();
  try {
    return mod.install();
  } catch (err) {
    throw new AppError({ errorCode: 'SUPERVISOR_INSTALL_FAILED', message: err.message });
  }
}

// CLI path: a separate process installs the service, so it first stops the
// unsupervised daemon, letting the OS service own the socket cleanly.
export async function installService() {
  await stopUnsupervisedDaemon();
  return installServiceUnit();
}

export async function uninstallService() {
  return (await backend()).uninstall();
}

export async function startService() {
  return (await backend()).start();
}

export async function stopService() {
  return (await backend()).stop();
}

export async function restartService() {
  return (await backend()).restart();
}

// Rewrite an already-installed service's runtime path, then restart it. This
// deliberately does not call install(): a normal update must not enable
// automatic start for someone who opted out of it.
export async function refreshService() {
  return (await backend()).refresh();
}

export async function serviceStatus() {
  let supervisor;
  try {
    supervisor = (await backend()).status();
  } catch {
    supervisor = { installed: false, running: false, manager: null, unitPath: null, unsupported: true };
  }
  return { platform: process.platform, supervisor, heartbeat: readHeartbeat() };
}

export async function isServiceInstalled() {
  try {
    return (await backend()).status().installed;
  } catch {
    return false;
  }
}
