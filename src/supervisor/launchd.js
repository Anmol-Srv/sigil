/**
 * macOS launchd backend — a per-user LaunchAgent with RunAtLoad + KeepAlive so
 * the daemon starts on login and is auto-restarted on crash/logout/reboot.
 */
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { SIGIL_DAEMON_LOG } from '../lib/paths.js';
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

export function restart() {
  const r = sh('launchctl', ['kickstart', '-k', serviceTarget()]);
  return { ok: r.code === 0, manager: MANAGER };
}

export function start() {
  // stop() boots the service OUT of the domain (so KeepAlive can't resurrect
  // it), and `kickstart` only works on a service that is still LOADED. So a
  // plain kickstart here failed with "No such process" after every stop —
  // `sigil service stop` followed by `sigil service start` could never bring
  // the daemon back, which is the exact sequence an upgrade or repair uses.
  // Load it first when it isn't loaded; kickstart alone is right when it is.
  if (!status().loaded) {
    const path = plistPath();
    if (!existsSync(path)) {
      return { ok: false, manager: MANAGER, error: `service not installed (${path} missing) — run \`sigil service install\`` };
    }
    let r = sh('launchctl', ['bootstrap', domainTarget(), path]);
    if (r.code !== 0) r = sh('launchctl', ['load', '-w', path]); // legacy macOS
    if (r.code !== 0) return { ok: false, manager: MANAGER, error: r.err || 'launchctl bootstrap/load failed' };
  }
  const k = sh('launchctl', ['kickstart', serviceTarget()]);
  return { ok: k.code === 0, manager: MANAGER };
}

export function stop() {
  // Bootout so KeepAlive doesn't immediately resurrect it.
  const r = sh('launchctl', ['bootout', serviceTarget()]);
  return { ok: r.code === 0, manager: MANAGER };
}
