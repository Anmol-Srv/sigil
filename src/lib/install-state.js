/**
 * Install-integrity check (S2).
 *
 * The recurring "Aborted()" corruption was a DUELING INSTALL: a leftover global
 * npm copy kept its own daemon + PGlite version running alongside the git
 * install, and both opened the single-process embedded DB. The tell — visible
 * for days but flagged by nothing — was a silent version/path skew: the shims,
 * the running daemon, and the installed code all disagreed.
 *
 * This module makes that skew loud. It is ANCHORED ON THE CANONICAL GIT INSTALL
 * at ~/.sigil/app (read by absolute path), NOT on the currently-executing
 * package — so even a foreign copy running `sigil doctor` reports the truth
 * about the blessed install rather than declaring itself fine. The check feeds
 * a hard-fail line in `sigil doctor` and a loud warning at daemon boot.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SIGIL_HOME = join(homedir(), '.sigil');
export const CANONICAL_APP_DIR = join(SIGIL_HOME, 'app');
const CANONICAL_DIST = join(CANONICAL_APP_DIR, 'dist');
const CANONICAL_PKG = join(CANONICAL_APP_DIR, 'package.json');
const LAUNCHER_SHIM = join(SIGIL_HOME, 'bin', 'sigil');
const HEARTBEAT = join(SIGIL_HOME, 'heartbeat.json');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Trailing-slash-insensitive path compare — `/a/dist` and `/a/dist/` are the
// same install dir.
function samePath(a, b) {
  if (!a || !b) return false;
  const strip = (p) => p.replace(/\/+$/, '');
  return strip(a) === strip(b);
}

/**
 * Pull the SIGIL_DIST the launcher shim resolves to. The shim is generated
 * POSIX sh with a `SIGIL_DIST='<path>'` line (see shim.js). Returns null when
 * there is no shim or no recognizable line.
 */
export function readShimDist(shimPath = LAUNCHER_SHIM) {
  try {
    const m = readFileSync(shimPath, 'utf8').match(/^SIGIL_DIST='(.*)'\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Facts about the canonical git install at ~/.sigil/app. */
export function canonicalInstall() {
  return {
    dir: CANONICAL_APP_DIR,
    dist: CANONICAL_DIST,
    exists: existsSync(join(CANONICAL_APP_DIR, '.git')),
    version: readJson(CANONICAL_PKG)?.version || null,
  };
}

export function readHeartbeat(path = HEARTBEAT) {
  return readJson(path);
}

/** Read everything the integrity diff needs off disk, in one place. */
export function gatherInstallState() {
  return {
    canonical: canonicalInstall(),
    shimDist: readShimDist(),
    heartbeat: readHeartbeat(),
  };
}

/**
 * Pure comparison — given a gathered state, return the integrity verdict. Split
 * from the IO so it is trivially unit-testable.
 *
 * @returns {{applicable:boolean, ok?:boolean, issues?:Array<{code,message,fix}>,
 *            reason?:string, canonical:object, shimDist?:string|null, daemon?:object|null}}
 */
export function diffInstallState({ canonical, shimDist, heartbeat } = {}) {
  // Only meaningful once the installer has placed a canonical git install. A dev
  // run from a source checkout with no ~/.sigil/app is exempt (nothing to align
  // against) — return applicable:false so callers can stay quiet.
  if (!canonical?.exists) {
    return { applicable: false, reason: 'no-canonical-install', canonical };
  }

  const issues = [];

  if (shimDist && !samePath(shimDist, canonical.dist)) {
    issues.push({
      code: 'shim-mismatch',
      message: `launcher shims point at ${shimDist}, not the git install (${canonical.dist})`,
      fix: 'sigil update --force   (re-pins the shims; or reinstall via the curl installer)',
    });
  }

  if (heartbeat?.version && canonical.version && heartbeat.version !== canonical.version) {
    issues.push({
      code: 'daemon-stale',
      message: `daemon is running v${heartbeat.version}`
        + `${heartbeat.pid ? ` (pid ${heartbeat.pid})` : ''} but the git install is v${canonical.version}`,
      fix: 'sigil daemon restart',
    });
  }

  // heartbeat.root is the daemon's package root (added to the heartbeat for S2).
  // A daemon serving from a path that isn't the canonical install is exactly the
  // dueling-install state.
  if (heartbeat?.root && !samePath(heartbeat.root, canonical.dir)) {
    issues.push({
      code: 'daemon-foreign-root',
      message: `daemon is running from ${heartbeat.root}, not the git install (${canonical.dir})`,
      fix: 'sigil daemon restart   (starts it from the git install)',
    });
  }

  return { applicable: true, ok: issues.length === 0, issues, canonical, shimDist, daemon: heartbeat || null };
}

/** Gather + diff in one call — the entry point for doctor and daemon boot. */
export function checkInstallIntegrity() {
  return diffInstallState(gatherInstallState());
}
