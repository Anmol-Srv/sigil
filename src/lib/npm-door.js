/**
 * npm door — makes `npm i -g @anmol-srv/sigil` and `npx @anmol-srv/sigil` land
 * on the SAME single install as the curl installer.
 *
 * Sigil has exactly one owner of the daemon + embedded DB: the git install at
 * ~/.sigil/app. Two copies running side by side (an npm global and the git
 * clone) fight over the single-process PGlite cluster and corrupt it. So the
 * npm package never runs Sigil from its own directory. Its `sigil` bin is a
 * door:
 *
 *   1. No install yet           → run the bundled install.sh (same installer as
 *                                  curl), then hand off.
 *   2. Install older than npm   → bring it up to date with the bundled installer,
 *                                  then finish the update (shims, daemon,
 *                                  migrations) from the freshly updated code.
 *   3. Otherwise                → hand off straight to ~/.sigil/bin/sigil.
 *
 * Because both channels are published from the same CI run with the same
 * version, `npm i -g @anmol-srv/sigil@latest` doubles as an update command.
 *
 * Only Node built-ins here — this runs before anything else in the CLI.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

// npm releases before this version were full, self-running installs (the
// pre-door distribution). They own a daemon of their own, so the installer and
// `sigil update` evict them. Door releases (>= this) are left alone.
export const FIRST_DOOR_VERSION = '0.22.0';

/** Compare two x.y.z versions numerically (pre-release tags ignored). */
export function compareVersions(a, b) {
  const parse = (v) => String(v || '0').replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function isLegacyNpmVersion(version) {
  return compareVersions(version, FIRST_DOOR_VERSION) < 0;
}

function strip(p) {
  return String(p).replace(/[/\\]+$/, '');
}

/**
 * Is this package running from a package-manager directory (npm global, npx
 * cache, pnpm/yarn/bun store) rather than from the canonical git install or a
 * source checkout? Only then does the door take over.
 */
export function isDoorRoot(pkgRoot, appDir) {
  if (!pkgRoot) return false;
  if (strip(pkgRoot) === strip(appDir)) return false;
  return strip(pkgRoot).split(sep).includes('node_modules');
}

function readVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

/**
 * Decide what the door has to do. Pure, so the decision table is unit-tested.
 *
 * @param {object} s
 * @param {string}  s.doorVersion   version of this npm package
 * @param {boolean} s.appInstalled  ~/.sigil/app exists
 * @param {string}  [s.appVersion]  its version
 * @param {boolean} s.hasDatabase   the user already has a Sigil database
 * @param {boolean} [s.attempted]   a catch-up to doorVersion was already tried
 * @returns {{install:boolean, finish:boolean, reason:string}}
 *   install → run the bundled installer (fresh clone or catch-up update)
 *   finish  → afterwards run `sigil update --finish` (daemon restart + migrations)
 */
export function planDoor({ doorVersion, appInstalled, appVersion, hasDatabase, attempted = false }) {
  if (!appInstalled) {
    // A legacy npm user already has data in ~/.sigil: the move to the git
    // install must restart their daemon and migrate their database.
    return { install: true, finish: Boolean(hasDatabase), reason: hasDatabase ? 'migrate-legacy' : 'fresh' };
  }
  if (compareVersions(appVersion, doorVersion) < 0) {
    // Try once per npm version. If the release branch hasn't caught up yet (npm
    // is published first) or the network is down, don't redo the install and
    // restart the daemon on every command — the daemon's update check and
    // `sigil update` take it from here.
    if (attempted) return { install: false, finish: false, reason: 'catch-up-tried' };
    return { install: true, finish: Boolean(hasDatabase), reason: 'update' };
  }
  return { install: false, finish: false, reason: 'current' };
}

/** Does this machine already have a Sigil database worth restarting + migrating? */
function hasDatabase(sigilHome) {
  if (existsSync(join(sigilHome, '.env')) || existsSync(join(sigilHome, 'db'))) return true;
  try {
    const cfg = JSON.parse(readFileSync(join(sigilHome, 'config.json'), 'utf8'));
    return cfg?.setup?.steps?.database === 'done';
  } catch {
    return false;
  }
}

// Installer + finish output goes to stderr so `sigil <cmd> | …` stays clean.
function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: ['inherit', 2, 'inherit'], env });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

/** Update an existing ~/.sigil/app to this npm version. Returns false on failure. */
function catchUp({ pkgRoot, appDir, launcher, finish }) {
  const rev = spawnSync('git', ['-C', appDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const from = rev.status === 0 ? rev.stdout.trim() : null;
  try {
    // SIGIL_SKIP_TMUX: an update shouldn't try to sudo-install tmux again.
    const env = { ...process.env, SIGIL_NO_LAUNCH: '1', SIGIL_SKIP_TMUX: '1' };
    if (run('sh', [join(pkgRoot, 'install.sh')], env) !== 0) return false;
    if (!finish) return true;
    const finishArgs = ['update', '--finish'];
    if (from) finishArgs.push('--from', from);
    return run(launcher, finishArgs, process.env) === 0;
  } catch {
    return false;
  }
}

/**
 * Run the door and exit the process. Never returns.
 *
 * @param {{pkgRoot:string, version:string, args:string[]}} opts
 */
export function runDoor({ pkgRoot, version, args }) {
  // The launcher shim falls back to `sigil` on PATH when ~/.sigil/app is
  // missing its CLI — which can be this door. Re-entering means the install is
  // broken; stop instead of bouncing between the two forever.
  if (process.env.SIGIL_DOOR_ACTIVE === '1') {
    process.stderr.write('Sigil install at ~/.sigil/app is broken (its CLI is missing).\n'
      + 'Repair it: rm -rf ~/.sigil/app && sigil   (your memories and config are kept)\n');
    process.exit(1);
  }

  const sigilHome = join(homedir(), '.sigil');
  const appDir = join(sigilHome, 'app');
  const launcher = join(sigilHome, 'bin', 'sigil');

  const stamp = join(sigilHome, '.npm-catch-up');
  let attempted = false;
  try { attempted = readFileSync(stamp, 'utf8').trim() === version; } catch { /* none */ }

  const appInstalled = existsSync(join(appDir, '.git'));
  const plan = planDoor({
    doorVersion: version,
    appInstalled,
    appVersion: readVersion(appDir),
    hasDatabase: hasDatabase(sigilHome),
    attempted,
  });

  if (plan.install && appInstalled) {
    // Catching up an existing install: a failure must never lock the user out.
    try { writeFileSync(stamp, version + '\n'); } catch { /* best-effort */ }
    if (!catchUp({ pkgRoot, appDir, launcher, finish: plan.finish })) {
      process.stderr.write(`(warning) could not update Sigil to ${version} — continuing with ${readVersion(appDir) || 'the installed version'}. `
        + 'Run `sigil update` to retry.\n');
    } else if (compareVersions(readVersion(appDir), version) >= 0) {
      try { rmSync(stamp, { force: true }); } catch { /* best-effort */ }
    }
  } else if (plan.install) {
    // First install (or a legacy npm user moving over): nothing to fall back to.
    const status = run('sh', [join(pkgRoot, 'install.sh')], { ...process.env, SIGIL_NO_LAUNCH: '1' });
    if (status !== 0) process.exit(status);
    if (plan.finish) {
      const s = run(launcher, ['update', '--finish'], process.env);
      if (s !== 0) process.exit(s);
    }
  }

  if (!existsSync(launcher)) {
    process.stderr.write(`Sigil install is incomplete — ${launcher} is missing.\n`
      + 'Re-run: npm i -g @anmol-srv/sigil  (or the curl installer)\n');
    process.exit(1);
  }
  const r = spawnSync(launcher, args, { stdio: 'inherit', env: { ...process.env, SIGIL_DOOR_ACTIVE: '1' } });
  if (r.error) {
    process.stderr.write(`Could not start Sigil: ${r.error.message}\n`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
