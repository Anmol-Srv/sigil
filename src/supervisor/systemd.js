/**
 * Linux systemd backend — a per-user service (Restart=always) plus lingering so
 * it survives logout and starts at boot.
 */
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, userInfo } from 'node:os';

import { SIGIL_DAEMON_LOG } from '../lib/paths.js';
import { resolveDaemonScript, nodeExecPath } from './entry-path.js';
import { sh } from './sh.js';

export const UNIT = 'sigil.service';
export const MANAGER = 'systemd';

function unitPath() {
  return join(homedir(), '.config', 'systemd', 'user', UNIT);
}

function unitFile() {
  const node = nodeExecPath();
  const script = resolveDaemonScript();
  return `[Unit]
Description=Sigil memory daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${node} ${script}
Restart=always
RestartSec=2
Environment=SIGIL_SUPERVISED=1
StandardOutput=append:${SIGIL_DAEMON_LOG}
StandardError=append:${SIGIL_DAEMON_LOG}

[Install]
WantedBy=default.target
`;
}

function uctl(args) {
  return sh('systemctl', ['--user', ...args]);
}

export function writeServiceUnit() {
  const path = unitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unitFile(), 'utf8');
  return path;
}

export function install() {
  const path = writeServiceUnit();
  uctl(['daemon-reload']);
  const r = uctl(['enable', '--now', UNIT]);
  if (r.code !== 0) {
    throw new Error(`systemctl --user enable --now failed: ${r.err || 'unknown'}`);
  }
  // Best-effort: survive logout / start at boot.
  sh('loginctl', ['enable-linger', userInfo().username]);
  return { installed: true, manager: MANAGER, unitPath: path };
}

export function uninstall() {
  const path = unitPath();
  uctl(['disable', '--now', UNIT]);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
  uctl(['daemon-reload']);
  return { installed: false, manager: MANAGER, unitPath: path };
}

export function status() {
  const path = unitPath();
  const enabled = uctl(['is-enabled', UNIT]).out === 'enabled';
  const active = uctl(['is-active', UNIT]).out === 'active';
  return { installed: existsSync(path) || enabled, loaded: enabled, running: active, manager: MANAGER, unitPath: path };
}

export function restart() {
  const r = uctl(['restart', UNIT]);
  return { ok: r.code === 0, manager: MANAGER };
}

// Unlike install(), this never enables the service. It updates the command
// path of a service the user already chose to run automatically, reloads
// systemd's unit cache, then restarts exactly that unit.
export function refresh({
  writeUnit = writeServiceUnit,
  reload = () => uctl(['daemon-reload']),
  restartService = restart,
} = {}) {
  writeUnit();
  const reloaded = reload();
  if (reloaded.code !== 0) return { ok: false, manager: MANAGER };
  return restartService();
}

export function start() {
  const r = uctl(['start', UNIT]);
  return { ok: r.code === 0, manager: MANAGER };
}

export function stop() {
  const r = uctl(['stop', UNIT]);
  return { ok: r.code === 0, manager: MANAGER };
}
