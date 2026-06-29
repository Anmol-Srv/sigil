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
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PKG_ROOT } from './paths.js';

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
 * Fast-forward the clone to the latest release tip. Uses `reset --hard` rather
 * than `pull`/`merge`: the release branch is a derived, force-pushed artifact
 * (built dist/ committed by CI), so a 3-way merge against a local checkout would
 * spuriously conflict. Resetting to the fetched tip is the correct, conflict-free
 * "make my tree exactly match the release" operation.
 *
 * @returns {Promise<{from:string, to:string, lockChanged:boolean}>}
 */
export async function applyUpdate() {
  const from = await git(['rev-parse', 'HEAD']);
  const lockBefore = await lockHash();
  await git(['fetch', '--depth', '1', '--quiet', REMOTE, RELEASE_BRANCH]);
  await git(['reset', '--hard', '--quiet', 'FETCH_HEAD']);
  const to = await git(['rev-parse', 'HEAD']);
  const lockAfter = await lockHash();
  return { from: from.slice(0, 7), to: to.slice(0, 7), lockChanged: lockBefore !== lockAfter };
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
