/**
 * Git-native install plumbing — the engine behind `sigil update` and the
 * daemon's background staleness check.
 *
 * Sigil is distributed FROM GIT, not npm: the installer (`install.sh`) clones
 * this repo's `release` branch into ~/.sigil/app, and an update is just a
 * fast-forward of that clone. There is no `npm publish` step — pushing to the
 * release branch IS the release. This module is the single place that knows how
 * to talk to that clone (is it a git install? how far behind is it? pull it),
 * so the CLI command and the daemon check can't drift in how they detect/apply
 * updates.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';

import { PKG_ROOT } from './paths.js';

// The legacy npm package name — the pre-git-native distribution channel.
const LEGACY_NPM_PKG = '@anmol-srv/sigil';

const run = promisify(execFile);

// The branch the installer tracks. Overridable for testing / pre-release lanes
// (SIGIL_BRANCH must match what install.sh cloned, or update would switch lanes).
export const RELEASE_BRANCH = process.env.SIGIL_BRANCH || 'release';
const REMOTE = 'origin';

/**
 * Is the running package a git clone we can update in place? True only when
 * PKG_ROOT is a real working tree (installer / `git clone`), false for the dev
 * checkout-as-symlink, an npm-era global install, or a tarball extraction.
 */
export function isGitInstall() {
  return existsSync(join(PKG_ROOT, '.git'));
}

async function git(args) {
  const { stdout } = await run('git', ['-C', PKG_ROOT, ...args], {
    encoding: 'utf8',
    // Never let a hung network fetch wedge the daemon's periodic check.
    timeout: 60_000,
  });
  return stdout.trim();
}

/** Short SHA of the working tree's HEAD. */
export async function localRev() {
  return git(['rev-parse', '--short', 'HEAD']);
}

/**
 * Compare the local clone against the remote release branch WITHOUT mutating the
 * working tree. Does a shallow `fetch` (network), then counts how many commits
 * HEAD is behind the freshly-fetched remote tip.
 *
 * @returns {Promise<{behind:number, local:string, remote:string, branch:string}>}
 */
export async function checkForUpdate() {
  await git(['fetch', '--depth', '1', '--quiet', REMOTE, RELEASE_BRANCH]);
  const local = await git(['rev-parse', 'HEAD']);
  const remote = await git(['rev-parse', 'FETCH_HEAD']);
  // `--count` of commits reachable from remote but not from HEAD. With a shallow
  // fetch this is 0 (in sync) or 1+ (behind) — exact count is best-effort.
  let behind = 0;
  if (local !== remote) {
    try {
      behind = Number(await git(['rev-list', '--count', `HEAD..FETCH_HEAD`])) || 1;
    } catch {
      behind = 1; // shallow histories can't always compute the range — treat as behind.
    }
  }
  return {
    behind,
    local: local.slice(0, 7),
    remote: remote.slice(0, 7),
    branch: RELEASE_BRANCH,
  };
}

/**
 * Decide whether `git status --porcelain` output represents local changes worth
 * PRESERVING before a hard reset. `npm install --omit=dev` rewrites the committed
 * package-lock.json on essentially every install, so a dirty lockfile is expected
 * churn, not a hand-edit — and `reset --hard` would restore it to the release
 * version anyway. We only care about changes to OTHER tracked files (a user who
 * hand-patched their install). Pure + exported for testing.
 *
 * @param {string} porcelain  raw `git status --porcelain` output
 * @returns {boolean}
 */
export function hasMeaningfulLocalChanges(porcelain) {
  return porcelain
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Drop the routine lockfile churn; everything else counts.
    .some((l) => !/(^|[/\s])package-lock\.json$/.test(l));
}

/**
 * Fast-forward the clone to the latest release tip. Uses `reset --hard` rather
 * than `pull`/`merge`: the release branch is a derived, force-pushed artifact
 * (built dist/ committed by CI), so a 3-way merge against a local checkout would
 * spuriously conflict. Resetting to the fetched tip is the correct, conflict-free
 * "make my tree exactly match the release" operation.
 *
 * Dirty-tree guard: a plain `reset --hard` would SILENTLY discard any local
 * edits to ~/.sigil/app. Before resetting we stash genuine hand-edits (recoverable
 * via `git -C ~/.sigil/app stash list`) so an update never destroys a user's
 * patches; if the stash itself fails we abort rather than reset over their work.
 *
 * @returns {Promise<{from:string, to:string, lockChanged:boolean, stashed:boolean}>}
 */
export async function applyUpdate() {
  const from = await git(['rev-parse', 'HEAD']);
  const lockBefore = await lockHash();

  let stashed = false;
  if (hasMeaningfulLocalChanges(await git(['status', '--porcelain']))) {
    try {
      await git(['stash', 'push', '--include-untracked', '-m', `sigil pre-update ${from.slice(0, 7)}`]);
      stashed = true;
    } catch (err) {
      const e = new Error(
        `${PKG_ROOT} has local changes that could not be stashed (${err.message.split('\n')[0]}). `
        + 'Refusing to discard them with a hard reset — commit, stash, or remove them, then re-run `sigil update`.',
      );
      e.code = 'dirty_install';
      throw e;
    }
  }

  await git(['fetch', '--depth', '1', '--quiet', REMOTE, RELEASE_BRANCH]);
  await git(['reset', '--hard', '--quiet', 'FETCH_HEAD']);
  const to = await git(['rev-parse', 'HEAD']);
  const lockAfter = await lockHash();
  return { from: from.slice(0, 7), to: to.slice(0, 7), lockChanged: lockBefore !== lockAfter, stashed };
}

/**
 * Hard-revert the install to an earlier revision — the code half of `sigil
 * update`'s auto-revert. When a post-update migration fails (and the daemon has
 * already rolled the schema back), we reset the working tree to the pre-update
 * commit so the code matches the restored schema. Returns the short SHA landed.
 *
 * @param {string} rev  a git revision (the `from` short SHA applyUpdate returned)
 */
export async function revertInstall(rev) {
  await git(['reset', '--hard', '--quiet', rev]);
  return git(['rev-parse', '--short', 'HEAD']);
}

// Blob hash of package-lock.json at HEAD — cheap way to know if `npm install`
// needs to re-run after an update (deps changed) vs being skippable (code-only).
async function lockHash() {
  try {
    return await git(['rev-parse', 'HEAD:package-lock.json']);
  } catch {
    return ''; // no lockfile tracked — caller will just always install.
  }
}

/**
 * Evict a leftover GLOBAL npm install of Sigil (S3).
 *
 * Before the git-native move (PR #41), Sigil shipped as an npm package. After
 * migrating, a stale `npm i -g @anmol-srv/sigil` can linger — and crucially it
 * carries its OWN long-lived daemon and its OWN PGlite version. Two installs
 * then fight over the single-process embedded DB (~/.sigil/db): the WASM engine
 * aborts ("Aborted()") and the cluster corrupts. The git install must be the
 * SOLE owner, so update/install removes the global package.
 *
 * Best-effort and never throws: a missing npm, no global install, or a failed
 * removal all return a reason instead of aborting the update. Caller stops the
 * old daemon separately (the update flow's `daemon restart` does this). Only
 * meaningful when WE are the git install — guarded so we never remove the very
 * package we're running from.
 *
 * @param {{log?:(m:string)=>void, npm?:(args:string[])=>Promise<{stdout:string}>}} [opts]
 *   `npm` is injectable for tests; defaults to the real `npm` binary.
 * @returns {Promise<{evicted:boolean, path?:string, reason?:string}>}
 */
export async function evictLegacyNpmInstall({ log = () => {}, npm } = {}) {
  const runNpm = npm || ((args) => run('npm', args, { encoding: 'utf8', timeout: 120_000 }));

  let globalRoot;
  try {
    globalRoot = (await runNpm(['root', '-g'])).stdout.trim();
  } catch {
    return { evicted: false, reason: 'npm-unavailable' };
  }
  if (!globalRoot) return { evicted: false, reason: 'no-global-root' };

  const globalPkg = join(globalRoot, ...LEGACY_NPM_PKG.split('/'));
  if (!existsSync(globalPkg)) return { evicted: false, reason: 'not-installed' };

  // Never evict the package we're running from (e.g. a user still ON the npm
  // install who hasn't migrated). The update command only runs for git installs,
  // but guard regardless so this helper is safe to call anywhere.
  if (globalPkg === PKG_ROOT || PKG_ROOT.startsWith(globalPkg + sep)) {
    return { evicted: false, reason: 'self' };
  }

  log(`Removing legacy global npm install at ${globalPkg} — the git install is now the sole owner of ~/.sigil/db.`);
  try {
    await runNpm(['rm', '-g', LEGACY_NPM_PKG]);
    return { evicted: true, path: globalPkg };
  } catch (err) {
    log(`(warning) could not remove the global npm install — remove it manually with \`npm rm -g ${LEGACY_NPM_PKG}\`: ${err.message.split('\n')[0]}`);
    return { evicted: false, reason: 'rm-failed' };
  }
}
