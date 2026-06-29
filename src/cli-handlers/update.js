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
  revertInstall,
  RELEASE_BRANCH,
} from '../lib/git-update.js';

const run = promisify(execFile);

async function npmInstall() {
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
  });
}

async function restartDaemon() {
  const { runDaemon } = await import('./daemon.js');
  await runDaemon(['restart']);
}

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
  const { from, to, lockChanged, stashed } = await applyUpdate();

  if (stashed) {
    console.log(`Local changes in ${PKG_ROOT} were stashed before the reset — recover them with:`);
    console.log(`  git -C ${PKG_ROOT} stash pop`);
  }

  if (lockChanged || force) {
    console.log('Dependencies changed — running npm install…');
    await npmInstall();
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
    await restartDaemon();
  } catch (err) {
    console.error(`(warning) daemon restart failed — restart it with \`sigil daemon restart\`: ${err.message.split('\n')[0]}`);
  }

  // Apply any pending DB migrations the new code expects — daemon-side, with an
  // auto-revert net. If the schema can't move forward, we revert the CODE too so
  // code and schema never drift out of lockstep. Throws on a failed migration
  // (after restoring the previous version), so the user lands on a working Sigil.
  await applyMigrationsOrRevert({ from, lockChanged });

  await clearFlag();
  console.log(`Updated ${from} → ${to}. ✓`);
}

/**
 * Apply pending migrations through the freshly-restarted daemon and reconcile
 * code with schema:
 *   - migrated/skipped → keep the new code (success).
 *   - reverted/dirty   → the daemon left the DB at (or restored to) its prior
 *                        schema, so revert the code to `from` and restart, then
 *                        throw — the update is rolled back as a unit.
 */
async function applyMigrationsOrRevert({ from, lockChanged }) {
  let res;
  let client;
  try {
    const { connectOrStartDaemon } = await import('../clients/auto-spawn.js');
    client = await connectOrStartDaemon({ quiet: true });
    ({ data: res } = await client.call('migrateSafe', {}));
  } catch (err) {
    // Couldn't reach the daemon / RPC missing (e.g. daemon failed to restart).
    // Don't revert — the code is fine, migrations are just pending. Tell the user.
    console.error(`(warning) could not apply migrations: ${err.message.split('\n')[0]}`);
    console.error('Finish with: `sigil daemon stop && sigil migrate && sigil daemon start`');
    return;
  } finally {
    if (client) await client.close().catch(() => {});
  }

  // Defensive: an unexpected response shape must not throw past this function
  // (which would skip the revert and leave new code on an unmigrated schema).
  // Treat it like an unreachable daemon — migrations pending, code untouched.
  if (!res || typeof res.status !== 'string') {
    console.error('(warning) could not apply migrations: unexpected response from daemon');
    console.error('Finish with: `sigil daemon stop && sigil migrate && sigil daemon start`');
    return;
  }

  if (res.status === 'migrated') {
    if (res.ran && res.ran.length) console.log(`Applied ${res.ran.length} migration${res.ran.length > 1 ? 's' : ''}.`);
    else console.log('Database schema already up to date.');
    return;
  }
  if (res.status === 'skipped') {
    console.log(`(database migrations not applied — ${res.reason})`);
    return;
  }

  // Migration failed. The daemon guarantees the DB is back at its prior schema
  // ('reverted') or, worst case, left a restore snapshot ('dirty'). Either way
  // the new code no longer matches the live schema — revert the code to match.
  console.error('');
  console.error(`✗ Migration failed: ${res.error || 'unknown error'}`);
  if (res.status === 'reverted') {
    console.error('  Database was rolled back to its previous schema.');
  } else {
    console.error('  ⚠ Database rollback was incomplete.'
      + (res.snapshot ? ` A pre-update snapshot was saved (${res.snapshot}); restore it with \`sigil repair\` if writes misbehave.` : ''));
  }
  console.error(`  Reverting code to ${from} so it matches the schema…`);

  try {
    const landed = await revertInstall(from);
    if (lockChanged) await npmInstall();
    // Restart failure here is distinct from a revert failure: the code IS back
    // on the old version, only the daemon didn't come up. Report it accurately.
    try {
      await restartDaemon();
      console.error(`  Reverted to ${landed}. Sigil is back on the previous version.`);
    } catch (err) {
      console.error(`  Code reverted to ${landed}, but the daemon restart failed: ${err.message.split('\n')[0]}`);
      console.error('  Bring it back up with `sigil daemon restart`.');
    }
  } catch (err) {
    console.error(`  (warning) automatic code revert failed: ${err.message.split('\n')[0]}`);
    console.error(`  Recover manually: \`git -C ${PKG_ROOT} reset --hard ${from}\` then \`sigil daemon restart\`.`);
  }

  const e = new Error('update rolled back after a failed migration — fix the migration and re-run `sigil update`.');
  e.code = 'migration_failed';
  throw e;
}

async function clearFlag() {
  await rm(SIGIL_UPDATE_FLAG, { force: true }).catch(() => {});
}
