/**
 * Windows backend — a Scheduled Task that runs the daemon at logon. Dependency-
 * free (schtasks ships with Windows); a richer nssm/service shim can replace it
 * later without changing the supervisor interface.
 *
 * Note: schtasks ONLOGON does not auto-restart on crash like launchd KeepAlive /
 * systemd Restart=always. The daemon's own auto-spawn (on next CLI call) covers
 * crash-recovery within a session; reboot/logon recovery is handled here.
 */
import { resolveDaemonScript, nodeExecPath } from './entry-path.js';
import { sh } from './sh.js';

export const TASK = 'Sigil';
export const MANAGER = 'schtasks';

function taskRun() {
  // Quote both paths; schtasks needs the whole /TR value quoted with escaped
  // inner quotes.
  return `\\"${nodeExecPath()}\\" \\"${resolveDaemonScript()}\\"`;
}

export function registerTask() {
  const r = sh('schtasks', [
    '/Create', '/SC', 'ONLOGON', '/TN', TASK,
    '/TR', taskRun(), '/RL', 'LIMITED', '/F',
  ]);
  if (r.code !== 0) throw new Error(`schtasks /Create failed: ${r.err || 'unknown'}`);
}

export function install() {
  registerTask();
  sh('schtasks', ['/Run', '/TN', TASK]);
  return { installed: true, manager: MANAGER, unitPath: `Task Scheduler\\${TASK}` };
}

export function uninstall() {
  sh('schtasks', ['/Delete', '/TN', TASK, '/F']);
  return { installed: false, manager: MANAGER, unitPath: `Task Scheduler\\${TASK}` };
}

export function status() {
  const q = sh('schtasks', ['/Query', '/TN', TASK]);
  const installed = q.code === 0;
  const running = installed && /Running/i.test(q.out);
  return { installed, loaded: installed, running, manager: MANAGER, unitPath: `Task Scheduler\\${TASK}` };
}

export function restart() {
  sh('schtasks', ['/End', '/TN', TASK]);
  const r = sh('schtasks', ['/Run', '/TN', TASK]);
  return { ok: r.code === 0, manager: MANAGER };
}

// Re-register with the current executable first, then restart. Re-registering
// an existing task with /F preserves its logon schedule; this is the Windows
// equivalent of a launchd/systemd service refresh.
export function refresh({ register = registerTask, restartService = restart } = {}) {
  try {
    register();
  } catch {
    return { ok: false, manager: MANAGER };
  }
  return restartService();
}

export function start() {
  const r = sh('schtasks', ['/Run', '/TN', TASK]);
  return { ok: r.code === 0, manager: MANAGER };
}

export function stop() {
  const r = sh('schtasks', ['/End', '/TN', TASK]);
  return { ok: r.code === 0, manager: MANAGER };
}
