#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { execSync as _execSync } from 'node:child_process';

// Package root — works whether run from project dir or globally installed
const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
let PKG_VERSION = '0.0.0';
try { PKG_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
const MEMORY_RPC_TIMEOUT_MS = 120_000;
const MAINTENANCE_RPC_TIMEOUT_MS = 30 * 60_000;

// No .env loading: config.json is the single source of truth (loaded lazily by
// config.js → config-store). A legacy ~/.sigil/.env is imported into config.json
// once, on first load, then renamed .migrated (see config-store.migrateEnvIfPresent).

// Agent provenance: CLI-originated writes are tagged 'cli'. The socket client
// forwards this in each request envelope so the daemon stamps created_by_agent.
// An explicitly-set SIGIL_AGENT (e.g. a wrapper script) still wins.
if (!process.env.SIGIL_AGENT) process.env.SIGIL_AGENT = 'cli';

const [command, ...rest] = process.argv.slice(2);

const HELP = `sigil — Local-first memory for AI coding agents

Usage:
  sigil <command> [options]

Commands:
  init                     Interactive local-memory setup (DB, embeddings, agents)
  update [--check]         Update Sigil from the git release branch
  connect [--clients ...]  Re-pin launcher shims + re-sync AI client configs (fix stale paths)
  uninstall [--dry-run]    Remove Sigil's entries from selected AI clients
  doctor                   Diagnose Sigil setup (DB, LLM, embeddings, hooks)
  remember "text"          Save a fact or note to memory
  ingest <file|url|glob>   Ingest documents into the knowledge base
  search "query"           Search the knowledge base
  facts                    List stored facts with IDs
  correct <id> "text"      Replace a fact explicitly and preserve history
  forget <id>              Delete a specific fact by ID
  namespace <sub>          Manage namespaces (list | delete <ns>)
  export [--format=json]   Export knowledge base as JSON or Markdown
  why                      Explain deterministic search ranking
  status                   Show knowledge base statistics
  migrate                  Run database migrations
  reset                    Reset the database (drops all data)
  mcp <sub>                Configure or test a generic MCP connection
  register                 Register as a Claude Code MCP server (advanced)
  daemon <sub>             Control the Sigil daemon (start | stop | status | logs)

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

  // The core daemon does not load HTTP/WebSocket at boot. Starting the browser
  // is the explicit signal to enable that adapter.
  const gui = await client.call('gui.start', {});
  if (!gui.ok || !gui.data?.url) {
    throw new Error(gui.error?.message || 'failed to start the local Sigil UI');
  }
  const url = gui.data.url;

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
  preamble: runPreamble,
  status: runStatus,
  facts: runFacts,
  correct: runCorrect,
  forget: runForget,
  namespace: runNamespace,
  export: runExport,
  repair: runRepair,
  migrate: runMigrate,
  reset: runReset,
  mcp: runMcp,
  register: runRegister,
  why: runWhy,
  update: runUpdateVerb,
  daemon: runDaemonVerb,
  service: runServiceVerb,
};

async function runUpdateVerb(args) {
  const { runUpdate } = await import('./cli-handlers/update.js');
  return runUpdate(args);
}

async function runDaemonVerb(args) {
  const { runDaemon } = await import('./cli-handlers/daemon.js');
  return runDaemon(args);
}

async function runServiceVerb(args) {
  const { runService } = await import('./cli-handlers/service.js');
  return runService(args);
}

// ─── Generic MCP connection ────────────────────────────────────────────────

async function runMcp(args) {
  const subcommand = args[0];
  if (!subcommand || args.includes('--help') || args.includes('-h')) {
    console.log(`sigil mcp — Connect any MCP-compatible tool without a Sigil adapter

Usage:
  sigil mcp config [--format json|toml] [--agent <id>]
  sigil mcp test

Commands:
  config   Print a ready-to-paste stdio MCP entry. It creates/refreshes only
           Sigil's own stable launcher shim; it never edits the tool's config.
  test     Start the generated stdio server and make a real status-tool call.

Options:
  --format json|toml  Config syntax to print (default: json)
  --agent <id>        Provenance label for writes from this tool (default: mcp)

Use a built-in connection only when Sigil supports that tool's native config or
prompt hook. For any other MCP client, paste this generated entry and restart
the client. Generic MCP has explicit tools; it does not install automatic
capture or tool hooks.`);
    return;
  }

  if (!['config', 'test'].includes(subcommand)) {
    throw new Error(`unknown mcp command: ${subcommand}. Use \`sigil mcp --help\`.`);
  }

  const readFlag = (name, fallback) => {
    const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
    if (index === -1) return fallback;
    return args[index].includes('=') ? args[index].slice(name.length + 1) : args[index + 1];
  };
  const format = readFlag('--format', 'json');
  const agent = readFlag('--agent', 'mcp');

  const { writeLauncherShim, resolveServerPath } = await import('./lib/clients/shim.js');
  await writeLauncherShim({});

  if (subcommand === 'config') {
    const { renderStdioMcpConfig } = await import('./mcp/config-snippet.js');
    console.log('\nPaste this into your MCP client configuration:\n');
    console.log(renderStdioMcpConfig({ format, agent }));
    console.log('This uses local stdio. Sigil starts its local daemon on demand; no remote service or plugin is required.');
    return;
  }

  if (format !== 'json' || agent !== 'mcp') {
    throw new Error('`sigil mcp test` accepts no config options; test the default generated stdio entry.');
  }
  const { verifyMcpRoundTrip } = await import('./lib/clients/roundtrip.js');
  const result = await verifyMcpRoundTrip(resolveServerPath());
  if (!result.ok) throw new Error(`MCP test failed: ${result.reason}`);
  console.log('Sigil MCP is ready: stdio server initialized and the status tool responded.');
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
      process.stderr.write(`⚠ Sigil: ${count} unacked hook issue${count > 1 ? 's' : ''} — run \`sigil doctor\` for details\n`);
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
    console.error('  • RDS / cloud:  check database settings in ~/.sigil/config.json');
    console.error('');
    console.error('Underlying error: ' + msg.split('\n')[0]);
    process.exit(1);
  }

  if (/password authentication failed/i.test(msg)) {
    console.error('Error: Postgres rejected the Sigil credentials.');
    console.error('');
    console.error('Re-run `sigil init` to reset the password (it will use Postgres admin');
    console.error('credentials once to update the sigil_app user), or rerun `sigil init`.');
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
//
// Safe non-interactively (agents / CI): with --clients/--all, or when stdin is
// not a TTY, it skips the picker and uses the given/detected set.
async function runConnect(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`sigil connect — (Re)register Sigil with your AI clients

Usage:
  sigil connect [--clients <a,b,...>] [--all] [--shims-only] [--dry-run]

Re-pins the stable launcher shims (~/.sigil/bin/) to the current install and
re-syncs each client's generated config (Claude Code hooks + CLAUDE.md, Cursor,
Codex CLI, Kiro). Run this after upgrading, reinstalling, or switching Node
versions if memory stops working — it fixes stale paths WITHOUT re-running the
full setup wizard. Touches no database, provider, or API keys.

Options:
  --clients <a,b,...>   Comma-separated client ids. Accepts: claude-code (claude),
                        cursor, codex-cli (codex), kiro, hermes.
  --all                 (Re)connect every detected client without prompting.
  --shims-only          Re-pin only Sigil's stable launchers. Does not inspect
                        or modify any agent configuration.
  --dry-run             Show what would change; write nothing.

Non-interactive: with --clients/--all, or when stdin is not a TTY, the picker is
skipped (agent/CI-friendly).`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');
  const all = args.includes('--all');
  const shimsOnly = args.includes('--shims-only');

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

  // Reinstalling Sigil must be able to move the machine-native entry point to
  // the new git checkout without rewriting a user's Codex TOML, hook-trust, or
  // any agent configuration. The installer uses this narrow path before it
  // restarts the daemon; it is also the safe manual recovery for path drift.
  if (shimsOnly) {
    const lines = shimRes.actions.map((a) => `  ${pad(a.action, 8)} [shim] ${a.path}${a.detail ? `  (${a.detail})` : ''}`);
    note(lines.join('\n') || '(no changes)', dryRun ? 'Plan' : 'Launchers re-pinned');
    outro(dryRun ? 'Dry run complete. Re-run without --dry-run to apply.' : 'Done. Agent configuration was not changed.');
    process.exit(0);
  }

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
    initialValues: detectedIds,
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
    const { actions } = dryRun
      ? await client.plan()
      : await client.apply();
    for (const a of actions) planned.push({ client: client.label, ...a });
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

Lists every AI-client integration Sigil has configured (including stale entries
for an app no longer installed) and lets you choose which ones to remove. Each
picked client gets:
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

  // Keep stale Sigil-owned integrations removable even after their client was
  // uninstalled or moved. Detection is intentionally stricter than cleanup.
  const installed = [];
  for (const client of clients) {
    const { installed: isInstalled } = await client.verify().catch(() => ({ installed: false }));
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
    // Destructive cleanup must never be one Enter key away from removing every
    // integration. Users explicitly choose each client they want to disconnect.
    initialValues: [],
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
  sigil doctor --ack

Checks: database connection, embedding provider, optional LLM (when configured), prompt-hook registration, hook error budget.
--deep also round-trips each connector (spawns the MCP server / runs a hook) to
prove the integration actually works, not just that its files exist.
--ack acknowledges the current hook errors (silences the warning) without
running the checks — use when you've seen them and don't want a full pass.`);
    process.exit(0);
  }

  // Explicit acknowledgement: stamp the clean marker so the proactive warning
  // suppresses, without running checks (F6). The counter is "since last ack".
  if (args.includes('--ack')) {
    const { markDoctorClean } = await import('./hooks/error-log.js');
    await markDoctorClean();
    console.log('Acknowledged current hook errors — the warning will return only if new ones arrive.');
    return;
  }

  const deep = args.includes('--deep');
  const checks = [];
  const log = (status, label, detail = '') => {
    const icon = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✗';
    checks.push({ status, label });
    console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  console.log('\nSigil diagnostic\n');

  // Config location. config.json is the source of truth (the legacy ~/.sigil/.env
  // is migrated into it then renamed away), so a complete config.json is healthy
  // and its ABSENT .env is NOT a problem (F7: kill the .env false-positive). Only
  // warn when neither exists — that's a genuinely un-set-up install.
  const { SIGIL_CONFIG_PATH } = await import('./lib/paths.js');
  const globalEnv = join(homedir(), '.sigil', '.env');
  if (existsSync(SIGIL_CONFIG_PATH)) log('ok', 'Config file', SIGIL_CONFIG_PATH);
  else if (existsSync(globalEnv)) log('ok', 'Config file', `${globalEnv} (legacy — migrates to config.json on next daemon start)`);
  else log('warn', 'Config file', `no config.json — run 'sigil init'`);

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

  // Install integrity (S2): the launcher shims, the running daemon, and the git
  // install at ~/.sigil/app must all agree. A skew here is the silent
  // precondition behind the dueling-install corruption (two daemons / two PGlite
  // versions over one single-process DB), so surface it as a hard fail with the
  // one-command fix. Skipped for dev/source runs with no installed git copy.
  try {
    const { checkInstallIntegrity } = await import('./lib/install-state.js');
    const r = checkInstallIntegrity();
    if (r.applicable && r.ok) {
      log('ok', 'Install integrity', `shims + daemon aligned with git install (v${r.canonical.version})`);
    } else if (r.applicable) {
      for (const issue of r.issues) {
        log('fail', 'Install integrity', issue.message);
        console.log(`    fix: ${issue.fix}`);
      }
    }
  } catch (err) {
    log('warn', 'Install integrity', `unable to check: ${err.message}`);
  }

  // Database — the driver path is config-only (no DB touch); health + counts come
  // from the daemon's `status` RPC. doctor never opens the DB directly: in
  // embedded mode that would trip the single-process guard / abort PGlite, so the
  // troubleshooting tool must route through the daemon like everything else.
  try {
    const config = (await import('./config.js')).default;
    const { selectDriver } = await import('./db/drivers/index.js');
    let driver = null;
    try { driver = selectDriver(config); } catch { /* not configured yet */ }
    if (driver?.kind === 'url') log('ok', 'DB driver', `URL (${driver.provider}, host=${driver.connection.host})`);
    else if (driver?.kind === 'embedded') log('ok', 'DB driver', 'embedded PGlite (~/.sigil/db)');
    else if (driver) log('ok', 'DB driver', `local (${config.db.host}:${config.db.port}/${config.db.database})`);
    else log('warn', 'DB driver', 'not configured — run `sigil` to set up');

    const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
    let client;
    try {
      client = await connectOrStartDaemon({ quiet: true, timeoutMs: MEMORY_RPC_TIMEOUT_MS });
      const { data: status } = await client.call('status', {});
      if (status?.db?.healthy) {
        log('ok', 'Stored data', `${status.documents} docs, ${status.chunks} chunks, ${status.facts} facts`);
        // Embedding-corpus consistency via the repair dry-run (no re-embedding).
        try {
          const { data: rep } = await client.call('repair.embeddings', { dryRun: true });
          const f = rep?.facts?.scanned ?? 0;
          const c = rep?.chunks?.scanned ?? 0;
          if (f + c === 0) log('ok', 'Embedding corpus', 'consistent');
          else log('warn', 'Embedding corpus', `${f} facts + ${c} chunks need re-embedding — run \`sigil repair embeddings\``);
        } catch { /* corpus check is best-effort */ }
      } else if (status?.db?.schema === 'missing') {
        // Honest diagnostics (F7): reachable but not migrated — distinct state
        // and a distinct remedy. NOT "unreachable", NOT "restore a snapshot".
        log('fail', 'Database', 'reachable but schema not initialized (no tables)');
        log('warn', 'Recovery', 'run `sigil migrate` to create the tables (or complete setup in the GUI)');
      } else {
        const msg = (status?.db?.error || 'unknown').split('\n')[0];
        log('fail', 'Database', `unreachable — ${msg}`);
        log('warn', 'Recovery',
          config.db.url
            ? 'verify the database URL in ~/.sigil/config.json and provider reachability'
            : 'built-in DB unreadable — run `sigil repair db` to restore from a snapshot'
              + ' (for the underlying cause behind `Aborted()`, set SIGIL_PGLITE_DEBUG=1 and `sigil daemon restart`)');
      }
    } finally {
      if (client) await client.close().catch(() => {});
    }
  } catch (err) {
    log('fail', 'Database', `could not reach the daemon to check the DB — ${(err.message || String(err)).split('\n')[0]}`);
    log('warn', 'Recovery', 'start it with `sigil daemon start` (or just run `sigil`), then re-run doctor');
  }

  // Embedding + optional LLM providers — LIVE probe (actually call them), not just
  // "is one detected". A revoked key / unreachable host / wrong model is the
  // silent failure this turns loud; detect-only reported green for all of them.
  try {
    const { probeProviders } = await import('./lib/provider-probe.js');
    const { getConfig } = await import('./setup/config-store.js');
    const llmConfigured = Boolean(getConfig().llm?.provider);
    const health = await probeProviders({ llm: llmConfigured });
    const l = health.llm;
    const e = health.embedding;
    if (!llmConfigured) log('ok', 'LLM provider', 'not configured (optional)');
    else if (l?.ok) log('ok', 'LLM provider', `${l.provider}${l.model ? `/${l.model}` : ''} — probe ok`);
    else log('fail', 'LLM provider', `${l?.provider || 'configured'}: ${(l?.error || 'unreachable').split('\n')[0]}`);
    if (e?.ok) log('ok', 'Embedding provider', `${e.provider}/${e.model} (dim=${e.dim}) — probe ok`);
    else log('fail', 'Embedding provider', e?.provider ? `${e.provider}: ${(e.error || 'unreachable').split('\n')[0]}` : 'not configured — run `sigil init`');
  } catch (err) {
    log('warn', 'Providers', `live probe failed: ${err.message.split('\n')[0]}`);
  }

  // Client integrations — report only configurations Sigil actually owns.
  // A configured integration whose app is gone is a cleanup action, not proof
  // that the client is installed.
  try {
    const { listClients } = await import('./lib/clients/index.js');
    const clients = await listClients();
    let reported = 0;
    for (const client of clients) {
      const [detected, result] = await Promise.all([
        client.detect().catch(() => false),
        client.verify({ deep }).catch((error) => ({ installed: false, reason: error.message })),
      ]);
      if (!result.installed) continue;
      reported++;
      if (detected) log('ok', `${client.label} integration`, deep ? 'configured + round-trip ok' : 'configured');
      else log('warn', `${client.label} integration`, 'configured, but its client is not detected — run `sigil uninstall` to remove it');
      if (result.attention) log('warn', `${client.label} automatic recall`, result.attention);
    }
    if (reported === 0) {
      log('ok', 'Client integrations', 'none configured');
    }
  } catch (err) {
    log('warn', 'Client integrations', `check failed: ${err.message}`);
  }

  const cortexMd = join(homedir(), '.sigil', 'CLAUDE.md');
  if (existsSync(cortexMd)) log('ok', 'Sigil CLAUDE.md', cortexMd);
  else log('warn', 'Sigil CLAUDE.md', `not found — run 'sigil init'`);

  // Recent errors from the single prompt-recall hook.
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
    // `recent` is collapsed into distinct {hook, error, count} groups; counts
    // below are distinct issues, not raw line volume (F6).
    const fmt = (e) => {
      const times = e.count > 1 ? ` ×${e.count}` : '';
      return `    ${e.lastTs || e.ts}  [${e.hook}]${times}  ${(e.error || '').split('\n')[0].slice(0, 160)}`;
    };
    if (recent.length === 0) {
      log('ok', 'Hook errors', `none in ${HOOK_ERROR_LOG}`);
    } else if (unackedCount > 5) {
      log('fail', 'Hook errors', `${unackedCount} unacked issues since last clean doctor (budget: ≤5) — see ${HOOK_ERROR_LOG}`);
      for (const e of recent.slice(-5)) console.log(fmt(e));
    } else if (unackedCount > 0) {
      log('warn', 'Hook errors', `${unackedCount} unacked / ${recent.length} distinct — see ${HOOK_ERROR_LOG}`);
      for (const e of recent.slice(-3)) console.log(fmt(e));
    } else {
      log('ok', 'Hook errors', `${recent.length} distinct historical errors, all acked`);
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
  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1];
  const format = args.find((a) => a.startsWith('--format='))?.split('=')[1] || 'json';
  const outputPath = args.find((a) => a.startsWith('--output='))?.split('=')[1];

  if (!['json', 'markdown'].includes(format)) {
    console.error(`Unknown export format: ${format}. Use json or markdown.`);
    process.exit(1);
  }

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });
  let data;
  try {
    ({ data } = await client.call('exportData', { namespace }));
  } finally {
    await client.close();
  }
  const facts = data.facts;
  const documents = data.documents;

  let output;
  if (format === 'markdown') {
    const lines = [`# Sigil export — namespace: ${data.namespace}`, `Generated: ${new Date().toISOString()}`, ''];
    lines.push(`## Facts (${facts.length})`, '');
    for (const f of facts) {
      const importance = f.importance === 'vital' ? ' **[VITAL]**' : '';
      lines.push(`- **[${f.category}]**${importance} ${f.content} *(${f.confidence})*`);
    }
    lines.push('', `## Documents (${documents.length})`, '');
    for (const d of documents) {
      lines.push(`- ${d.title} (${d.sourcePath})`);
    }
    output = lines.join('\n');
  } else {
    output = JSON.stringify({
      namespace: data.namespace,
      exportedAt: new Date().toISOString(),
      facts: facts.map((f) => ({
        uid: f.uid,
        content: f.content,
        category: f.category,
        confidence: f.confidence,
        importance: f.importance,
        createdAt: f.createdAt,
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
    console.log(`Exported ${facts.length} facts and ${documents.length} documents to ${outputPath}`);
  } else {
    process.stdout.write(output + '\n');
  }
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

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });

  try {
    if (sub === 'list') {
      const { data } = await client.call('listNamespaces', {});
      if (!data.namespaces.length) {
        console.log('No namespaces with facts.');
      } else {
        console.log('Namespaces:');
        for (const { namespace, factCount } of data.namespaces) {
          console.log(`  ${namespace.padEnd(30)} ${factCount} fact${factCount === 1 ? '' : 's'}`);
        }
      }
    } else if (sub === 'delete') {
      const ns = args[1];
      if (!ns || ns.startsWith('--')) {
        console.error('Provide a namespace: sigil namespace delete <ns> --confirm');
        process.exit(1);
      }
      if (!args.includes('--confirm')) {
        console.error(`This will delete ALL data in namespace "${ns}". Run with --confirm to proceed.`);
        process.exit(1);
      }
      const { data } = await client.call('deleteNamespace', { namespace: ns, confirm: true });
      console.log(`Deleted namespace "${ns}":`);
      console.log(`  ${data.factsDeleted} facts, ${data.chunksDeleted} chunks, ${data.docsDeleted} documents`);
    } else {
      console.error(`Unknown subcommand: ${sub}`);
      process.exit(1);
    }
  } finally {
    await client.close();
  }
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
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });
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
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });
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

// ─── Correct ─────────────────────────────────────────────────────────────────

async function runCorrect(args) {
  if (args.includes('--help') || !args[0] || args.length < 2) {
    console.log(`sigil correct — Replace an outdated fact while preserving history

Usage:
  sigil correct <id> "complete replacement fact"

The <id> may be a numeric id, full UID, or unambiguous UID prefix.
Sigil inserts the replacement and marks the old fact superseded in one
transaction. It does not use an LLM to guess whether facts contradict.`);
    process.exit(args.includes('--help') ? 0 : 1);
  }

  const id = args[0];
  const content = args.slice(1).join(' ').trim();
  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });
  try {
    const { data } = await client.call('correctFact', { id, content });
    if (data.notFound) {
      console.error(`No fact matches: ${id}`);
      process.exit(1);
    }
    if (data.unchanged) console.log(`Unchanged: ${data.previous.content}`);
    else {
      console.log(`Corrected: ${data.previous.content}`);
      console.log(`Current:   ${data.replacement.content}`);
    }
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

Options:
  --namespace=<ns>   Target namespace (default: from config)

Examples:
  sigil remember "I prefer tabs over spaces"
  sigil remember "Uses React" "Prefers TypeScript" "Deadline is April 20"
  sigil remember --namespace=hermes-cli "agent decided to use Postgres LISTEN/NOTIFY"`);
    process.exit(0);
  }

  // Target namespace. The daemon resolves
  // `params.namespace || config.defaults.namespace`; integrations must forward
  // explicit per-write namespace intent in this payload.
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

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });
  try {
    const { data } = await client.call('remember', { facts, namespace });
    const parts = [];
    if (data.added)        parts.push(`${data.added} new`);
    if (data.alreadyKnown) parts.push(`${data.alreadyKnown} already known`);
    console.log(parts.length ? `Remembered. (${parts.join(', ')})` : 'Already known.');
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
  --extract-facts     Opt in to LLM fact extraction
Examples:
  sigil ingest ./docs/README.md
  sigil ingest "docs/**/*.md"
  sigil ingest https://example.com/page --extract-facts
  sigil ingest file1.md file2.md --namespace=engineering`);
    process.exit(0);
  }

  const { readSource, readSources } = await import('./ingestion/sources/file.js');
  const { fetchSource } = await import('./ingestion/sources/url.js');

  const namespace = flags.find((f) => f.startsWith('--namespace='))?.split('=')[1];
  const extractFacts = flags.includes('--extract-facts');
  const results = { success: [], failed: [], skipped: [] };
  const startTime = Date.now();

  // File/URL/glob resolution stays in CLI — these are local filesystem
  // operations and don't need to run in the daemon. The daemon does the
  // heavy lifting (chunking, embedding, fact extraction) per source.
  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: 300_000 });
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
            extractFacts,
          });
          if (data.skipped) {
            results.skipped.push(source.title);
            console.log('  Skipped (unchanged)');
          } else {
            results.success.push(source.title);
            const f = data.facts;
            console.log(`  Done — ${data.chunkCount} chunks${f ? `, ${f.total} facts (${f.added} new, ${f.skipped} known)` : ''}`);
          }
        }
      } catch (err) {
        console.error(`  Failed: ${input} — ${err.message}`);
        results.failed.push({ input, error: err.message });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone in ${elapsed}s — ${results.success.length} ingested, ${results.skipped.length} skipped, ${results.failed.length} failed`);

  } finally {
    await client.close();
  }

  if (results.failed.length && !results.success.length) process.exit(1);
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
  --chunks            Include raw chunk matches

Examples:
  sigil search "authentication flow"
  sigil search "deploy process" --namespace=engineering
  sigil search "API design" --limit=5`);
    process.exit(0);
  }

  const nsFlag = flags.find((f) => f.startsWith('--namespace='))?.split('=')[1];
  const namespaces = nsFlag ? nsFlag.split(',') : undefined;
  const limit = Number(flags.find((f) => f.startsWith('--limit='))?.split('=')[1] || 10);
  const includeChunks = flags.includes('--chunks');

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });
  try {
    const { data } = await client.call('search', {
      query, namespaces, limit, includeChunks,
    });

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

// ─── Preamble ────────────────────────────────────────────────────────────────

async function runPreamble(args) {
  if (args.includes('--help')) {
  console.log(`sigil preamble — Session-start health check

Usage:
  sigil preamble [options]

Runs the same engine as the \`prime\` MCP tool: checks daemon/DB/setup health
and tells the agent to use targeted search for memory. It does not inject a
generic top-N snapshot. Self-heals by auto-starting the daemon if down.

Options:
  --format=md      Markdown block: status + memory + how-to (default)
  --format=lines   Just the KEY: value status lines (for bash preambles)
  --format=json    Raw structured result
  --transport=mcp  How-to footer for hook-less clients (Codex/Cursor)
  --transport=hooks  How-to footer for Claude Code (default for CLI: cli)
Exit code is always 0 — a degraded result is reported in-band, never thrown.`);
    process.exit(0);
  }

  const format = args.find((a) => a.startsWith('--format='))?.split('=')[1] || 'md';
  const transport = args.find((a) => a.startsWith('--transport='))?.split('=')[1] || 'cli';
  const { buildPreamble } = await import('./preamble/run.js');
  const { renderPreamble } = await import('./preamble/render.js');
  const result = await buildPreamble();
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
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });
  try {
    const { data } = await client.call('status', { namespace: namespace || null });
    console.log(`Sigil Knowledge Base${data.namespace ? ` (${data.namespace})` : ''}`);
    console.log(`  Documents:  ${data.documents}`);
    console.log(`  Chunks:     ${data.chunks}`);
    console.log(`  Facts:      ${data.facts} active`);
    // Live agent-process gauges. The Claude-procs line is the hard cap that
    // prevents the 1600-session blowup — show it whenever the daemon reports it.
    if (data.claudeProcs) {
      const { active, waiting, limit } = data.claudeProcs;
      console.log(`  Claude procs: ${active}/${limit} active${waiting ? `, ${waiting} queued` : ''}`);
    }
  } finally {
    await client.close();
  }
}

// ─── Repair ──────────────────────────────────────────────────────────────────

async function runRepair(args) {
  const sub = args.find((a) => !a.startsWith('--'));
  if (args.includes('--help') || (sub && sub !== 'embeddings' && sub !== 'db')) {
    console.log(`sigil repair — Heal the memory store

Usage:
  sigil repair embeddings [options]
  sigil repair db [--restore[=<snapshot>]]

repair embeddings — Re-embeds facts/chunks whose vectors are NULL (invisible to
search) or were produced by a different embedding model than the one now
configured (mixed corpus → meaningless ranking). Idempotent and resumable.

  --dry-run         Report what would be repaired; write nothing
  --namespace=<ns>  Limit to one namespace
  --all-chunks      Re-embed every chunk (use after switching providers; chunks
                    carry no model stamp, so NULL-only is the default)
  --sequences       Re-sync serial sequences to MAX(id) — fixes a "duplicate key
                    value violates ..._pkey" error on insert (no re-embedding)

repair db — Recover the built-in (embedded) cluster from a snapshot. With no
flag it lists snapshots and current health. --restore rebuilds ~/.sigil/db from
the latest snapshot (or a named one); the current dir is moved aside, never
deleted, so nothing is lost irrecoverably.

  --restore           Restore from the latest snapshot
  --restore=<name>    Restore from a specific snapshot (name from the listing)`);
    process.exit(0);
  }

  if (sub === 'db') return runRepairDb(args);

  const dryRun = args.includes('--dry-run');
  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1] || null;
  const allChunks = args.includes('--all-chunks');
  const sequencesMode = args.includes('--sequences');

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MAINTENANCE_RPC_TIMEOUT_MS });
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
      console.log('\nRun without --dry-run to re-embed them.');
    } else {
      console.log(`Repair complete${namespace ? ` [ns=${namespace}]` : ''} — model: ${data.model}`);
      console.log(`  Facts re-embedded:  ${data.facts.repaired} / ${data.facts.scanned}`);
      console.log(`  Chunks re-embedded: ${data.chunks.repaired} / ${data.chunks.scanned}`);
    }
  } finally {
    await client.close();
  }
}

async function runRepairDb(args) {
  const restoreArg = args.find((a) => a === '--restore' || a.startsWith('--restore='));
  const which = restoreArg?.includes('=') ? restoreArg.split('=')[1] : 'latest';

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MAINTENANCE_RPC_TIMEOUT_MS });
  try {
    if (restoreArg) {
      const { data } = await client.call('repair.db', { action: 'restore', which });
      console.log(`Restored the built-in database from snapshot ${data.from}.`);
      if (data.movedAside) console.log(`  Previous (torn) cluster preserved at: ${data.movedAside}`);
      console.log(`  Database health after restore: ${data.healthy ? 'healthy' : 'STILL UNHEALTHY'}`);
      if (!data.healthy) console.log('  Try an older snapshot: sigil repair db  (then --restore=<name>)');
      return;
    }
    const { data } = await client.call('repair.db', { action: 'status' });
    const h = data.health || {};
    console.log(`Built-in database: ${h.healthy ? 'healthy' : h.healthy === false ? 'UNHEALTHY' : 'unknown'}${h.error ? ` — ${String(h.error).split('\n')[0]}` : ''}`);
    if (!data.snapshots.length) {
      console.log('\nNo snapshots yet. One is taken on clean daemon shutdown and periodically while healthy.');
      return;
    }
    console.log(`\nSnapshots (newest first), ~/.sigil/snapshots:`);
    for (const s of data.snapshots) {
      const mb = (s.bytes / 1024 / 1024).toFixed(1);
      const when = new Date(s.mtimeMs).toISOString();
      console.log(`  ${s.name}  (${mb} MB, ${when})`);
    }
    console.log('\nRestore the latest with:  sigil repair db --restore');
  } finally {
    await client.close();
  }
}

// ─── Migrate ─────────────────────────────────────────────────────────────────

async function runMigrate(args) {
  if (args.includes('--help')) {
    console.log(`sigil migrate — Run database migrations

Usage:
  sigil migrate [--rollback]`);
    process.exit(0);
  }

  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MAINTENANCE_RPC_TIMEOUT_MS });
  try {
    if (args.includes('--rollback')) {
      const { data } = await client.call('rollbackMigrations', {});
      console.log(`Rolled back batch ${data.batchNo}: ${data.ran.length} migrations`);
      for (const migration of data.ran) console.log(`  ${migration}`);
      if (data.snapshot) console.log(`Pre-rollback snapshot: ${data.snapshot}`);
    } else {
      const { data } = await client.call('migrateSafe', {});
      if (data.status === 'migrated') {
        if (data.ran?.length) {
          console.log(`Ran ${data.ran.length} migrations`);
          for (const migration of data.ran) console.log(`  ${migration}`);
        } else {
          console.log('Already up to date.');
        }
      } else if (data.status === 'skipped') {
        const remedy = data.reason === 'not-configured'
          ? 'Run `sigil init` first.'
          : 'Use a direct (non-pooler) database URL for migrations.';
        throw new Error(`Migration skipped: ${data.reason}. ${remedy}`);
      } else {
        const snapshot = data.snapshot ? ` Snapshot: ${data.snapshot}.` : '';
        throw new Error(`Migration failed and was ${data.status}.${snapshot} ${data.error || ''}`.trim());
      }
    }
  } finally {
    await client.close();
  }
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

  // 1. Remove Sigil from every coding agent while its config still exists.
  try {
    const { disconnectAllClients } = await import('./setup/reset.js');
    const removed = await disconnectAllClients();
    console.log(`  agents: ${removed.length ? `disconnected ${removed.join(', ')}` : 'none connected'}`);
  } catch (err) { console.log(`  agents: ${err.message}`); }

  // 2. Remove the always-up service and stop the exact daemon PID gracefully.
  // Never use a broad `pkill -f`: it can kill unrelated checkouts/processes and
  // races PGlite shutdown while ~/.sigil is being removed.
  try {
    const { stopRuntimeForReset } = await import('./setup/reset.js');
    const stopped = await stopRuntimeForReset();
    if (!stopped.daemonStopped) {
      throw new Error(`daemon pid ${stopped.pid} is still alive`);
    }
    console.log(`  runtime: daemon stopped${stopped.serviceRemoved ? ', service removed' : ''}${stopped.forced ? ' (forced after timeout)' : ''}`);
  } catch (err) {
    throw new Error(`Reset stopped before deleting data because the runtime could not be shut down safely: ${err.message}`);
  }

  // 3. Drop the configured database only after its owning process is gone.
  if (!keepDb) {
    try {
      const { dropConfiguredDatabase } = await import('./setup/reset.js');
      const result = await dropConfiguredDatabase();
      console.log(`  database: ${result.detail}`);
    } catch (err) { console.log(`  database: drop failed (${err.message}) — continuing`); }
  } else {
    console.log('  database: kept (--keep-db)');
  }

  // 4. Remove local config/state and the generated Claude import.
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

  const { escapeRegex } = await import('./lib/text.js');
  let after = before;
  for (const p of importPaths) {
    const re = new RegExp(`^@${escapeRegex(p)}\\s*\\n?`, 'gm');
    after = after.replace(re, '');
  }

  if (after === before) return false;
  await fs.writeFile(claudeMdPath, after, 'utf8');
  return true;
}


// ─── Why ─────────────────────────────────────────────────────────────────────

async function runWhy(args) {
  if (args.length === 0 || args.includes('--help')) {
    console.log(`sigil why — Explain a search result

Usage:
  sigil why "<query>" [--namespace=<ns>] [--limit=5]

Runs the same deterministic hybrid search as normal recall and prints the
evidence used to rank each fact: cosine similarity and vector/keyword RRF.`);
    process.exit(0);
  }

  const config = (await import('./config.js')).default;
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
  const { connectOrStartDaemon } = await import('./clients/auto-spawn.js');
  const client = await connectOrStartDaemon({ timeoutMs: MEMORY_RPC_TIMEOUT_MS });
  let result;
  try {
    const { data } = await client.call('search', {
      query,
      namespaces: [namespace],
      limit,
      applyFloor: false,
    });
    result = data;
  } finally {
    await client.close();
  }

  console.log(`Query: ${query}`);
  console.log(`Namespace: ${namespace}`);
  console.log('');

  if (!result.facts.length) {
    console.log('No facts returned.');
    return;
  }

  console.log(`Facts (${result.facts.length}):`);
  for (const [i, f] of result.facts.entries()) {
    console.log(`  ${i + 1}. [rrf=${f.rrfScore ?? '?'}] [cosine=${Number(f.similarity).toFixed(4)}] [${f.category}] [conf=${f.confidence}]`);
    console.log(`     content: ${(f.content || '').slice(0, 140)}`);
  }
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
