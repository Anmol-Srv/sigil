/**
 * macOS launchd backend — a per-user LaunchAgent with RunAtLoad + KeepAlive so
 * the daemon starts on login and is auto-restarted on crash/logout/reboot.
 */
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { SIGIL_DAEMON_LOG } from '../lib/paths.js';
import { isPidAlive, readPidFile } from '../daemon/lifecycle.js';
import { resolveDaemonScript, nodeExecPath } from './entry-path.js';
import { sh } from './sh.js';

export const LABEL = 'live.airtribe.sigil';
export const MANAGER = 'launchd';

function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function domainTarget() {
  return `gui/${process.getuid()}`;
}

function serviceTarget() {
  return `${domainTarget()}/${LABEL}`;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistXml() {
  const node = nodeExecPath();
  const script = resolveDaemonScript();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(script)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Minimum seconds between respawns. With KeepAlive a daemon that crashes
       on startup would otherwise be relaunched as fast as it dies, pinning a
       CPU core and spamming the log. 10s is launchd's default; we set it
       explicitly so the back-off is documented and survives plist edits. -->
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(SIGIL_DAEMON_LOG)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(SIGIL_DAEMON_LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SIGIL_SUPERVISED</key><string>1</string>
  </dict>
</dict>
</plist>
`;
}

export function install() {
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plistXml(), 'utf8');

  // Modern bootstrap; if a stale label is loaded, bootout then retry; finally
  // fall back to the legacy load -w for older macOS.
  let r = sh('launchctl', ['bootstrap', domainTarget(), path]);
  if (r.code !== 0) {
    sh('launchctl', ['bootout', serviceTarget()]);
    r = sh('launchctl', ['bootstrap', domainTarget(), path]);
    if (r.code !== 0) {
      const legacy = sh('launchctl', ['load', '-w', path]);
      if (legacy.code !== 0) {
        throw new Error(`launchctl bootstrap/load failed: ${r.err || legacy.err || 'unknown'}`);
      }
    }
  }
  // Start immediately (kickstart -k restarts if already up).
  sh('launchctl', ['kickstart', '-k', serviceTarget()]);
  return { installed: true, manager: MANAGER, unitPath: path };
}

export function uninstall() {
  const path = plistPath();
  sh('launchctl', ['bootout', serviceTarget()]);
  sh('launchctl', ['unload', '-w', path]); // legacy, harmless if already booted out
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
  return { installed: false, manager: MANAGER, unitPath: path };
}

export function status() {
  const path = plistPath();
  const installed = existsSync(path);
  const loaded = sh('launchctl', ['list', LABEL]).code === 0;
  return { installed, loaded, running: loaded, manager: MANAGER, unitPath: path };
}

/**
 * A bootout removes launchd's ownership of the job but does not guarantee an
 * already-running child is terminated. Release that exact daemon PID before
 * loading the replacement, otherwise PGlite's single-writer lock causes a
 * false-success restart where the new process exits as "already running".
 */
export async function releaseDaemonForServiceReload({
  readPid = readPidFile,
  alive = isPidAlive,
  signal = (pid, value) => process.kill(pid, value),
  sleep = delay,
  now = () => Date.now(),
} = {}) {
  const pid = await readPid();
  if (!pid || !alive(pid)) return true;

  try { signal(pid, 'SIGTERM'); } catch { return !alive(pid); }
  const deadline = now() + 10_000;
  while (now() < deadline && alive(pid)) await sleep(50);
  if (!alive(pid)) return true;

  // This is the same last-resort behavior as `sigil daemon stop`: the
  // graceful period protects the PGlite checkpoint; SIGKILL only prevents an
  // unrecoverable stale owner from blocking a user-requested service restart.
  try { signal(pid, 'SIGKILL'); } catch { return !alive(pid); }
  await sleep(50);
  return !alive(pid);
}

export async function restart({ release = releaseDaemonForServiceReload } = {}) {
  // First remove the job so KeepAlive cannot respawn the old process while we
  // wait for the daemon to flush its embedded store and release the socket.
  sh('launchctl', ['bootout', serviceTarget()]);
  const released = await release();
  if (!released) return { ok: false, manager: MANAGER };

  const loaded = sh('launchctl', ['bootstrap', domainTarget(), plistPath()]);
  if (loaded.code === 0) {
    const started = sh('launchctl', ['kickstart', serviceTarget()]);
    return { ok: started.code === 0, manager: MANAGER };
  }

  // If the service was already reloaded by launchd between the two commands,
  // retain the old kickstart path as a narrow recovery attempt. Storage has
  // already been released above, so this cannot create a competing daemon.
  const fallback = sh('launchctl', ['kickstart', '-k', serviceTarget()]);
  return { ok: fallback.code === 0, manager: MANAGER };
}

export function start() {
  const r = sh('launchctl', ['kickstart', serviceTarget()]);
  return { ok: r.code === 0, manager: MANAGER };
}

export function stop() {
  // Bootout so KeepAlive doesn't immediately resurrect it.
  const r = sh('launchctl', ['bootout', serviceTarget()]);
  return { ok: r.code === 0, manager: MANAGER };
}
