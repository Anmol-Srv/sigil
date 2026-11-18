/**
 * `sigil update` — bring ~/.sigil/app up to the latest release.
 *
 * Every channel (curl installer, npm, npx) lands on the one git install at
 * ~/.sigil/app (see src/lib/git-update.js and src/lib/npm-door.js). This
 * command fast-forwards that clone, reinstalls deps
 * only if they changed, re-pin the launcher shims, and restart the daemon so the
 * new code is actually serving. The daemon's background staleness check is what
 * tells the user an update is available; this is what applies it.
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PKG_ROOT, SIGIL_UPDATE_FLAG } from '../lib/paths.js';
import {
  isGitInstall,
  checkForUpdate,
  applyUpdate,
  evictLegacyNpmInstall,
  revertInstall,
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

const HELP = `sigil update — update Sigil to the latest release

Usage:
  sigil update [--check] [--force]

  --check    Report whether an update is available; don't apply it.
  --force    Re-pull and reinstall even if already up to date.

Sigil lives in one place, ~/.sigil/app, whether you installed it with the curl
installer, npm, or npx. Updating fast-forwards it to the latest release. npm
users can also run: npm i -g @anmol-srv/sigil@latest`;

function installedVersion() {
  try { return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

export async function runUpdate(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  if (!isGitInstall()) {
    console.error('sigil update works on the Sigil install at ~/.sigil/app, but this copy runs from:');
    console.error(`  ${PKG_ROOT}`);
    console.error('');
    console.error('Install Sigil with either command, then update with `sigil update`:');
    console.error('  npm i -g @anmol-srv/sigil');
    console.error('  curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh');
    process.exit(1);
  }

  // --finish: the code was already brought up to date by the installer (the npm
  // entry point runs it). Only finish: shims, daemon restart, migrations.
  if (args.includes('--finish')) {
    const fromIdx = args.indexOf('--from');
    const from = fromIdx >= 0 ? args[fromIdx + 1] || null : null;
    const to = installedVersion();
    await finishUpdate({ from, lockChanged: true });
    console.log(`Sigil ${to} is ready. ✓`);
    return;
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

  const current = installedVersion();
  if (check) {
    if (status.behind > 0) {
      console.log(`Update available for Sigil ${current} (${status.local} → ${status.remote}).`);
      console.log('Run `sigil update` to apply it.');
    } else {
      console.log(`Sigil ${current} is up to date (${status.local}).`);
    }
    return;
  }

  if (status.behind === 0 && !force) {
    console.log(`Sigil ${current} is up to date (${status.local}).`);
    await clearFlag();
    return;
  }

  console.log(`Updating Sigil ${current} (${status.local} → ${status.remote})…`);
  const { from, to, lockChanged, stashed } = await applyUpdate();

  if (stashed) {
    console.log(`Local changes in ${PKG_ROOT} were stashed before the reset — recover them with:`);
    console.log(`  git -C ${PKG_ROOT} stash pop`);
  }

  if (lockChanged || force) {
    console.log('Dependencies changed — running npm install…');
    await npmInstall();
  }

  await finishUpdate({ from, lockChanged: lockChanged || force });
  console.log(`Updated Sigil ${current} → ${installedVersion()} (${from} → ${to}). ✓`);
}

/**
 * Everything after the code itself has moved: evict a legacy npm install,
 * re-pin the shims, restart the daemon on the new code, and migrate the
 * database (reverting the code if the schema can't move forward).
 */
async function finishUpdate({ from, lockChanged }) {
  // Evict a pre-door global npm install (<0.22). It carries its own daemon +
  // PGlite version; two installs fighting over the single-process embedded DB
  // is what corrupts it. Do this BEFORE the restart below, which then stops the
  // (possibly stale) daemon and starts ours. Door releases are left alone.
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

  // A login service (launchd/systemd) installed by a legacy npm copy still runs
  // that copy. Re-point it here; it then starts the new daemon itself.
  let repointed = false;
  try {
    const { repointServiceIfStale } = await import('../supervisor/index.js');
    repointed = await repointServiceIfStale();
    if (repointed) console.log('Sigil login service now runs the updated install.');
  } catch (err) {
    console.error(`(warning) could not update the Sigil login service — run \`sigil service install\`: ${err.message.split('\n')[0]}`);
  }

  // Restart the daemon so the freshly-pulled code is the code that serves. A
  // code-only change (no version bump) wouldn't trip the CLI's version-mismatch
  // auto-restart, so we do it explicitly here.
  try {
    if (!repointed) await restartDaemon();
  } catch (err) {
    console.error(`(warning) daemon restart failed — restart it with \`sigil daemon restart\`: ${err.message.split('\n')[0]}`);
  }

  // Apply any pending DB migrations the new code expects — daemon-side, with an
  // auto-revert net. If the schema can't move forward, we revert the CODE too so
  // code and schema never drift out of lockstep. Throws on a failed migration
  // (after restoring the previous version), so the user lands on a working Sigil.
  await applyMigrationsOrRevert({ from, lockChanged });

  await clearFlag();
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
  if (!from) {
    console.error('  There is no earlier Sigil version on this machine to revert to.');
    console.error('  Report the error above, then run `sigil migrate` once it is fixed.');
    const e = new Error('database migration failed after installing Sigil.');
    e.code = 'migration_failed';
    throw e;
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
