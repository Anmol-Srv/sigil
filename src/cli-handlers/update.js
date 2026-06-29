/**
 * `sigil update` — pull the latest Sigil straight from the git release branch.
 *
 * Sigil ships from git, not npm (see src/lib/git-update.js). This command is the
 * user-facing half of that: fast-forward the ~/.sigil/app clone, reinstall deps
 * only if they changed, re-pin the launcher shims, and restart the daemon so the
 * new code is actually serving. The daemon's background staleness check is what
 * tells the user an update is available; this is what applies it.
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import { PKG_ROOT, SIGIL_UPDATE_FLAG } from '../lib/paths.js';
import {
  isGitInstall,
  checkForUpdate,
  applyUpdate,
  evictLegacyNpmInstall,
  RELEASE_BRANCH,
} from '../lib/git-update.js';

const run = promisify(execFile);

const HELP = `sigil update — update Sigil from the git release branch

Usage:
  sigil update [--check] [--force]

  --check    Report whether an update is available; don't apply it.
  --force    Re-pull and reinstall even if already up to date.

Sigil is installed as a git clone at ~/.sigil/app and updated by fast-forwarding
it to the latest '${RELEASE_BRANCH}' branch — there is no npm package to bump.`;

export async function runUpdate(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  if (!isGitInstall()) {
    console.error('sigil update needs a git install, but this copy is not a git clone:');
    console.error(`  ${PKG_ROOT}`);
    console.error('');
    console.error('Reinstall with the official installer so updates work:');
    console.error('  curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh');
    process.exit(1);
  }

  const check = args.includes('--check');
  const force = args.includes('--force');

  let status;
  try {
    status = await checkForUpdate();
  } catch (err) {
    console.error(`Could not reach the release branch: ${err.message.split('\n')[0]}`);
    console.error('Check your network / git remote and try again.');
    process.exit(1);
  }

  if (check) {
    if (status.behind > 0) {
      console.log(`Update available: ${status.local} → ${status.remote} (${status.behind} commit${status.behind > 1 ? 's' : ''} behind '${status.branch}')`);
      console.log('Run `sigil update` to apply it.');
    } else {
      console.log(`Up to date (${status.local}, '${status.branch}').`);
    }
    return;
  }

  if (status.behind === 0 && !force) {
    console.log(`Already up to date (${status.local}, '${status.branch}').`);
    await clearFlag();
    return;
  }

  console.log(`Updating ${status.local} → ${status.remote}…`);
  const { from, to, lockChanged } = await applyUpdate();

  if (lockChanged || force) {
    console.log('Dependencies changed — running npm install…');
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
    });
  }

  // Evict any leftover global npm install (S3). A pre-git-native `npm i -g`
  // copy carries its own daemon + PGlite version; two installs fighting over the
  // single-process embedded DB is what corrupts it. Do this BEFORE the restart
  // below, which then stops the (possibly stale) daemon and starts ours.
  try {
    await evictLegacyNpmInstall({ log: (m) => console.log(m) });
  } catch { /* best-effort — never block the update */ }

  // Re-pin the launcher shims at the (unchanged) app dir + current node — cheap,
  // idempotent, and self-heals a shim left stale by a node-version switch.
  try {
    const { writeLauncherShim } = await import('../lib/clients/shim.js');
    await writeLauncherShim({});
  } catch (err) {
    console.error(`(warning) could not refresh launcher shims: ${err.message.split('\n')[0]}`);
  }

  // Restart the daemon so the freshly-pulled code is the code that serves. A
  // code-only change (no version bump) wouldn't trip the CLI's version-mismatch
  // auto-restart, so we do it explicitly here.
  try {
    const { runDaemon } = await import('./daemon.js');
    await runDaemon(['restart']);
  } catch (err) {
    console.error(`(warning) daemon restart failed — restart it with \`sigil daemon restart\`: ${err.message.split('\n')[0]}`);
  }

  await clearFlag();
  console.log(`Updated ${from} → ${to}. ✓`);
}

async function clearFlag() {
  await rm(SIGIL_UPDATE_FLAG, { force: true }).catch(() => {});
}
