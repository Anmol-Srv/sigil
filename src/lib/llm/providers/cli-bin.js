/**
 * Resolve a CLI provider's binary to an absolute path.
 *
 * The daemon is usually spawned by launchd/systemd with a stripped PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so a bare `spawn('claude')` fails with ENOENT
 * even though the binary is on the user's interactive PATH. This probes the
 * places CLIs actually install — most reliably the same bin dir as the node
 * running us (nvm/volta/global-npm put them next to `node`) — then asks the
 * user's LOGIN shell, which sources their profile and finds installs a fixed
 * candidate list misses. That last step is what fixes the common
 * "claude CLI not found" report from a supervised daemon.
 *
 * Extracted from claude-cli.js when the codex provider landed: both need the
 * identical stripped-PATH dance, and one copy that's been hardened by field
 * reports beats two that drift.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Resolve a command via the user's login shell (sources their profile/PATH). */
export function whichViaLoginShell(cmd) {
  const shell = process.env.SHELL || '/bin/sh';
  try {
    const r = spawnSync(shell, ['-lic', `command -v ${cmd}`], { encoding: 'utf8', timeout: 5000 });
    const out = (r.stdout || '').trim().split('\n').pop().trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} cmd            binary name, e.g. 'claude' | 'codex'
 * @param {string|null} configured absolute path from config (wins outright)
 * @param {string[]} extra        additional absolute candidates to probe first
 * @returns {string} absolute path, or `cmd` itself as a last resort (trust PATH)
 */
export function resolveCliBin(cmd, configured = null, extra = []) {
  if (configured) return configured;
  const home = homedir();
  const candidates = [
    ...extra,
    join(dirname(process.execPath), cmd), // next to the node that runs us (nvm/volta/npm)
    join(home, '.local', 'bin', cmd),
    `/opt/homebrew/bin/${cmd}`,
    `/usr/local/bin/${cmd}`,
    `/usr/bin/${cmd}`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return whichViaLoginShell(cmd) || cmd; // give up: trust PATH
}
