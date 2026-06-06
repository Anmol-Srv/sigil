#!/usr/bin/env node

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { execSync as _execSync } from 'node:child_process';
import { config as dotenvConfig } from 'dotenv';

// Package root — works whether run from project dir or globally installed
const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
let PKG_VERSION = '0.0.0';
try { PKG_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version; } catch { /* ignore */ }

// Env precedence: shell env > project .env > global ~/.sigil/.env.
// dotenv's default behavior (no `override`) never overwrites existing
// process.env keys, so loading project FIRST gives it priority over
// global, and shell-set values (e.g. `DEFAULT_NAMESPACE=demo sigil ...`)
// always win because they're set before either dotenv call runs.
const projectEnv = resolve(process.cwd(), '.env');
const globalEnv = join(homedir(), '.sigil', '.env');

if (existsSync(projectEnv)) {
  dotenvConfig({ path: projectEnv, quiet: true });
}
if (existsSync(globalEnv) && globalEnv !== projectEnv) {
  dotenvConfig({ path: globalEnv, quiet: true });
}

// Agent provenance: CLI-originated writes are tagged 'cli'. The socket client
// forwards this in each request envelope so the daemon stamps created_by_agent.
// An explicitly-set SIGIL_AGENT (e.g. a wrapper script) still wins.
if (!process.env.SIGIL_AGENT) process.env.SIGIL_AGENT = 'cli';

const [command, ...rest] = process.argv.slice(2);

const HELP = `sigil — Persistent memory for your Claude sessions

Usage:
  sigil <command> [options]

Commands:
  init                     Interactive setup wizard (DB, LLM, embeddings, agents)
  connect [--clients ...]  Re-pin launcher shims + re-sync AI client configs (fix stale paths)
  uninstall [--dry-run]    Remove Sigil's entries from selected AI clients
  doctor                   Diagnose Sigil setup (DB, LLM, embeddings, hooks)
  remember "text"          Save a fact or note to memory
  ingest <file|url|glob>   Ingest documents into the knowledge base
  search "query"           Search the knowledge base
  facts                    List stored facts with IDs
  forget <id>              Delete a specific fact by ID
  namespace <sub>          Manage namespaces (list | delete <ns>)
  session <sub>            Inspect the active session pod (current | list | show)
  pod <sub>                List, show, create, or archive memory pods
  export [--format=json]   Export knowledge base as JSON or Markdown
  context                  Refresh the hot-context snapshot in ~/.claude/CLAUDE.md
  why                      Explain a search result — per-fact RRF / pod / kind breakdown
  kind                     List or show pod kinds (claude_session, project, person, playbook, vital)
  status                   Show knowledge base statistics
  maintain                 Run periodic memory maintenance (stage promotion, edge consolidation)
  migrate                  Run database migrations
  reset                    Reset the database (drops all data)
  register                 Register as a Claude Code MCP server (advanced)
  daemon <sub>             Control the Sigil daemon (start | stop | status | logs)
  pair <sub>               Create / list / revoke pairing codes (master)
  join <node-id> <code>    Pair this device with a master Sigil install

Options:
  --help                   Show this help message

Run sigil <command> --help for command-specific options.`;

if (command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

// Native Windows is unsupported: Sigil's launcher shims and Claude Code hooks are
// POSIX shell scripts, and the daemon/path model assumes a POSIX environment. WSL
// (which reports process.platform === 'linux') is the supported path, so 'win32'
// here is always native Windows. Refuse loudly instead of half-installing.
if (process.platform === 'win32') {
  console.error('Sigil does not support native Windows.');
  console.error('Install and run it inside WSL (Windows Subsystem for Linux):');
  console.error('  https://learn.microsoft.com/windows/wsl/install');
  process.exit(1);
}

// Zero-arg launch ("npx sigil") is dispatched below through the same
// diagnostic try/catch as every other command — see the `handler` resolution
// near the bottom. Running it here, at module top level, used to put the
// daemon-spawn call OUTSIDE that catch: a startup timeout surfaced as a raw
// unhandled-rejection dump (a code-frame from the minified bundle) instead of
// an actionable message.

async function launchAndOpenBrowser() {
  // Refuse the zero-arg launch (`pnpx @anmol-srv/sigil`, `npx …`) BEFORE spawning
  // a daemon from the ephemeral cache. Without this the GUI wizard walks the user
  // through DB/LLM/embedding, then only hits the persistence guard at the
  // connectors step (writeLauncherShim) — after a heavy daemon has already
  // cold-booted from a dir the package manager is about to delete. Gate it up
  // front so `pnpx` fails fast with the install hint instead of half-setting-up.
  const { ephemeralPackageRoot } = await import('./lib/paths.js');
  const ephemeral = ephemeralPackageRoot();
  if (ephemeral.ephemeral) {
    const { ephemeralInstallMessage } = await import('./lib/clients/shim.js');
    process.stderr.write(ephemeralInstallMessage(ephemeral) + '\n');
    process.exit(1);
  }

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const { getGuiToken } = await import('./daemon/gui-token.js');
  const { canOpenBrowser, openBrowser } = await import('./lib/open-browser.js');
  process.stderr.write('[sigil] starting daemon…\n');
  let client = await connectOrStartDaemon({ quiet: true });
  let { data } = await client.call('ping', {});

  // If a daemon from an OLDER version is already running (e.g. the user just
  // updated via npx), restart it so the new code takes effect — otherwise the
  // stale daemon keeps serving and the "update" silently does nothing.
  if (data.version && PKG_VERSION !== '0.0.0' && data.version !== PKG_VERSION) {
    process.stderr.write(`[sigil] updating daemon ${data.version} → ${PKG_VERSION}…\n`);
    try { await client.call('restartDaemon', {}); } catch { /* expected: connection drops on exit */ }
    try { await client.close(); } catch { /* */ }
    const { setTimeout: delay } = await import('node:timers/promises');
    await delay(900);
    client = await connectOrStartDaemon({ quiet: true });
    ({ data } = await client.call('ping', {}));
  }

  const { default: config } = await import('./config.js');
  const token = await getGuiToken();
  const url = `http://${config.http.host}:${config.http.port}/?t=${token}`;

  // Headless (server / SSH / CI / no display): the browser wizard isn't
  // reachable — print the URL and fall back to the terminal `init` flow if
  // setup isn't done yet.
  if (!canOpenBrowser()) {
    let setupComplete = false;
    try { const st = await client.call('setup.state', {}); setupComplete = st.data?.complete; }
    catch { /* daemon may be mid-init */ }
    await client.close();
    console.log('');
    console.log(`  Sigil is running on this machine (pid ${data.pid}).`);
    console.log(`  GUI URL (open from a machine with a browser): ${url}`);
    if (!setupComplete) {
      console.log('  No display detected — continuing setup in the terminal.\n');
      return runInit([]);
    }
    return;
  }

  await client.close();
  console.log('');
  console.log(`  Sigil is running on this machine.`);
  console.log('');
  console.log(`    PID:    ${data.pid}`);
  console.log(`    GUI:    ${url}`);
  console.log('');
  console.log(`  Opening the dashboard in your browser…`);
  console.log(`  (Press Ctrl+C at any time. The daemon stays running.)`);
  console.log('');
  openBrowser(url);
}

const commands = {
  init: runInit,
  connect: runConnect,
  setup: runInit, // alias: one native onboarding flow (no separate quickstart path)
  uninstall: runUninstall,
  doctor: runDoctor,
  remember: runRemember,
  ingest: runIngest,
  search: runSearch,
  context: runContext,
  preamble: runPreamble,
  status: runStatus,
  facts: runFacts,
  forget: runForget,
  namespace: runNamespace,
  session: runSession,
  pod: runPod,
  export: runExport,
  maintain: runMaintain,
  repair: runRepair,
  migrate: runMigrate,
  reset: runReset,
  register: runRegister,
  why: runWhy,
  kind: runKind,
  daemon: runDaemonVerb,
  service: runServiceVerb,
  pair: runPairVerb,
  join: runJoinVerb,
};

async function runDaemonVerb(args) {
  const { runDaemon } = await import('./cli-handlers/daemon.js');
  return runDaemon(args);
}

async function runServiceVerb(args) {
  const { runService } = await import('./cli-handlers/service.js');
  return runService(args);
}

async function runPairVerb(args) {
  const { runPair } = await import('./cli-handlers/pair.js');
  return runPair(args);
}

async function runJoinVerb(args) {
  const { runJoin } = await import('./cli-handlers/join.js');
  return runJoin(args);
}


// Zero-arg → the launch-and-open-browser flow; otherwise a named command.
const handler = command
  ? commands[command]
  : async () => { await launchAndOpenBrowser(); process.exit(0); };
if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  console.log(HELP);
  process.exit(1);
}

// Proactive surfacing: print a one-line warning to stderr if hook errors
// have piled up since the last clean `sigil doctor` run. Suppressed for
// `doctor` itself (it has its own richer surface) and for plumbing
// commands that shouldn't print anything to stderr (e.g., piped output).
if (command !== 'doctor' && command !== 'export' && command !== 'register') {
  try {
    const { getUnackedErrorCount } = await import('./hooks/error-log.js');
    const count = await getUnackedErrorCount();
    if (count > 0) {
      process.stderr.write(`⚠ Sigil: ${count} unacked hook error${count > 1 ? 's' : ''} — run \`sigil doctor\` for details\n`);
    }
  } catch { /* never let the warning break the command */ }
}

try {
  await handler(rest);
} catch (err) {
  // node:net throws an AggregateError when a host resolves to several
  // addresses (IPv4 + IPv6) and every connect fails — its own .message/.code
  // are empty, but the real ECONNREFUSED lives in err.errors[]. Flatten both
  // so the friendly diagnostics below still match.
  const causes = err instanceof AggregateError ? (err.errors || []) : [];
  const msg = [err.message, ...causes.map((e) => e?.message)].filter(Boolean).join('; ') || String(err);
  const code = err.code || causes.find((e) => e?.code)?.code || '';

  if (code === '3D000' || /database .* does not exist/i.test(msg)) {
    console.error('Error: the Sigil database does not exist yet on this Postgres server.');
    console.error('');
    console.error('Run `sigil init` — it will create the database, the sigil_app user, and');
    console.error('install pgvector for you (one-shot, requires Postgres admin credentials).');
    console.error('');
    console.error('Underlying error: ' + msg.split('\n')[0]);
    process.exit(1);
  }

  if (/ECONNREFUSED|connection refused/i.test(msg)) {
    console.error('Error: Postgres is not reachable.');
    console.error('');
    console.error('Sigil 0.10.0+ requires Postgres. Start your Postgres server first:');
    console.error('  • Docker:   docker run -d --name sigil-pg -p 5432:5432 -e POSTGRES_PASSWORD=… pgvector/pgvector:pg15');
    console.error('  • brew:     brew services start postgresql@15');
    console.error('  • RDS / cloud:  check the host/port in `grep SIGIL_DB_ ~/.sigil/.env`');
    console.error('');
    console.error('Underlying error: ' + msg.split('\n')[0]);
    process.exit(1);
  }

  if (/password authentication failed/i.test(msg)) {
    console.error('Error: Postgres rejected the Sigil credentials.');
    console.error('');
    console.error('Re-run `sigil init` to reset the password (it will use Postgres admin');
    console.error('credentials once to update the sigil_app user), or edit ~/.sigil/.env manually.');
    console.error('');
    console.error('Underlying error: ' + msg.split('\n')[0]);
    process.exit(1);
  }

  if (/daemon did not become ready/i.test(msg)) {
    // waitForReady already enriches this with the tail of sigild.log (see
    // auto-spawn.js). Print it verbatim — the log tail is the actionable part —
    // without the bundle's raw stack/code-frame noise.
    console.error(`Error: ${msg}`);
    console.error('');
    console.error('If the log shows "already running", a stale pidfile from a prior crash is');
    console.error('blocking startup. Clear it and retry:');
    console.error('  rm -f ~/.sigil/sigild.pid ~/.sigil/sock ~/.sigil/heartbeat.json');
    process.exit(1);
  }

  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function runInit(args) {
  const { runInit: run } = await import('./cli-handlers/init.js');
  return run(args);
}

function pad(s, n) { return String(s).padEnd(n); }

// ─── Connect ────────────────────────────────────────────────────────────────
//
// Re-runnable client (re)registration. Unlike `init`, it touches NO database,
// provider, or embedding config — it only:
//   1. Regenerates the stable launcher shims (~/.sigil/bin/), re-pinning them to
//      the CURRENT package + node location. This is the self-heal for a
//      reinstall / Node-version switch (nvm/fnm) that left a harness config
//      pointing at a dead path.
//   2. Re-runs each selected client's install() to re-sync its generated files
//      (Claude Code hooks + CLAUDE.md, Cursor, Codex CLI, Kiro) against the
//      fresh shims.
//   3. Refreshes the hot-context snapshot (best-effort; skipped if the DB is
//      unreachable — connect must work even when other things are broken).
//
// Safe non-interactively (agents / CI): with --clients/--all, or when stdin is
// not a TTY, it skips the picker and uses the given/detected set.
async function runConnect(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`sigil connect — (Re)register Sigil with your AI clients

Usage:
  sigil connect [--clients <a,b,...>] [--all] [--dry-run]

Re-pins the stable launcher shims (~/.sigil/bin/) to the current install and
re-syncs each client's generated config (Claude Code hooks + CLAUDE.md, Cursor,
Codex CLI, Kiro). Run this after upgrading, reinstalling, or switching Node
versions if memory stops working — it fixes stale paths WITHOUT re-running the
full setup wizard. Touches no database, provider, or API keys.

Options:
  --clients <a,b,...>   Comma-separated client ids. Accepts: claude-code (claude),
                        cursor, codex-cli (codex), kiro, hermes.
  --all                 (Re)connect every detected client without prompting.
  --dry-run             Show what would change; write nothing.

Non-interactive: with --clients/--all, or when stdin is not a TTY, the picker is
skipped (agent/CI-friendly).`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');

  // Parse --clients <list> (supports both `--clients a,b` and `--clients=a,b`).
  const ALIASES = {
    claude: 'claude-code', 'claude-code': 'claude-code',
    cursor: 'cursor',
    codex: 'codex-cli', 'codex-cli': 'codex-cli',
    kiro: 'kiro', hermes: 'hermes',
  };
  let explicitIds = null;
  const cFlagIdx = args.findIndex((a) => a === '--clients' || a.startsWith('--clients='));
  if (cFlagIdx !== -1) {
    const raw = args[cFlagIdx].includes('=')
      ? args[cFlagIdx].split('=').slice(1).join('=')
      : args[cFlagIdx + 1];
    explicitIds = (raw || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => ALIASES[s.toLowerCase()] || s.toLowerCase());
  }

  const clack = await import('@clack/prompts');
  const { intro, outro, multiselect, spinner, note, cancel, isCancel } = clack;

  intro(dryRun ? 'Sigil connect — DRY RUN (no files will be written)' : 'Sigil connect');

  // Refuse to re-pin shims at an ephemeral pnpm dlx / npx cache path.
  const { ephemeralPackageRoot } = await import('./lib/paths.js');
  const ephemeral = ephemeralPackageRoot();
  if (ephemeral.ephemeral) {
    const { ephemeralInstallMessage } = await import('./lib/clients/shim.js');
    cancel(ephemeralInstallMessage(ephemeral));
    process.exit(1);
  }

  // 1. Re-pin the stable launcher shims (always — even with no clients picked).
  const { writeLauncherShim } = await import('./lib/clients/shim.js');
  const shimRes = await writeLauncherShim({ dryRun });

  const { listClients } = await import('./lib/clients/index.js');
  const clients = await listClients();
  const validIds = new Set(clients.map((c) => c.id));
  const detected = await Promise.all(clients.map((c) => c.detect()));
  const detectedIds = clients.filter((_, i) => detected[i]).map((c) => c.id);

  // 2. Decide the target client set.
  let pickedIds;
  if (explicitIds) {
    const unknown = explicitIds.filter((id) => !validIds.has(id));
    if (unknown.length) {
      cancel(`Unknown client id(s): ${unknown.join(', ')}. Valid: ${[...validIds].join(', ')}.`);
      process.exit(1);
    }
    pickedIds = explicitIds;
  } else if (all || !process.stdin.isTTY) {
    // Non-interactive (agent / CI / piped): re-sync everything detected.
    pickedIds = detectedIds;
    if (!pickedIds.length) {
      note('No AI clients detected. Shims were re-pinned; install a client, then re-run `sigil connect` (or pass --clients).', 'Nothing to connect');
      outro('Done.');
      process.exit(0);
    }
  } else {
    pickedIds = await multiselect({
      message: '(Re)connect Sigil for which clients? (space to toggle, enter to confirm)',
      options: clients.map((c, i) => ({
        value: c.id,
        label: c.label,
        hint: detected[i] ? `${c.hint} — detected` : c.hint,
      })),
      initialValues: detectedIds.length ? detectedIds : ['claude-code'],
      required: false,
    });
    if (isCancel(pickedIds)) { cancel('Connect cancelled.'); process.exit(0); }
  }

  // 3. Re-run install() for each picked client (re-syncs configs to the shims).
  const planned = shimRes.actions.map((a) => ({ client: 'shim', ...a }));

  const s = spinner();
  s.start(dryRun ? 'Computing connect plan...' : 'Re-syncing client integrations...');
  for (const id of pickedIds) {
    const client = clients.find((c) => c.id === id);
    const { actions } = await client.install({ dryRun });
    for (const a of actions) planned.push({ client: client.label, ...a });
  }
  // Refresh the hot-context snapshot. Best-effort: connect must not require the
  // DB, so a failure here (DB down) is swallowed.
  if (!dryRun) {
    const { updateContextSnapshot } = await import('./memory/facts/hot-context.js');
    await updateContextSnapshot({}).catch(() => {});
  }
  s.stop(dryRun
    ? 'Plan computed.'
    : `Connected ${pickedIds.length} client${pickedIds.length === 1 ? '' : 's'}: ${pickedIds.join(', ')}`);

  const lines = planned.map((p) => `  ${pad(p.action, 8)} [${p.client}] ${p.path}${p.detail ? `  (${p.detail})` : ''}`);
  note(lines.join('\n') || '(no changes)', dryRun ? 'Plan' : 'Re-synced');

  outro(dryRun
    ? 'Dry run complete. Re-run without --dry-run to apply.'
    : 'Done. Open a new agent session to pick up the refreshed integration.');

  process.exit(0);
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

async function runUninstall(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`sigil uninstall — Remove Sigil's entries from AI clients

Usage:
  sigil uninstall [--dry-run]

Walks through every detected AI client (Claude Code, Cursor, Codex CLI, Kiro)
and lets you pick which ones to remove Sigil from. Each picked client gets:
  - its MCP entry removed from the client's config (other entries preserved)
  - its instructions / rules / steering file deleted
  - hook entries stripped (Claude Code only)

Sigil's own data — ~/.sigil/, the database, stored facts — is NOT touched.
Use 'sigil reset' for a full wipe.

Options:
  --dry-run   Show what would be removed without writing anything.`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const clack = await import('@clack/prompts');
  const { intro, outro, multiselect, spinner, note, cancel, isCancel } = clack;

  intro(dryRun ? 'Sigil uninstall — DRY RUN (no files will be written)' : 'Sigil uninstall');

  const { listClients } = await import('./lib/clients/index.js');
  const clients = await listClients();

  // Only offer clients that look installed. If none → tell the user and bail.
  const installed = [];
  for (const client of clients) {
    if (!(await client.detect())) continue;
    const { installed: isInstalled } = await client.verify();
    if (isInstalled) installed.push(client);
  }

  if (installed.length === 0) {
    note('No clients have Sigil installed — nothing to remove.', 'Nothing to do');
    outro('Done.');
    return;
  }

  const pickedIds = await multiselect({
    message: 'Remove Sigil from which clients? (space to toggle, enter to confirm)',
    options: installed.map((c) => ({ value: c.id, label: c.label, hint: c.hint })),
    initialValues: installed.map((c) => c.id),
    required: false,
  });
  if (isCancel(pickedIds)) { cancel('Uninstall cancelled.'); process.exit(0); }

  if (pickedIds.length === 0) {
    outro('Nothing selected — nothing removed.');
    return;
  }

  const planned = [];
  const s = spinner();
  s.start(dryRun ? 'Computing uninstall plan...' : 'Removing Sigil entries...');
  for (const id of pickedIds) {
    const client = installed.find((c) => c.id === id);
    const { actions } = await client.uninstall({ dryRun });
    for (const a of actions) planned.push({ client: client.label, ...a });
  }
  s.stop(dryRun ? 'Plan computed.' : `Removed from ${pickedIds.length} client${pickedIds.length > 1 ? 's' : ''}`);

  const lines = planned.map((p) => `  ${pad(p.action, 8)} [${p.client}] ${p.path}${p.detail ? `  (${p.detail})` : ''}`);
  note(lines.join('\n') || '(no changes)', dryRun ? 'Plan' : 'Done');

  outro(dryRun
    ? 'Dry run complete. Re-run without --dry-run to apply.'
    : 'Sigil entries removed. Your stored memory is unchanged — use `sigil reset` to wipe data too.');
}

// ─── Doctor ─────────────────────────────────────────────────────────────────

async function runDoctor(args) {
  if (args.includes('--help')) {
    console.log(`sigil doctor — Diagnose Sigil setup

Usage:
  sigil doctor [--deep]

Checks: Postgres connection, LLM provider, embedding provider, hook registration, hook error budget.
--deep also round-trips each connector (spawns the MCP server / runs a hook) to
prove the integration actually works, not just that its files exist.`);
    process.exit(0);
  }

  const deep = args.includes('--deep');
  const checks = [];
  const log = (status, label, detail = '') => {
    const icon = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✗';
    checks.push({ status, label });
    console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  console.log('\nSigil diagnostic\n');

  // Config location
  const globalEnv = join(homedir(), '.sigil', '.env');
  if (existsSync(globalEnv)) log('ok', 'Config file', globalEnv);
  else log('warn', 'Config file', `${globalEnv} not found — run 'sigil init'`);

  // Config validator — catches provider/model mismatches that would
  // otherwise produce silent hook failures. Runs synchronously first
  // (regex checks); deep validator (DB connect) is implicit via the
  // database check below.
  try {
    const { validateConfig } = await import('./lib/config-validator.js');
    const issues = validateConfig();
    if (issues.length === 0) {
      log('ok', 'Config validation', 'no provider/model mismatches');
    } else {
      for (const issue of issues) {
        log(issue.level === 'fail' ? 'fail' : 'warn', `Config: ${issue.code}`, issue.message);
        console.log(`    fix: ${issue.fix}`);
      }
    }
  } catch (err) {
    log('warn', 'Config validation', `unable to run: ${err.message}`);
  }

  // Database — surface which driver path is in use so a user troubleshooting
  // a Neon outage sees "DB driver: url (neon)" rather than wondering why
  // SIGIL_DB_HOST is empty.
  try {
    const cortexDb = (await import('./db/cortex.js')).default;
    const config = (await import('./config.js')).default;
    const { selectDriver } = await import('./db/drivers/index.js');
    const driver = selectDriver(config);

    await cortexDb.raw('SELECT 1');
    if (driver.kind === 'url') {
      const host = driver.connection.host;
      log('ok', 'DB driver', `URL (${driver.provider}, host=${host})`);
    } else {
      log('ok', 'DB driver', `local (${config.db.host}:${config.db.port}/${config.db.database})`);
    }

    const { getFactCount } = await import('./memory/facts/store.js');
    const { getStats } = await import('./memory/documents/store.js');
    const [facts, stats] = await Promise.all([getFactCount(), getStats()]);
    log('ok', 'Stored data', `${stats.documentCount} docs, ${stats.totalChunks} chunks, ${facts} facts`);

    // Embedding corpus consistency — must run BEFORE destroy() (shares this pool).
    // A mixed-model corpus ranks incorrectly; point at `sigil repair embeddings`.
    try {
      const { checkCorpusConsistency } = await import('./memory/facts/embedding-consistency.js');
      const c = await checkCorpusConsistency();
      if (c.total === 0) log('ok', 'Embedding corpus', 'empty');
      else if (c.mixed || c.stale > 0) {
        const hist = c.histogram.map((h) => `${h.model}:${h.count}`).join(', ');
        log('warn', 'Embedding corpus', `mixed models (${hist}) — ${c.stale} off the current model; run \`sigil repair embeddings\` to unify`);
      } else log('ok', 'Embedding corpus', `${c.total} facts, single model (${c.histogram[0].model})`);
    } catch (err) {
      log('warn', 'Embedding corpus', `check failed: ${err.message.split('\n')[0]}`);
    }

    await cortexDb.destroy();
  } catch (err) {
    // Unwrap AggregateError (thrown by pg under multi-address connect
    // when every candidate fails) so the user sees ECONNREFUSED instead
    // of just "AggregateError". Mirrors src/lib/errors.js#serializeError.
    let msg = err.message || String(err);
    if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length) {
      msg = err.errors[0].message || msg;
    } else if (err.cause && (!msg || msg === 'AggregateError')) {
      msg = err.cause.message || msg;
    }
    const config = (await import('./config.js')).default;
    if (/ECONNREFUSED|connection refused|password authentication failed/i.test(msg)) {
      log('fail', 'Database', `Postgres unreachable — ${msg.split('\n')[0]}`);
      log('warn', 'Recovery',
        config.db.url
          ? 'verify SIGIL_DATABASE_URL is valid and the provider is reachable'
          : 'check that Postgres is running and SIGIL_DB_* env vars are set in ~/.sigil/.env');
    } else {
      log('fail', 'Database', msg.split('\n')[0]);
    }
  }

  // LLM + embedding providers — LIVE probe (actually call them), not just
  // "is one detected". A revoked key / unreachable host / wrong model is the
  // silent failure this turns loud; detect-only reported green for all of them.
  try {
    const { probeProviders } = await import('./lib/provider-probe.js');
    const health = await probeProviders();
    const l = health.llm;
    const e = health.embedding;
    if (l?.ok) log('ok', 'LLM provider', `${l.provider}${l.model ? `/${l.model}` : ''} — probe ok`);
    else log('fail', 'LLM provider', l?.provider ? `${l.provider}: ${(l.error || 'unreachable').split('\n')[0]}` : 'not configured — run `sigil init`');
    if (e?.ok) log('ok', 'Embedding provider', `${e.provider}/${e.model} (dim=${e.dim}) — probe ok`);
    else log('fail', 'Embedding provider', e?.provider ? `${e.provider}: ${(e.error || 'unreachable').split('\n')[0]}` : 'not configured — run `sigil init`');
  } catch (err) {
    log('warn', 'Providers', `live probe failed: ${err.message.split('\n')[0]}`);
  }

  // Stop-hook spool — turns waiting to be replayed (saved during an outage).
  try {
    const { spoolCount } = await import('./hooks/stop-spool.js');
    const n = spoolCount();
    if (n === 0) log('ok', 'Stop-hook spool', 'empty');
    else log('warn', 'Stop-hook spool', `${n} unsaved turn${n > 1 ? 's' : ''} pending — restart the daemon or run \`sigil repair embeddings\` to replay`);
  } catch (err) {
    log('warn', 'Stop-hook spool', `unreadable: ${err.message}`);
  }

  // Client integrations — for each detected client, run verify() to confirm
  // Sigil's config entries are actually present. Undetected clients are
  // silent (no point warning about Cursor on a box that doesn't have it).
  try {
    const { listClients } = await import('./lib/clients/index.js');
    const clients = await listClients();
    let reported = 0;
    for (const client of clients) {
      if (!(await client.detect())) continue;
      reported++;
      const result = await client.verify({ deep });
      if (result.installed) {
        log('ok', `${client.label} integration`, deep ? 'configured + round-trip ok' : 'configured');
      } else {
        log('warn', `${client.label} integration`, `${result.reason} — run 'sigil init' to refresh`);
      }
    }
    if (reported === 0) {
      log('warn', 'Client integrations', 'no AI clients detected (Claude Code / Cursor / Codex / Kiro)');
    }
  } catch (err) {
    log('warn', 'Client integrations', `check failed: ${err.message}`);
  }

  const cortexMd = join(homedir(), '.sigil', 'CLAUDE.md');
  if (existsSync(cortexMd)) log('ok', 'Sigil CLAUDE.md', cortexMd);
  else log('warn', 'Sigil CLAUDE.md', `not found — run 'sigil init'`);

  // Recent hook errors — silent failures from the 4 hooks that auto-run
  // during Claude Code sessions. Surfaces problems that would otherwise
  // rot unnoticed because hooks never block Claude.
  //
  // Budget: >5 *unacked* errors (errors that arrived after the last
  // clean doctor run) flips this from warn to fail. This gives a clean
  // fix-and-clear loop: user fixes config → runs doctor → clean
  // checks → markDoctorClean stamps the ack → future doctor calls
  // count only fresh errors.
  try {
    const { readRecentHookErrors, getUnackedErrorCount, HOOK_ERROR_LOG } = await import('./hooks/error-log.js');
    const recent = await readRecentHookErrors(100);
    const unackedCount = await getUnackedErrorCount();
    if (recent.length === 0) {
      log('ok', 'Hook errors', `none in ${HOOK_ERROR_LOG}`);
    } else if (unackedCount > 5) {
      log('fail', 'Hook errors', `${unackedCount} unacked errors since last clean doctor (budget: ≤5) — see ${HOOK_ERROR_LOG}`);
      for (const e of recent.slice(-5)) {
        console.log(`    ${e.ts}  [${e.hook}]  ${(e.error || '').split('\n')[0].slice(0, 160)}`);
      }
    } else if (unackedCount > 0) {
      log('warn', 'Hook errors', `${unackedCount} unacked / ${recent.length} total — see ${HOOK_ERROR_LOG}`);
      for (const e of recent.slice(-3)) {
        console.log(`    ${e.ts}  [${e.hook}]  ${(e.error || '').split('\n')[0].slice(0, 160)}`);
      }
    } else {
      log('ok', 'Hook errors', `${recent.length} historical errors, all acked`);
    }
  } catch (err) {
    log('warn', 'Hook errors', `unreadable: ${err.message}`);
  }

  console.log();
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  if (failed) {
    console.log(`${failed} error${failed > 1 ? 's' : ''}, ${warned} warning${warned !== 1 ? 's' : ''}`);
    process.exit(1);
  } else if (warned) {
    console.log(`All critical checks passed. ${warned} warning${warned > 1 ? 's' : ''}.`);
    // Warnings only → still ack so the proactive warning suppresses;
    // the user has acknowledged the system state by running doctor.
    try {
      const { markDoctorClean } = await import('./hooks/error-log.js');
      await markDoctorClean();
    } catch { /* best effort */ }
  } else {
    console.log('All checks passed.');
    try {
      const { markDoctorClean } = await import('./hooks/error-log.js');
      await markDoctorClean();
    } catch { /* best effort */ }
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

async function runExport(args) {
  if (args.includes('--help')) {
    console.log(`sigil export — Export knowledge base to stdout or a file

Usage:
  sigil export [options] [> file]

Options:
  --namespace=<ns>    Filter by namespace
  --format=<fmt>      Output format: json (default) or markdown
  --output=<path>     Write to file instead of stdout`);
    process.exit(0);
  }

  const fs = await import('node:fs/promises');
  const { listFacts } = await import('./memory/facts/store.js');
  const config = (await import('./config.js')).default;
  const cortexDb = (await import('./db/cortex.js')).default;

  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1] || config.defaults.namespace;
  const format = args.find((a) => a.startsWith('--format='))?.split('=')[1] || 'json';
  const outputPath = args.find((a) => a.startsWith('--output='))?.split('=')[1];

  const facts = await listFacts({ namespace, limit: 10000 });
  const entities = await cortexDb('entity').where({ namespace });
  const documents = await cortexDb('document').where({ namespace });

  let output;
  if (format === 'markdown') {
    const lines = [`# Sigil export — namespace: ${namespace}`, `Generated: ${new Date().toISOString()}`, ''];
    lines.push(`## Facts (${facts.length})`, '');
    for (const f of facts) {
      const importance = f.importance === 'vital' ? ' **[VITAL]**' : '';
      lines.push(`- **[${f.category}]**${importance} ${f.content} *(${f.confidence})*`);
    }
    lines.push('', `## Entities (${entities.length})`, '');
    for (const e of entities) {
      lines.push(`- **${e.name}** (${e.entityType})${e.description ? ` — ${e.description}` : ''}`);
    }
    lines.push('', `## Documents (${documents.length})`, '');
    for (const d of documents) {
      lines.push(`- ${d.title} (${d.sourcePath})`);
    }
    output = lines.join('\n');
  } else {
    output = JSON.stringify({
      namespace,
      exportedAt: new Date().toISOString(),
      facts: facts.map((f) => ({
        uid: f.uid,
        content: f.content,
        category: f.category,
        confidence: f.confidence,
        importance: f.importance,
        createdAt: f.createdAt,
      })),
      entities: entities.map((e) => ({
        uid: e.uid,
        name: e.name,
        type: e.entityType,
        description: e.description,
        mentionCount: e.mentionCount,
      })),
      documents: documents.map((d) => ({
        sourcePath: d.sourcePath,
        title: d.title,
        sourceType: d.sourceType,
        chunkCount: d.chunkCount,
        factCount: d.factCount,
      })),
    }, null, 2);
  }

  if (outputPath) {
    await fs.writeFile(outputPath, output, 'utf8');
    console.log(`Exported ${facts.length} facts, ${entities.length} entities, ${documents.length} documents to ${outputPath}`);
  } else {
    process.stdout.write(output + '\n');
  }

  await cortexDb.destroy();
}

// ─── Namespace ───────────────────────────────────────────────────────────────

async function runNamespace(args) {
  const sub = args[0];

  if (!sub || args.includes('--help')) {
    console.log(`sigil namespace — Manage namespaces

Usage:
  sigil namespace list
  sigil namespace delete <ns> [--confirm]

Namespaces isolate facts. A project, team, or context each gets its own.`);
    process.exit(sub ? 0 : 1);
  }

  const { listNamespaces, deleteNamespace } = await import('./memory/facts/store.js');
  const cortexDb = (await import('./db/cortex.js')).default;

  if (sub === 'list') {
    const namespaces = await listNamespaces();
    if (!namespaces.length) {
      console.log('No namespaces with facts.');
    } else {
      console.log('Namespaces:');
      for (const { namespace, factCount } of namespaces) {
        console.log(`  ${namespace.padEnd(30)} ${factCount} fact${factCount === 1 ? '' : 's'}`);
      }
    }
  } else if (sub === 'delete') {
    const ns = args[1];
    if (!ns || ns.startsWith('--')) {
      console.error(`Provide a namespace: sigil namespace delete <ns> --confirm`);
      await cortexDb.destroy();
      process.exit(1);
    }
    if (!args.includes('--confirm')) {
      console.error(`This will delete ALL data in namespace "${ns}". Run with --confirm to proceed.`);
      await cortexDb.destroy();
      process.exit(1);
    }
    const result = await deleteNamespace(ns);
    console.log(`Deleted namespace "${ns}":`);
    console.log(`  ${result.factsDeleted} facts, ${result.chunksDeleted} chunks, ${result.docsDeleted} documents, ${result.entitiesDeleted} entities`);
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    await cortexDb.destroy();
    process.exit(1);
  }

  await cortexDb.destroy();
}

// ─── Session ─────────────────────────────────────────────────────────────────

async function runSession(args) {
  const sub = args[0];

  if (!sub || args.includes('--help')) {
    console.log(`sigil session — Inspect the active Claude Code session pod

Usage:
  sigil session current                Show active session uid + summary
  sigil session list [--limit=10]      List recent session pods
  sigil session show [<uid>]           Detailed view (defaults to active)`);
    process.exit(sub ? 0 : 1);
  }

  const cortexDb = (await import('./db/cortex.js')).default;

  try {
    if (sub === 'current') {
      const { getActiveCursor } = await import('./memory/pods/active-session.js');
      const cursor = await getActiveCursor();
      if (!cursor) {
        console.log('No active session.');
        return;
      }
      const pod = await (await import('./memory/pods/store.js')).findByUid(cursor.pod_uid);
      if (!pod) {
        console.log(`Cursor points to ${cursor.pod_uid} but pod row not found.`);
        return;
      }
      const sessionType = await import('./memory/pods/kinds/claude_session.js');
      const view = sessionType.formatForDisplay(pod);
      console.log(`Active session: ${pod.uid}`);
      console.log(`  session_id:     ${view.sessionId}`);
      console.log(`  started_at:     ${pod.startedAt}`);
      console.log(`  turn_count:     ${view.turnCount}`);
      console.log(`  cwd:            ${view.cwd || '—'}`);
      console.log(`  transcript:     ${view.transcriptPath || '—'}`);
      console.log(`  facts in pod:   ${pod.memberFactCount}`);
      console.log(`  docs in pod:    ${pod.memberDocCount}`);
    } else if (sub === 'list') {
      const limit = Number(parseArg(args, '--limit') || 10);
      const pods = await (await import('./memory/pods/store.js')).listPods({ podType: 'claude_session', limit });
      if (!pods.length) {
        console.log('No session pods.');
        return;
      }
      for (const p of pods) {
        const ended = p.endedAt ? p.endedAt.toISOString().slice(0, 16).replace('T', ' ') : 'active';
        console.log(`  ${p.uid}  ${p.name.padEnd(40)}  facts=${p.memberFactCount}  ${ended}`);
      }
    } else if (sub === 'show') {
      let uid = args[1];
      if (!uid) {
        const { getActiveCursor } = await import('./memory/pods/active-session.js');
        const cursor = await getActiveCursor();
        uid = cursor?.pod_uid;
        if (!uid) {
          console.log('No active session. Pass a uid: sigil session show <uid>');
          process.exit(1);
        }
      }
      await showPod(uid);
    } else {
      console.error(`Unknown subcommand: ${sub}`);
      process.exit(1);
    }
  } finally {
    await cortexDb.destroy();
  }
}

// ─── Pod ────────────────────────────────────────────────────────────────────

async function runPod(args) {
  const sub = args[0];

  if (!sub || args.includes('--help')) {
    console.log(`sigil pod — Inspect and manage memory pods

Usage:
  sigil pod list [--type=session|person] [--namespace=<ns>] [--limit=20]
  sigil pod show <uid>
  sigil pod create --type=person --name="<name>" [--slack=U123]
                   [--github=<username>] [--email=<addr>] [--role="..."]
                   [--relationship=manager|report|peer|external|...]
                   [--notes="..."] [--namespace=<ns>]
  sigil pod archive <uid>
  sigil pod delete <uid> --confirm

Pods are typed memory containers (session, person, ...). Person pods
back a canonical entity so dedup churn doesn't lose their metadata.`);
    process.exit(sub ? 0 : 1);
  }

  const cortexDb = (await import('./db/cortex.js')).default;

  try {
    if (sub === 'list') {
      const podType = parseArg(args, '--type');
      const namespace = parseArg(args, '--namespace');
      const limit = Number(parseArg(args, '--limit') || 20);
      const pods = await (await import('./memory/pods/store.js')).listPods({ podType, namespace, limit });
      if (!pods.length) {
        console.log('No pods.');
        return;
      }
      for (const p of pods) {
        console.log(`  ${p.uid}  type=${p.podType.padEnd(20)}  ${p.name.padEnd(40)}  facts=${p.memberFactCount}`);
      }
    } else if (sub === 'show') {
      const uid = args[1];
      if (!uid || uid.startsWith('--')) {
        console.error('Provide a uid: sigil pod show <uid>');
        process.exit(1);
      }
      await showPod(uid);
    } else if (sub === 'create') {
      await createPod(args);
    } else if (sub === 'archive') {
      const uid = args[1];
      if (!uid || uid.startsWith('--')) {
        console.error('Provide a uid: sigil pod archive <uid>');
        process.exit(1);
      }
      const store = await import('./memory/pods/store.js');
      const pod = await store.findByUid(uid);
      if (!pod) { console.error(`Not found: ${uid}`); process.exit(1); }
      await store.archivePod(pod.id);
      console.log(`Archived: ${uid}`);
    } else if (sub === 'delete') {
      const uid = args[1];
      if (!uid || uid.startsWith('--')) {
        console.error('Provide a uid: sigil pod delete <uid> --confirm');
        process.exit(1);
      }
      if (!args.includes('--confirm')) {
        console.error('Pass --confirm to delete (cascades pod_membership).');
        process.exit(1);
      }
      const store = await import('./memory/pods/store.js');
      const pod = await store.findByUid(uid);
      if (!pod) { console.error(`Not found: ${uid}`); process.exit(1); }
      await store.deletePod(pod.id);
      console.log(`Deleted: ${uid}`);
    } else {
      console.error(`Unknown subcommand: ${sub}`);
      process.exit(1);
    }
  } finally {
    await cortexDb.destroy();
  }
}

async function showPod(uid) {
  const podStore = await import('./memory/pods/store.js');
  const membership = await import('./memory/pods/membership.js');
  const pod = await podStore.findByUid(uid);
  if (!pod) { console.error(`Not found: ${uid}`); process.exit(1); }

  const attrs = typeof pod.attrs === 'object' ? pod.attrs : safeJsonParse(pod.attrs);

  console.log(`${pod.uid}  type=${pod.podType}`);
  console.log(`  name:           ${pod.name}`);
  console.log(`  namespace:      ${pod.namespace}`);
  console.log(`  status:         ${pod.status}`);
  console.log(`  started_at:     ${pod.startedAt || '—'}`);
  console.log(`  ended_at:       ${pod.endedAt || '—'}`);
  if (pod.entityId) console.log(`  entity_id:      ${pod.entityId}`);
  if (pod.connectionId) console.log(`  connection_id:  ${pod.connectionId}`);
  if (pod.externalId) console.log(`  external_id:    ${pod.externalId}`);
  console.log(`  facts:          ${pod.memberFactCount}`);
  console.log(`  documents:      ${pod.memberDocCount}`);
  console.log(`  attrs:`);
  for (const [k, v] of Object.entries(attrs)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : v;
    console.log(`    ${k}: ${val ?? '—'}`);
  }

  const facts = await membership.listMembers(pod.id, { memberType: 'fact', limit: 10 });
  if (facts.length) {
    console.log(`\n  Latest member facts (${facts.length}):`);
    for (const f of facts) {
      const truncated = (f.content || '').slice(0, 100);
      console.log(`    - ${truncated}${f.content && f.content.length > 100 ? '…' : ''}`);
    }
  }
}

async function createPod(args) {
  const podType = parseArg(args, '--type');
  if (podType !== 'person') {
    console.error('Only --type=person is supported in PR1. Session pods are auto-created by hooks.');
    process.exit(1);
  }

  const name = parseArg(args, '--name');
  if (!name) {
    console.error('--name is required');
    process.exit(1);
  }

  const namespace = parseArg(args, '--namespace');
  const slack = parseArg(args, '--slack');
  const github = parseArg(args, '--github');
  const email = parseArg(args, '--email');
  const role = parseArg(args, '--role');
  const relationship = parseArg(args, '--relationship');
  const notes = parseArg(args, '--notes');

  const platforms = {};
  if (slack) platforms.slack = { user_id: slack };
  if (github) platforms.github = { username: github };
  if (email) platforms.email = email;

  const config = (await import('./config.js')).default;
  const ns = namespace || config.defaults.namespace;

  // Find or create the person entity.
  const entityStore = await import('./memory/entities/store.js');
  let entity = await entityStore.findByName(name, ns);

  if (entity && entity.entityType && entity.entityType !== 'person') {
    console.error(`An entity named "${name}" already exists with entity_type="${entity.entityType}". Use a different name or merge manually.`);
    process.exit(1);
  }

  if (!entity) {
    const { embed } = await import('./ingestion/embedder.js');
    const embedding = await embed(name).catch(() => null);
    entity = await entityStore.insertEntity({
      name,
      entityType: 'person',
      description: role ? `${role}` : null,
      namespace: ns,
      externalId: slack || null,
      embedding,
    });
    console.log(`Created entity: ${entity.uid} (${entity.name})`);
  } else {
    console.log(`Linked to existing entity: ${entity.uid} (${entity.name})`);
  }

  const { upsertPersonPod } = await import('./memory/pods/resolver.js');
  const { pod, isNew } = await upsertPersonPod({
    entityId: entity.id,
    name,
    namespace: ns,
    attrs: { platforms, role, relationship, notes },
  });

  console.log(`${isNew ? 'Created' : 'Updated'} person pod: ${pod.uid}`);
  console.log(`  entity_id:     ${entity.id}`);
  console.log(`  platforms:     ${JSON.stringify(platforms)}`);
  if (role) console.log(`  role:          ${role}`);
  if (relationship) console.log(`  relationship:  ${relationship}`);
}

function parseArg(args, flag) {
  // Supports both `--flag=value` and `--flag value` forms.
  const eqMatch = args.find((a) => a.startsWith(`${flag}=`));
  if (eqMatch) return eqMatch.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return null;
}

function safeJsonParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

// ─── Facts (list) ────────────────────────────────────────────────────────────

async function runFacts(args) {
  if (args.includes('--help')) {
    console.log(`sigil facts — List stored facts

Usage:
  sigil facts [options]

Options:
  --namespace=<ns>   Filter by namespace
  --category=<c>     Filter by category
  --limit=<n>        Max facts to show (default: 20)`);
    process.exit(0);
  }

  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1];
  const category = args.find((a) => a.startsWith('--category='))?.split('=')[1];
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || 20);

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon();
  try {
    const { data } = await client.call('listFacts', { namespace, category, limit });
    if (!data.facts.length) {
      console.log('No facts found.');
    } else {
      for (const fact of data.facts) {
        const importance = fact.importance === 'vital' ? ' [VITAL]' : '';
        console.log(`${fact.uid.slice(0, 8)} [${fact.category}]${importance} ${fact.content}`);
      }
      console.log(`\n${data.facts.length} fact${data.facts.length > 1 ? 's' : ''} shown. Use 'sigil forget <id>' to delete.`);
    }
  } finally {
    await client.close();
  }
}

// ─── Forget ──────────────────────────────────────────────────────────────────

async function runForget(args) {
  if (args.includes('--help') || !args[0] || args[0].startsWith('--')) {
    console.log(`sigil forget — Delete a fact by ID

Usage:
  sigil forget <id>

The <id> can be any of:
  - A numeric row id (e.g. 165) — shown by 'sigil facts' and 'sigil search'
  - A full UID (e.g. fact-eehjLrKb80s-TQHy)
  - A short UID prefix (e.g. fact-eeh)`);
    process.exit(args[0] ? 0 : 1);
  }

  const idArg = args[0];
  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon();
  try {
    const { data } = await client.call('forgetFact', { id: idArg });
    if (data.notFound) {
      console.error(`No fact matches: ${idArg}`);
      process.exit(1);
    }
    console.log(`Forgotten: ${data.deleted.content}`);
  } finally {
    await client.close();
  }
}

// ─── Remember ────────────────────────────────────────────────────────────────

async function runRemember(args) {
  const flags = args.filter((a) => a.startsWith('--'));
  const textArgs = args.filter((a) => !a.startsWith('--'));

  if (flags.includes('--help')) {
    console.log(`sigil remember — Save facts to memory

Usage:
  sigil remember "fact1" ["fact2" ...]   Save one or more facts
  echo "fact" | sigil remember           Read fact from stdin
  sigil remember --bg "fact1" "fact2"    Save in background (returns immediately)

Options:
  --namespace=<ns>   Target namespace (default: from config / DEFAULT_NAMESPACE)
  --bg               Save in background and return immediately

Examples:
  sigil remember "I prefer tabs over spaces"
  sigil remember "Uses React" "Prefers TypeScript" "Deadline is April 20"
  sigil remember --bg "user likes dark mode" "project uses Postgres"
  sigil remember --namespace=hermes-cli "agent decided to use Postgres LISTEN/NOTIFY"`);
    process.exit(0);
  }

  const background = flags.includes('--bg') || flags.includes('--background');

  // Target namespace. The daemon resolves `params.namespace || config.defaults.namespace`,
  // so an absent flag falls back to the daemon's default. Passing it here is the ONLY way
  // an external caller (e.g. the Hermes SigilProvider) can steer the write namespace — the
  // persistent daemon already resolved its own DEFAULT_NAMESPACE at startup, so injecting
  // DEFAULT_NAMESPACE into this subprocess's env has no effect on the daemon.
  const namespace = flags.find((f) => f.startsWith('--namespace='))?.split('=')[1] || undefined;

  // Collect facts: each positional arg is a separate fact
  let facts = textArgs.filter(Boolean);

  // Fall back to stdin if no args
  if (facts.length === 0 && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const stdinText = Buffer.concat(chunks).toString('utf8').trim();
    if (stdinText) facts = stdinText.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  if (facts.length === 0) {
    console.error('Provide text to remember: sigil remember "your fact"');
    process.exit(1);
  }

  if (background) {
    // Spawn detached subprocess that itself routes through the daemon.
    // The user gets an instant return; the actual ingest happens in the
    // daemon process anyway (the detached child just sends the RPC and
    // exits once the call resolves).
    const { spawn } = await import('node:child_process');
    // Forward all passthrough flags except the backgrounding flags themselves, then the
    // RESOLVED facts (which may have come from stdin, not argv). Forwarding the whole flag
    // set — not just facts — means --namespace (and any future flag) survives the detached
    // re-exec; the old `['remember', ...facts]` silently dropped every flag. See
    // buildRememberRespawnArgs (unit-tested) for the exact contract.
    const { buildRememberRespawnArgs } = await import('./cli-handlers/remember-args.js');
    const child = spawn(
      process.execPath,
      [process.argv[1], ...buildRememberRespawnArgs(flags, facts)],
      { detached: true, stdio: 'ignore', env: { ...process.env } },
    );
    child.unref();
    console.log(`Saving ${facts.length} fact${facts.length > 1 ? 's' : ''} in background...`);
    return;
  }

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon();
  try {
    const { data } = await client.call('remember', { facts, namespace });
    const parts = [];
    if (data.added)        parts.push(`${data.added} new`);
    if (data.updated)      parts.push(`${data.updated} updated`);
    if (data.alreadyKnown) parts.push(`${data.alreadyKnown} already known`);
    console.log(parts.length ? `Remembered. (${parts.join(', ')})` : 'Already known.');
  } catch (err) {
    // The --bg path re-execs this command detached with stdio:'ignore', so a
    // failure here would otherwise vanish — the user (and Claude) saw an
    // optimistic "Saving in background…" and never learns the save was lost.
    // Record it to the shared hook-errors log so `sigil doctor` surfaces it.
    try {
      const { recordHookError } = await import('./hooks/error-log.js');
      await recordHookError('remember', err, facts.join('\n'));
    } catch { /* never let logging mask the original failure */ }
    throw err;
  } finally {
    await client.close();
  }
}


// ─── Register MCP ────────────────────────────────────────────────────────────

async function runRegister(args) {
  if (args.includes('--help')) {
    console.log(`sigil register — Register Sigil as an MCP server (advanced)

Usage:
  sigil register [--http] [--print]

By default registers a stable STDIO launcher (~/.sigil/bin/sigil-mcp). Because
the registration points at the shim — not a versioned package path — it keeps
working across Node-version switches (nvm/fnm) and reinstalls.

With --http, registers the daemon's URL-based MCP transport instead
(http://<host>:<port>/mcp + bearer token). The daemon must be running; the URL
never changes, so this is the most portable option for clients that support
HTTP MCP.

Options:
  --http    Register the URL-based HTTP transport instead of stdio
  --print   Print the config without modifying any files`);
    process.exit(0);
  }

  await doRegister({ http: args.includes('--http'), printOnly: args.includes('--print') });
}

async function doRegister({ http = false, printOnly = false } = {}) {
  const fs = await import('node:fs/promises');
  const { MCP_SHIM_PATH, writeLauncherShim } = await import('./lib/clients/shim.js');

  // Build the MCP entry + the `claude mcp add` invocation for the chosen
  // transport. Both avoid baking a versioned package path.
  let mcpEntry;
  let claudeAddArgs;
  let summary;

  if (http) {
    const config = (await import('./config.js')).default;
    const { getGuiToken } = await import('./daemon/gui-token.js');
    const token = await getGuiToken();
    const url = `http://${config.http.host}:${config.http.port}/mcp`;
    mcpEntry = { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
    claudeAddArgs = `sigil -s user --transport http ${url} --header ${JSON.stringify(`Authorization: Bearer ${token}`)}`;
    summary = `URL transport: ${url} (daemon must be running)`;
  } else {
    await writeLauncherShim({});
    mcpEntry = { command: MCP_SHIM_PATH, args: [] };
    claudeAddArgs = `sigil -s user -- ${MCP_SHIM_PATH}`;
    summary = `stdio launcher: ${MCP_SHIM_PATH}`;
  }

  const configJson = JSON.stringify({ mcpServers: { sigil: mcpEntry } }, null, 2);

  if (printOnly) {
    console.log('\nAdd this to your MCP client config:\n');
    console.log(configJson);
    return;
  }

  // Try to auto-register via `claude mcp add`
  const claudeAvailable = checkCommand('claude --version');
  if (claudeAvailable) {
    try {
      // Remove existing entry first (idempotent)
      try { _execSync('claude mcp remove sigil', { stdio: 'pipe' }); } catch { /* not registered yet */ }
      try { _execSync('claude mcp remove cortex', { stdio: 'pipe' }); } catch { /* legacy name from pre-rename */ }
      _execSync(`claude mcp add ${claudeAddArgs}`, { stdio: 'pipe' });
      console.log('Registered sigil MCP server via `claude mcp add`.');
      console.log(`  ${summary}`);
      return;
    } catch {
      // Fall through to manual instructions
    }
  }

  // Auto-detect Claude config files and update them
  const configPaths = getClaudeConfigPaths();
  let registered = false;

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;

    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const cfg = JSON.parse(raw);
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers.sigil = mcpEntry;
      await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      console.log(`Registered sigil MCP server in ${configPath}`);
      registered = true;
      break;
    } catch {
      // Try next path
    }
  }

  if (!registered) {
    console.log('Could not auto-register. Add this to your MCP client config:\n');
    console.log(configJson);
  }
}

function getClaudeConfigPaths() {
  const home = homedir();
  const platform = process.platform;

  const paths = [
    // Claude Code CLI config
    join(home, '.config', 'claude', 'claude_code_config.json'),
    join(home, '.claude', 'settings.json'),
  ];

  if (platform === 'darwin') {
    paths.push(
      join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (platform === 'linux') {
    paths.push(
      join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (platform === 'win32') {
    paths.push(
      join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'),
    );
  }

  return paths;
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

async function runIngest(args) {
  const flags = args.filter((a) => a.startsWith('--'));
  const inputs = args.filter((a) => !a.startsWith('--'));

  if (!inputs.length || flags.includes('--help')) {
    console.log(`sigil ingest — Ingest documents into the knowledge base

Usage:
  sigil ingest <file|url|glob> [options]

Options:
  --namespace=<ns>    Target namespace (default: from config)
  --wait              Wait for ingestion to finish and report results
                      (default: queue in the background and return immediately)
  --skip-facts        Skip fact extraction
  --skip-entities     Skip entity linking

Examples:
  sigil ingest ./docs/README.md
  sigil ingest "docs/**/*.md"
  sigil ingest https://example.com/page --wait
  sigil ingest file1.md file2.md --namespace=engineering`);
    process.exit(0);
  }

  const { readSource, readSources } = await import('./ingestion/sources/file.js');
  const { fetchSource } = await import('./ingestion/sources/url.js');

  const namespace = flags.find((f) => f.startsWith('--namespace='))?.split('=')[1];
  const skipFacts = flags.includes('--skip-facts');
  const skipEntities = flags.includes('--skip-entities');
  // Graph-building ingestion is LLM-heavy and can run well past the 30s RPC
  // timeout. By default we fire-and-forget: the daemon queues + processes each
  // source and returns instantly. `--wait` keeps the old synchronous reporting
  // (with a generous timeout) for scripts that need the per-doc result.
  const wait = flags.includes('--wait');

  const results = { success: [], failed: [], skipped: [], queued: [] };
  const startTime = Date.now();

  // File/URL/glob resolution stays in CLI — these are local filesystem
  // operations and don't need to run in the daemon. The daemon does the
  // heavy lifting (chunking, embedding, fact extraction) per source.
  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon(wait ? { timeoutMs: 300_000 } : undefined);
  try {
    for (const input of inputs) {
      try {
        let sources;
        if (input.startsWith('http://') || input.startsWith('https://')) {
          sources = [await fetchSource(input)];
        } else if (input.includes('*')) {
          sources = await readSources(input);
          if (!sources.length) {
            console.error(`Error: No files matched pattern: ${input}`);
            results.failed.push({ input, error: 'no files matched' });
            continue;
          }
        } else {
          sources = [await readSource(input)];
        }

        for (const source of sources) {
          console.log(`Ingesting: ${source.title}`);
          const { data } = await client.call('ingestDoc', {
            content: source.content,
            title: source.title,
            filePath: source.sourcePath,
            sourceType: source.sourceType,
            namespace,
            metadata: source.metadata,
            skipFacts,
            skipEntities,
            background: !wait,
          });
          if (data.queued) {
            results.queued.push(source.title);
            console.log('  Queued');
          } else if (data.skipped) {
            results.skipped.push(source.title);
            console.log('  Skipped (unchanged)');
          } else {
            results.success.push(source.title);
            const f = data.facts;
            console.log(`  Done — ${data.chunkCount} chunks${f ? `, ${f.total} facts (${f.added} new, ${f.updated ?? 0} updated)` : ''}`);
          }
        }
      } catch (err) {
        console.error(`  Failed: ${input} — ${err.message}`);
        results.failed.push({ input, error: err.message });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (results.queued.length) {
      console.log(`\nQueued ${results.queued.length} document${results.queued.length === 1 ? '' : 's'} for background ingestion (${results.failed.length} failed). Run \`sigil status\` to watch the graph grow.`);
    } else {
      console.log(`\nDone in ${elapsed}s — ${results.success.length} ingested, ${results.skipped.length} skipped, ${results.failed.length} failed`);
    }

    if (results.success.length > 0) {
      await client.call('refreshContext', {}).catch(() => {});
    }
  } finally {
    await client.close();
  }

  if (results.failed.length && !results.success.length && !results.queued.length) process.exit(1);
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function runSearch(args) {
  const flags = args.filter((a) => a.startsWith('--'));
  const query = args.filter((a) => !a.startsWith('--')).join(' ');

  if (!query || flags.includes('--help')) {
    console.log(`sigil search — Search the knowledge base

Usage:
  sigil search "query" [options]

Options:
  --namespace=<ns>    Filter by namespace (comma-separated for multiple)
  --limit=<n>         Max results (default: 10)
  --graph             Enable graph enhancement
  --route             Enable LLM query routing
  --synthesize        Enable LLM answer synthesis
  --chunks            Include raw chunk matches
  --no-graph          Disable graph enhancement
  --scope             Scope to the active project/session pods (default: search everything)

Examples:
  sigil search "authentication flow"
  sigil search "deploy process" --namespace=engineering
  sigil search "API design" --limit=5
  sigil search "that decision" --scope          # only this project's memory`);
    process.exit(0);
  }

  const nsFlag = flags.find((f) => f.startsWith('--namespace='))?.split('=')[1];
  const namespaces = nsFlag ? nsFlag.split(',') : undefined;
  const limit = Number(flags.find((f) => f.startsWith('--limit='))?.split('=')[1] || 10);
  const useGraph = flags.includes('--graph') && !flags.includes('--no-graph');
  const route = flags.includes('--route');
  const synthesize = flags.includes('--synthesize');
  const includeChunks = flags.includes('--chunks') || synthesize;

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon();
  try {
    // Explicit human search defaults to the WHOLE brain; --scope narrows to
    // the active project/session pods (cwd lets 'auto' resolve them). This is
    // distinct from the hook's auto-injection, which is always project-scoped
    // + floored. No floor here — a human searching sees every match.
    const podScope = flags.includes('--scope') ? 'auto' : 'global';
    const { data } = await client.call('search', {
      query, namespaces, limit, useGraph, route, synthesize, includeChunks,
      podScope, cwd: process.cwd(),
    });

    if (data.synthesized) console.log(data.synthesized);

    if (data.facts.length) {
      console.log(`\nFacts (${data.facts.length}):`);
      for (const fact of data.facts) {
        console.log(`  ${fact.content}${formatRelevance(fact)}`);
      }
    }

    if (data.chunks.length) {
      console.log(`\nChunks (${data.chunks.length}):`);
      for (const chunk of data.chunks) {
        const preview = chunk.content?.slice(0, 120).replace(/\n/g, ' ');
        console.log(`  ${preview}...${formatRelevance(chunk)}`);
      }
    }

    if (!data.facts.length && !data.chunks.length) {
      console.log('No results found.');
    }
  } finally {
    await client.close();
  }
}

// Display a meaningful relevance signal for a search hit.
//   - Prefer raw cosine similarity (0..1) — same scale across queries, no
//     misleading "always 1.0 for the top result" effect of a per-batch
//     normalization.
//   - similarity == 0 means the row matched only via keyword (FULL OUTER
//     JOIN with the vector side missing), which is real signal worth
//     flagging differently from a low-cosine match. We tag it [kw].
//   - Fall back to the legacy rrfScore only when neither is available.
function formatRelevance(row) {
  const sim = Number(row?.similarity);
  if (Number.isFinite(sim) && sim > 0) {
    return ` [sim ${sim.toFixed(2)}]`;
  }
  if (Number.isFinite(sim) && sim === 0) {
    return ' [kw]';
  }
  if (row?.rrfScore != null) {
    return ` [${row.rrfScore}]`;
  }
  return '';
}

// ─── Context ─────────────────────────────────────────────────────────────────

async function runContext(args) {
  if (args.includes('--help')) {
    console.log(`sigil context — Refresh the hot-context snapshot in ~/.claude/CLAUDE.md

Usage:
  sigil context [--namespace=<ns>] [--limit=<n>] [--explain]

Rebuilds the Active Context block injected into every new Claude session.
This runs automatically after sigil remember and sigil ingest.

Options:
  --namespace=<ns>   Namespace to pull facts from (default: from config)
  --limit=<n>        Max facts to include (default: 20)
  --explain          Don't write the snapshot — print which kind each
                     fact came from instead`);
    process.exit(0);
  }

  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1];
  const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? Number(limitArg) : 20;
  const explain = args.includes('--explain');

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon();
  try {
    const { data } = await client.call('refreshContext', {
      namespace,
      limit,
      explain,
      cwd: process.cwd(),
    });

    if (data.mode === 'explain') {
      console.log(`Hot-context blend for namespace=${data.namespace}:\n`);
      for (const section of data.sections) {
        console.log(`  ${section.name} (budget=${section.budget}, ${section.visibility})`);
        if (section.error) console.log(`    (failed: ${section.error})`);
        if (!section.facts.length) {
          console.log('    (no facts)');
        } else {
          for (const f of section.facts) {
            console.log(`    - ${(f.content || '').slice(0, 120)}`);
          }
        }
        console.log('');
      }
      return;
    }

    if (data.count) {
      console.log(`Context refreshed — ${data.count} facts written to ~/.sigil/CLAUDE.md`);
    } else {
      console.log('No facts found. Ingest some content first.');
    }
  } finally {
    await client.close();
  }
}

// ─── Preamble ────────────────────────────────────────────────────────────────

async function runPreamble(args) {
  if (args.includes('--help')) {
    console.log(`sigil preamble — Session-start sanity + fresh-facts pass

Usage:
  sigil preamble [options]

Runs the same engine as the \`prime\` MCP tool: checks daemon/DB/setup health,
then pulls fresh project-scoped facts. Prints a status block an agent (or a
shell preamble) can branch on. Self-heals — auto-starts the daemon if down.

Options:
  --format=md      Markdown block: status + memory + how-to (default)
  --format=lines   Just the KEY: value status lines (for bash preambles)
  --format=json    Raw structured result
  --transport=mcp  How-to footer for hook-less clients (Codex/Cursor)
  --transport=hooks  How-to footer for Claude Code (default for CLI: cli)
  --limit=<n>      Max fresh facts to load (default 12)

Exit code is always 0 — a degraded result is reported in-band, never thrown.`);
    process.exit(0);
  }

  const format = args.find((a) => a.startsWith('--format='))?.split('=')[1] || 'md';
  const transport = args.find((a) => a.startsWith('--transport='))?.split('=')[1] || 'cli';
  const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? Number(limitArg) : 12;

  const { buildPreamble } = await import('./preamble/run.js');
  const { renderPreamble } = await import('./preamble/render.js');
  const result = await buildPreamble({ cwd: process.cwd(), limit });
  console.log(renderPreamble(result, { format, transport }));
}

// ─── Status ──────────────────────────────────────────────────────────────────

async function runStatus(args) {
  if (args.includes('--help')) {
    console.log(`sigil status — Show knowledge base statistics

Usage:
  sigil status [--namespace=<ns>]`);
    process.exit(0);
  }

  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1];

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon();
  try {
    const { data } = await client.call('status', { namespace: namespace || null });
    const podSummary = Object.entries(data.podsByType || {})
      .map(([t, n]) => `${n} ${t}`)
      .join(', ') || '—';

    console.log(`Sigil Knowledge Base${data.namespace ? ` (${data.namespace})` : ''}`);
    console.log(`  Documents:  ${data.documents}`);
    console.log(`  Chunks:     ${data.chunks}`);
    console.log(`  Facts:      ${data.facts} active`);
    console.log(`  Entities:   ${data.entities.documents} documents, ${data.entities.people} people, ${data.entities.topics} topics`);
    console.log(`  Relations:  ${data.relations}`);
    console.log(`  Pods:       ${podSummary}`);
    if (data.hebbian) {
      const avg = data.hebbian.avgStrength ? data.hebbian.avgStrength.toFixed(2) : '0';
      const max = data.hebbian.maxStrength ? data.hebbian.maxStrength.toFixed(2) : '0';
      console.log(`  Co-retrieval edges: ${data.hebbian.edgeCount} (avg ${avg}, max ${max})`);
      if (data.hebbian.topPairs.length) {
        console.log('  Top pairs by decayed strength:');
        for (const p of data.hebbian.topPairs) {
          console.log(`    ${p.a} ↔ ${p.b}  (decayed ${Number(p.decayed).toFixed(2)})`);
        }
      }
    }
  } finally {
    await client.close();
  }
}

// ─── Repair ──────────────────────────────────────────────────────────────────

async function runRepair(args) {
  const sub = args.find((a) => !a.startsWith('--'));
  if (args.includes('--help') || (sub && sub !== 'embeddings')) {
    console.log(`sigil repair — Heal a corpus with missing or stale embeddings

Usage:
  sigil repair embeddings [options]

Re-embeds facts/chunks whose vectors are NULL (invisible to search) or were
produced by a different embedding model than the one now configured (mixed
corpus → meaningless ranking). Idempotent and resumable.

Options:
  --dry-run         Report what would be repaired; write nothing
  --namespace=<ns>  Limit to one namespace
  --all-chunks      Re-embed every chunk (use after switching providers; chunks
                    carry no model stamp, so NULL-only is the default)
  --sequences       Re-sync serial sequences to MAX(id) — fixes a "duplicate key
                    value violates ..._pkey" error on insert (no re-embedding)`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1] || null;
  const allChunks = args.includes('--all-chunks');
  const sequencesMode = args.includes('--sequences');

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon();
  try {
    if (sequencesMode) {
      const { data } = await client.call('repair.sequences', {});
      console.log(`Repair complete — re-synced ${data.resynced} table sequence(s) to MAX(id).`);
      return;
    }
    const { data } = await client.call('repair.embeddings', { dryRun, namespace, allChunks });
    if (data.dryRun) {
      console.log(`Repair (dry run)${namespace ? ` [ns=${namespace}]` : ''} — target model: ${data.model}`);
      console.log(`  Facts needing repair:  ${data.facts.scanned}`);
      console.log(`  Chunks needing repair: ${data.chunks.scanned}`);
      if (data.spool?.pending) console.log(`  Stop-hook spool:       ${data.spool.pending} turns pending replay`);
      console.log('\nRun without --dry-run to re-embed them.');
    } else {
      console.log(`Repair complete${namespace ? ` [ns=${namespace}]` : ''} — model: ${data.model}`);
      console.log(`  Facts re-embedded:  ${data.facts.repaired} / ${data.facts.scanned}`);
      console.log(`  Chunks re-embedded: ${data.chunks.repaired} / ${data.chunks.scanned}`);
      if (data.spool) console.log(`  Stop-spool replayed: ${data.spool.drained} turns (${data.spool.replayed} facts, ${data.spool.remaining} still pending)`);
    }
  } finally {
    await client.close();
  }
}

// ─── Maintain ────────────────────────────────────────────────────────────────

async function runMaintain(args) {
  if (args.includes('--help')) {
    console.log(`sigil maintain — Run periodic memory maintenance

Usage:
  sigil maintain

Promotes 'fresh' facts (older than 1h with importance=vital or any access) to 'stable',
closes 'editing' windows older than 30 minutes back to 'stable', and consolidates
co-retrieval edges. Safe to run as a cron — fully idempotent.`);
    process.exit(0);
  }

  const cortexDb = (await import('./db/cortex.js')).default;
  const { promoteFreshFacts, closeEditingWindows, getLifecycleStats } = await import('./memory/lifecycle/stage-manager.js');
  const { consolidateCoRetrievalEdges } = await import('./memory/lifecycle/hebbian.js').catch(() => ({}));
  const { consolidateEntityCoRetrievalEdges } = await import('./memory/lifecycle/entity-hebbian.js').catch(() => ({}));

  const { pruneLogs } = await import('./lib/llm/log.js');

  const before = await getLifecycleStats();
  const promoted = await promoteFreshFacts();
  const closed = await closeEditingWindows();
  const factEdgesConsolidated = consolidateCoRetrievalEdges ? await consolidateCoRetrievalEdges() : 0;
  const entityEdgesConsolidated = consolidateEntityCoRetrievalEdges ? await consolidateEntityCoRetrievalEdges() : 0;
  const pruned = await pruneLogs();
  const after = await getLifecycleStats();

  console.log('Memory maintenance:');
  console.log(`  Stages — fresh: ${before.fresh}→${after.fresh}, stable: ${before.stable}→${after.stable}, editing: ${before.editing}→${after.editing}`);
  console.log(`  Promoted (fresh→stable): ${promoted}`);
  console.log(`  Closed editing windows (editing→stable): ${closed}`);
  if (factEdgesConsolidated) console.log(`  Fact co-retrieval edges consolidated: ${factEdgesConsolidated}`);
  if (entityEdgesConsolidated) console.log(`  Entity co-retrieval edges consolidated: ${entityEdgesConsolidated}`);
  console.log(`  Pruned logs — llm_log: ${pruned.llmDeleted}, trace_event: ${pruned.traceDeleted}`);

  await cortexDb.destroy();
}

// ─── Migrate ─────────────────────────────────────────────────────────────────

async function runMigrate(args) {
  if (args.includes('--help')) {
    console.log(`sigil migrate — Run database migrations

Usage:
  sigil migrate [--rollback]`);
    process.exit(0);
  }

  const cortexDb = (await import('./db/cortex.js')).default;
  const { MIGRATIONS_DIR: migrationDir } = await import('./lib/paths.js');

  if (args.includes('--rollback')) {
    const [batch, migrations] = await cortexDb.migrate.rollback({ directory: migrationDir });
    console.log(`Rolled back batch ${batch}: ${migrations.length} migrations`);
    for (const m of migrations) console.log(`  ${m}`);
  } else {
    const [batch, migrations] = await cortexDb.migrate.latest({ directory: migrationDir });
    if (migrations.length) {
      console.log(`Ran batch ${batch}: ${migrations.length} migrations`);
      for (const m of migrations) console.log(`  ${m}`);
    } else {
      console.log('Already up to date.');
    }
  }

  await cortexDb.destroy();
}

// ─── Reset ───────────────────────────────────────────────────────────────────

async function runReset(args) {
  if (args.includes('--help')) {
    console.log(`sigil reset — Clean rebuild: tear down Sigil's setup, config, and data

Usage:
  sigil reset            Confirm, then drop the database + wipe everything
  sigil reset --yes      Skip the prompt (scripting)
  sigil reset --keep-db  Wipe config + disconnect agents, but KEEP the database

Tears down:
  - the database         Docker container+volume removed; a local DB is DROPPED.
                         External/managed (connection-URL) DBs are left intact.
  - coding agents        Sigil hooks/config removed from Claude Code, Cursor, …
  - ~/.sigil/            config.json + all local state
  - ~/.claude/CLAUDE.md  the @~/.sigil/CLAUDE.md import line

Re-run 'sigil' afterwards to set up fresh.`);
    process.exit(0);
  }

  const skipConfirm = args.includes('--confirm') || args.includes('--yes') || args.includes('-y');
  const keepDb = args.includes('--keep-db');
  const home = homedir();
  const sigilDir = join(home, '.sigil');

  if (!skipConfirm) {
    const clack = await import('@clack/prompts');
    clack.intro('Sigil — reset (clean rebuild)');
    clack.note(
      [
        'This will:',
        keepDb ? '  - KEEP the database (--keep-db)' : '  - drop the database (Docker container+volume / local DROP DATABASE; external left intact)',
        '  - disconnect every coding agent (remove Sigil hooks/config)',
        `  - delete ${sigilDir} (config + all local state)`,
        '  - remove the @~/.sigil/CLAUDE.md import line',
      ].join('\n'),
      'About to reset',
    );
    const proceed = await clack.confirm({ message: keepDb ? 'Wipe config + disconnect agents?' : 'Drop the database and wipe everything?', initialValue: false });
    if (clack.isCancel(proceed) || proceed !== true) {
      clack.cancel('Reset cancelled. Nothing changed.');
      process.exit(0);
    }
  }

  // 1. Drop the database while config still points at it (FORCE handles the
  //    live daemon's connections). Skip with --keep-db.
  if (!keepDb) {
    try {
      const { dropConfiguredDatabase } = await import('./setup/reset.js');
      const r = await dropConfiguredDatabase();
      console.log(`  database: ${r.detail}`);
    } catch (err) { console.log(`  database: drop failed (${err.message}) — continuing`); }
  } else {
    console.log('  database: kept (--keep-db)');
  }

  // 2. Remove Sigil from every coding agent.
  try {
    const { disconnectAllClients } = await import('./setup/reset.js');
    const removed = await disconnectAllClients();
    console.log(`  agents: ${removed.length ? `disconnected ${removed.join(', ')}` : 'none connected'}`);
  } catch (err) { console.log(`  agents: ${err.message}`); }

  // 3. Stop the daemon (best effort) and wipe ~/.sigil.
  try { _execSync('pkill -f "dist/daemon.js"', { stdio: 'pipe' }); } catch { /* none running */ }
  try { _execSync('pkill -f "sigil/dist/server.js --mcp"', { stdio: 'pipe' }); } catch {}
  const fs = await import('node:fs/promises');
  if (existsSync(sigilDir)) await fs.rm(sigilDir, { recursive: true, force: true });
  await removeClaudeMdImport();

  console.log('');
  console.log('  Reset complete. Run `sigil` to set up again, or reinstall with:');
  console.log('    curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh');
  console.log('');
  process.exit(0);
}

// Strip exactly the cortex/smara/sigil @import lines from ~/.claude/CLAUDE.md.
// Matches all three legacy paths so a reset under sigil cleans up after a
// pre-rename install too. Returns true if anything was removed.
async function removeClaudeMdImport() {
  const fs = await import('node:fs/promises');
  const claudeMdPath = join(homedir(), '.claude', 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) return false;

  const before = await fs.readFile(claudeMdPath, 'utf8');
  const home = homedir();
  const importPaths = [
    join(home, '.sigil', 'CLAUDE.md'),
    join(home, '.smara', 'CLAUDE.md'),
    join(home, '.cortex', 'CLAUDE.md'),
  ];

  let after = before;
  for (const p of importPaths) {
    const re = new RegExp(`^@${escapeRegex(p)}\\s*\\n?`, 'gm');
    after = after.replace(re, '');
  }

  if (after === before) return false;
  await fs.writeFile(claudeMdPath, after, 'utf8');
  return true;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ─── Why ─────────────────────────────────────────────────────────────────────

async function runWhy(args) {
  if (args.length === 0 || args.includes('--help')) {
    console.log(`sigil why — Explain a search result

Usage:
  sigil why "<query>" [--namespace=<ns>] [--limit=5] [--pod-scope=auto|global|<name>,<name>]

Runs the same hybrid search the UserPromptSubmit hook uses and prints
the per-fact breakdown — vector score, keyword score, importance,
recency, kind / pod source — so you can see WHY each fact made the
top-K for a given query.`);
    process.exit(0);
  }

  const config = (await import('./config.js')).default;
  const cortexDb = (await import('./db/cortex.js')).default;

  const flagIdx = args.findIndex((a) => a.startsWith('--'));
  const queryParts = flagIdx === -1 ? args : args.slice(0, flagIdx);
  const query = queryParts.join(' ').replace(/^["']|["']$/g, '');
  if (!query) {
    console.error('Provide a query: sigil why "<query>"');
    process.exit(1);
  }
  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1] || config.defaults.namespace;
  const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? Number(limitArg) : 5;
  const podScopeArg = args.find((a) => a.startsWith('--pod-scope='))?.split('=')[1];
  let podScope = null;
  if (podScopeArg) {
    if (podScopeArg === 'auto' || podScopeArg === 'global') podScope = podScopeArg;
    else podScope = podScopeArg.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const { search } = await import('./memory/search/hybrid.js');
  const result = await search(query, {
    namespaces: [namespace],
    limit,
    route: true,
    expand: true,
    synthesize: false,
    podScope: podScope ?? 'auto',
  });

  console.log(`Query: ${query}`);
  console.log(`Namespace: ${namespace}`);
  console.log(`Pod scope: ${JSON.stringify(podScope ?? 'auto')}`);
  console.log('');

  if (result.matchedEntity) {
    console.log(`Matched entity: ${result.matchedEntity.name} (${result.matchedEntity.type}, id:${result.matchedEntity.id})`);
    console.log('');
  }

  if (!result.facts.length) {
    console.log('No facts returned.');
    await cortexDb.destroy();
    return;
  }

  const podMembership = await import('./memory/pods/membership.js');
  console.log(`Facts (${result.facts.length}):`);
  for (const [i, f] of result.facts.entries()) {
    const pods = await podMembership.listPodsForMember('fact', f.id).catch(() => []);
    const podStr = pods.length
      ? pods.map((p) => `${p.podType}:${p.name}`).join(', ')
      : '—';
    const importance = f.importance || `score=${f.importanceScore ?? '?'}`;
    const boost = f.coRetrievalBoost != null ? ` hebbian=${f.coRetrievalBoost}` : '';
    console.log(`  ${i + 1}. [rrf=${f.rrfScore ?? '?'}${boost}] [${f.category}] [${importance}] [conf=${f.confidence}]`);
    console.log(`     pods: ${podStr}`);
    console.log(`     content: ${(f.content || '').slice(0, 140)}`);
  }

  await cortexDb.destroy();
}

// ─── Kind ────────────────────────────────────────────────────────────────────

async function runKind(args) {
  const sub = args[0];
  if (!sub || sub === '--help') {
    console.log(`sigil kind — Inspect registered pod kinds

Usage:
  sigil kind list
  sigil kind show <name>

list     Show every registered pod kind with budget / visibility / TTL.
show     Show one kind's full contract, schema doc path, and active scope
         for the current shell context.`);
    process.exit(0);
  }

  await import('./memory/pods/kinds/index.js');
  const { list, get, activeKinds, getSchemaDoc } = await import('./memory/pods/registry.js');

  if (sub === 'list') {
    const kinds = list();
    console.log(`Registered kinds (${kinds.length}):`);
    for (const k of kinds) {
      const ttl = k.ttlDays ? `${k.ttlDays}d TTL` : 'no decay';
      console.log(`  ${k.name.padEnd(18)} budget=${k.hotContextBudget}  ${k.visibility.padEnd(8)}  ${ttl}`);
      console.log(`    ${k.description}`);
    }
    const ns = (await import('./config.js')).default.defaults.namespace;
    const active = await activeKinds({ namespace: ns, cwd: process.cwd() });
    console.log('');
    console.log(`Active for cwd=${process.cwd()}: ${active.length ? active.map((a) => a.kind.name).join(', ') : '(none)'}`);
    return;
  }

  if (sub === 'show') {
    const name = args[1];
    if (!name) {
      console.error('Provide a kind name: sigil kind show <name>');
      process.exit(1);
    }
    const k = get(name);
    if (!k) {
      console.error(`Unknown kind: ${name}`);
      process.exit(1);
    }
    console.log(`Kind: ${k.name}`);
    console.log(`  description:       ${k.description}`);
    console.log(`  identityField:     ${k.identityField ?? '—'}`);
    console.log(`  visibility:        ${k.visibility}`);
    console.log(`  activeMode:        ${k.activeMode}`);
    console.log(`  hotContextBudget:  ${k.hotContextBudget}`);
    console.log(`  retrievalWeights:  ${JSON.stringify(k.retrievalWeights)}`);
    console.log(`  importanceDefault: ${k.importanceDefault}`);
    console.log(`  ttlDays:           ${k.ttlDays ?? 'no decay'}`);
    console.log(`  writePolicy:       ${k.writePolicy}`);
    console.log(`  schemaDocPath:     ${k.schemaDocPath ?? '—'}`);
    const doc = await getSchemaDoc(k);
    console.log(`  schemaDoc chars:   ${doc ? doc.length : 0}`);
    return;
  }

  console.error(`Unknown subcommand: ${sub}`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function checkCommand(cmd) {
  try {
    _execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
