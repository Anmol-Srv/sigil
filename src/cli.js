#!/usr/bin/env node

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { execSync as _execSync, spawn as _spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';

// Package root — works whether run from project dir or globally installed
const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

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

const [command, ...rest] = process.argv.slice(2);

const HELP = `sigil — Persistent memory for your Claude sessions

Usage:
  sigil <command> [options]

Commands:
  init [--dry-run]         Set up Sigil (DB, env, hooks, Claude integration)
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

Options:
  --help                   Show this help message

Run sigil <command> --help for command-specific options.`;

if (!command || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

const commands = {
  init: runInit,
  uninstall: runUninstall,
  doctor: runDoctor,
  remember: runRemember,
  ingest: runIngest,
  search: runSearch,
  context: runContext,
  status: runStatus,
  facts: runFacts,
  forget: runForget,
  namespace: runNamespace,
  session: runSession,
  pod: runPod,
  export: runExport,
  maintain: runMaintain,
  migrate: runMigrate,
  reset: runReset,
  register: runRegister,
  why: runWhy,
  kind: runKind,
};

const handler = commands[command];
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
  const msg = err.message || String(err);
  const code = err.code || '';

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

  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function runInit(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`sigil init — Set up Sigil (DB, env, hooks, Claude integration)

Usage:
  sigil init [--dry-run]

Options:
  --dry-run    Walk through every prompt and print the exact files that would
               be created or modified, but write nothing to disk. Use this on
               first install to preview the changes Sigil will make to your
               ~/.sigil/ and ~/.claude/ directories.

Files Sigil touches (originals are backed up to <path>.sigil.bak before write):
  ~/.sigil/.env                 Sigil config + API keys (incl. Postgres connection)
  ~/.sigil/CLAUDE.md            Sigil instructions for Claude
  ~/.claude/CLAUDE.md           One @import line added (existing content preserved)
  ~/.claude/settings.json       UserPromptSubmit + PostToolUse + Stop + SessionEnd hooks (merged)

Sigil 0.10.0+ requires Postgres. Sigil's migrations run against your DB
during init; existing tables are detected and preserved.`);
    process.exit(0);
  }

  const dryRun = args.includes('--dry-run');

  const clack = await import('@clack/prompts');
  const fs = await import('node:fs/promises');
  const { safeWrite } = await import('./lib/safe-write.js');
  const { intro, outro, select, multiselect, text, spinner, confirm, note, cancel, isCancel } = clack;

  const cortexHome = join(homedir(), '.sigil');
  const envPath = join(cortexHome, '.env');

  intro(dryRun ? 'Sigil — DRY RUN (no files will be written)' : 'Sigil — persistent memory for Claude');

  const planned = [];
  const planFile = (action, path, detail) => planned.push({ action, path, detail });

  const hasOllama = checkCommand('ollama --version');

  // ── Load existing config ─────────────────────────────────────────────────

  const existing = {};
  if (existsSync(envPath)) {
    const content = await fs.readFile(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const [k, ...v] = line.split('=');
      if (k && !k.startsWith('#')) existing[k.trim()] = v.join('=').trim();
    }
  }

  // ── LLM provider ─────────────────────────────────────────────────────────
  //
  // Each provider module under src/lib/llm/providers/ exports a `meta`
  // descriptor and a `setup({ existing, clack })` flow. The picker is
  // generated from `listProvidersForSetup`, so adding a new provider is
  // a one-file change — no edits to runInit required.

  const { listProvidersForSetup } = await import('./lib/llm/registry.js');
  const providers = await listProvidersForSetup();

  const llmProvider = await select({
    message: 'LLM provider (for fact extraction and reasoning)',
    options: providers.map(({ id, label, hint }) => ({ value: id, label, hint })),
    initialValue: existing.LLM_PROVIDER || 'claude-cli',
  });
  if (isCancel(llmProvider)) { cancel('Setup cancelled.'); process.exit(0); }

  const chosenProvider = providers.find((p) => p.id === llmProvider);
  const providerResult = await chosenProvider.setup({ existing, clack });
  if (providerResult === null) { cancel('Setup cancelled.'); process.exit(0); }
  const providerEnv = providerResult.env || {};
  // Surface the OpenRouter key (either freshly entered or pre-existing) so
  // the embedding picker below can default to OpenRouter when it makes
  // sense. With the registry pattern, providers return their env in
  // providerEnv; we fall back to `existing` for keys the user already had.
  let openrouterKey = providerEnv.OPENROUTER_API_KEY || existing.OPENROUTER_API_KEY || '';

  // ── Embeddings ────────────────────────────────────────────────────────────

  const embeddingProvider = await select({
    message: 'Embedding provider (for semantic search)',
    options: [
      { value: 'ollama',     label: 'Ollama',     hint: 'nomic-embed-text — free, runs locally' },
      { value: 'openai',     label: 'OpenAI',     hint: 'text-embedding-3-large — requires API key' },
      { value: 'openrouter', label: 'OpenRouter', hint: 'gateway — one key for LLM + embeddings; uses vendor/model names' },
    ],
    initialValue: existing.EMBEDDING_PROVIDER || (hasOllama ? 'ollama' : (openrouterKey ? 'openrouter' : 'openai')),
  });
  if (isCancel(embeddingProvider)) { cancel('Setup cancelled.'); process.exit(0); }

  // Provider-specific model + dimensions. The DB schema is conditional on
  // EMBEDDING_DIMENSIONS at migrate time (vector(768) by default; upgrade
  // migration fires when EMBEDDING_DIMENSIONS >= 1024). Writing both here
  // BEFORE the migrate step lets the schema match the embedder.
  //
  //   Ollama nomic-embed-text → 768d (matches default schema)
  //   OpenAI text-embedding-3-large → truncated to 1024d via the `dimensions`
  //   parameter (Matryoshka). Migration upgrades schema vector(768) → vector(1024).
  //
  // CONCRETE GUARANTEE: if the user changes provider, MODEL and DIMENSIONS
  // MUST reset to the new provider's defaults. The old behavior of preserving
  // existing.EMBEDDING_MODEL across provider changes is exactly what produced
  // the broken state "EMBEDDING_PROVIDER=ollama, EMBEDDING_MODEL=text-embedding-3-large"
  // — provider's embedder call would fail and search would silently return
  // nothing while data sat untouched in the DB. We also warn loudly when the
  // dimensions change, because that requires re-embedding every existing fact
  // (which sigil init does not do — only `sigil reset` followed by re-ingest).
  const embeddingDefaults = {
    ollama: { model: 'nomic-embed-text', dimensions: 768 },
    openai: { model: 'text-embedding-3-large', dimensions: 1024 },
    // OpenRouter proxies the same OpenAI text-embedding-3-large under a
    // namespaced model id. 1024d via Matryoshka truncation, same as the
    // direct-OpenAI path so the DB schema lines up.
    openrouter: { model: 'openai/text-embedding-3-large', dimensions: 1024 },
  };
  const priorProvider = existing.EMBEDDING_PROVIDER;
  const providerChanged = priorProvider && priorProvider !== embeddingProvider;

  let embeddingModel;
  let embeddingDimensions;
  if (providerChanged) {
    // Force a coherent default for the NEW provider; never inherit a model
    // name from the prior provider.
    embeddingModel = embeddingDefaults[embeddingProvider].model;
    embeddingDimensions = embeddingDefaults[embeddingProvider].dimensions;
    const priorDims = Number(existing.EMBEDDING_DIMENSIONS) || embeddingDefaults[priorProvider]?.dimensions;
    if (priorDims && priorDims !== embeddingDimensions) {
      note(
        `You're switching embedding provider from ${priorProvider} (${priorDims}d) to ${embeddingProvider} (${embeddingDimensions}d).\n`
        + 'Existing facts in your DB were embedded at the previous dimensions — they will become\n'
        + 'unsearchable until re-ingested. To stay coherent without losing data, either:\n'
        + `  • keep ${priorProvider} as your embedding provider, or\n`
        + '  • run `sigil reset` to wipe + re-ingest from scratch.',
        'Dimension change ahead',
      );
      const proceed = await confirm({
        message: `Continue with ${embeddingProvider} (${embeddingDimensions}d)? Existing facts will become unsearchable.`,
        initialValue: false,
      });
      if (isCancel(proceed) || !proceed) {
        cancel('Setup cancelled — re-run sigil init and keep the prior embedding provider, or run sigil reset to wipe first.');
        process.exit(0);
      }
    }
  } else {
    // Same provider as before (or fresh install) — honor any pre-set values.
    embeddingModel = existing.EMBEDDING_MODEL || embeddingDefaults[embeddingProvider].model;
    embeddingDimensions = Number(existing.EMBEDDING_DIMENSIONS) || embeddingDefaults[embeddingProvider].dimensions;
  }

  // If the user picked OpenRouter for embeddings but we haven't collected an
  // OpenRouter key yet (e.g. they chose Anthropic / OpenAI for the LLM),
  // prompt for it now. Skipping this would write EMBEDDING_PROVIDER=openrouter
  // with no key, which only blows up later at first hook call.
  if (embeddingProvider === 'openrouter' && !openrouterKey) {
    const key = await text({
      message: 'OpenRouter API key (for embeddings) — get one at openrouter.ai/keys',
      placeholder: existing.OPENROUTER_API_KEY ? '(unchanged)' : 'sk-or-...',
      validate: (v) => {
        if (!v && !existing.OPENROUTER_API_KEY) return 'API key is required';
        if (v && !v.startsWith('sk-or-')) return 'OpenRouter keys start with "sk-or-" — check paste';
      },
    });
    if (isCancel(key)) { cancel('Setup cancelled.'); process.exit(0); }
    if (key) openrouterKey = key;
  }

  // ── Ollama health check + model pull ──────────────────────────────────────
  //
  // Three states matter, in order:
  //   1. Binary missing      → block install (no path forward without it)
  //   2. Binary present, server down → spawn `ollama serve` in background, then pull in parallel
  //   3. Server reachable    → pull only if model missing
  //
  // The previous code only checked the binary, so on a fresh `brew install ollama`
  // box (where the daemon isn't auto-started) `ollama list` and `ollama pull`
  // both fail silently and init "succeeds" with a broken embedder.

  if (embeddingProvider === 'ollama') {
    if (!hasOllama) {
      note(
        'Ollama is not installed.\n' +
        'Install from https://ollama.com then run: ollama pull nomic-embed-text\n' +
        'Or re-run sigil init and choose OpenAI for embeddings.',
        'Ollama not found',
      );
      cancel('Install Ollama then re-run sigil init.');
      process.exit(0);
    }

    const ollamaHost = existing.OLLAMA_HOST || 'http://localhost:11434';

    if (dryRun) {
      planFile('check', `ollama server @ ${ollamaHost}`, 'start in background if not running');
      planFile('pull', 'ollama:nomic-embed-text', '~270MB embedding model (if not already present)');
    } else {
      let serverUp = await isOllamaServerRunning(ollamaHost);
      let serveProc = null;

      if (!serverUp) {
        const s = spinner();
        s.start('Starting ollama serve in the background...');
        serveProc = startOllamaServe();
        serverUp = await waitForOllamaServer(ollamaHost, 15000);
        if (serverUp) {
          s.stop(`Ollama server ready (pid ${serveProc?.pid ?? '?'}, background)`);
        } else {
          s.stop('Ollama server did not come up in time');
          note(
            'Sigil tried to start `ollama serve` in the background but it did not\n' +
            'become reachable at ' + ollamaHost + ' within 15s.\n\n' +
            'Open a new terminal, run `ollama serve`, then re-run `sigil init`.',
            'Ollama server unreachable',
          );
          cancel('Start ollama serve manually then re-run sigil init.');
          process.exit(0);
        }
      }

      // Server is up. Check for the model and pull in parallel with serve still running.
      const hasModel = checkCommand('ollama list 2>/dev/null | grep nomic-embed-text');
      if (!hasModel) {
        const pull = await confirm({ message: 'Pull nomic-embed-text embedding model now? (~270MB)' });
        if (isCancel(pull)) { cancel('Setup cancelled.'); process.exit(0); }
        if (pull) {
          const s = spinner();
          s.start('Pulling nomic-embed-text...');
          try {
            _execSync('ollama pull nomic-embed-text', { stdio: 'pipe' });
            s.stop('nomic-embed-text ready');
          } catch {
            s.stop('Pull failed — run: ollama pull nomic-embed-text manually');
          }
        }
      }

      // Detach the background serve so it survives this CLI process exit.
      if (serveProc) serveProc.unref();
    }
  }

  // ── Namespace ─────────────────────────────────────────────────────────────

  const namespace = await text({
    message: 'Default namespace',
    placeholder: 'default',
    initialValue: existing.DEFAULT_NAMESPACE || 'default',
    validate: (v) => { if (!v.trim()) return 'Cannot be empty'; },
  });
  if (isCancel(namespace)) { cancel('Setup cancelled.'); process.exit(0); }

  // ── Postgres connection ───────────────────────────────────────────────────
  //
  // Sigil 0.10.0+ requires Postgres. We assume the user has Postgres running
  // (Docker, brew, RDS, anything). On first init we probe the connection;
  // if the sigil database doesn't exist yet we ask once for admin creds and
  // bootstrap it (CREATE DATABASE + CREATE USER + GRANT + CREATE EXTENSION
  // vector). Admin creds are used once and dropped — only sigil_app
  // credentials land in ~/.sigil/.env.

  const dbHost = await text({
    message: 'Postgres host',
    placeholder: existing.SIGIL_DB_HOST || 'localhost',
    initialValue: existing.SIGIL_DB_HOST || 'localhost',
  });
  if (isCancel(dbHost)) { cancel('Setup cancelled.'); process.exit(0); }

  const dbPortStr = await text({
    message: 'Postgres port',
    placeholder: existing.SIGIL_DB_PORT || '5432',
    initialValue: existing.SIGIL_DB_PORT || '5432',
    validate: (v) => { if (v && !/^\d+$/.test(v)) return 'Port must be a number'; },
  });
  if (isCancel(dbPortStr)) { cancel('Setup cancelled.'); process.exit(0); }
  const dbPort = Number(dbPortStr);

  const dbName = await text({
    message: 'Sigil database name',
    placeholder: existing.SIGIL_DB_NAME || 'sigil',
    initialValue: existing.SIGIL_DB_NAME || 'sigil',
  });
  if (isCancel(dbName)) { cancel('Setup cancelled.'); process.exit(0); }

  const dbUser = await text({
    message: 'Sigil database user',
    placeholder: existing.SIGIL_DB_USER || 'sigil_app',
    initialValue: existing.SIGIL_DB_USER || 'sigil_app',
  });
  if (isCancel(dbUser)) { cancel('Setup cancelled.'); process.exit(0); }

  const dbPassword = await text({
    message: existing.SIGIL_DB_PASSWORD ? 'Sigil database password (keep existing — press Enter)' : 'Sigil database password',
    placeholder: existing.SIGIL_DB_PASSWORD ? '(unchanged)' : 'sigil_dev or generate',
    validate: (v) => { if (!v && !existing.SIGIL_DB_PASSWORD) return 'Password required'; },
  });
  if (isCancel(dbPassword)) { cancel('Setup cancelled.'); process.exit(0); }
  const finalDbPassword = dbPassword || existing.SIGIL_DB_PASSWORD;

  // Probe with the prompted credentials. If sigil DB exists + creds work,
  // we're done. Otherwise: missing DB → ask for admin to bootstrap. Auth
  // failure → ask if they want to reset the password via admin.
  if (!dryRun) {
    const { probeSigilConnection, ensurePostgresDatabase, diagnoseConnectionError } =
      await import('./db/setup.js');
    const probeSpinner = spinner();
    probeSpinner.start('Probing Postgres connection...');
    const probe = await probeSigilConnection({
      host: dbHost, port: dbPort, database: dbName, user: dbUser, password: finalDbPassword,
    });

    if (probe.ok) {
      probeSpinner.stop(`Connected to ${dbUser}@${dbHost}:${dbPort}/${dbName}`);
    } else {
      const diag = diagnoseConnectionError({ code: probe.code, message: probe.message });
      probeSpinner.stop(`Connection failed (${diag.kind})`);

      if (diag.kind === 'unreachable') {
        cancel(`Postgres unreachable at ${dbHost}:${dbPort}.\n${diag.hint}`);
        process.exit(1);
      }

      if (diag.kind === 'missing-db' || diag.kind === 'auth') {
        const wantsBootstrap = await confirm({
          message: diag.kind === 'missing-db'
            ? `Database "${dbName}" does not exist. Create it now (requires admin credentials)?`
            : `Authentication failed for ${dbUser}@${dbName}. Create / reset the user now (requires admin credentials)?`,
          initialValue: true,
        });
        if (isCancel(wantsBootstrap) || !wantsBootstrap) {
          cancel('Setup cancelled — fix Postgres credentials and re-run sigil init.');
          process.exit(0);
        }

        const adminUser = await text({
          message: 'Postgres admin user',
          placeholder: 'postgres',
          initialValue: 'postgres',
        });
        if (isCancel(adminUser)) { cancel('Setup cancelled.'); process.exit(0); }

        const adminPassword = await text({
          message: 'Postgres admin password (used once, not stored)',
          placeholder: 'admin password',
          validate: (v) => { if (!v) return 'Required to create the database'; },
        });
        if (isCancel(adminPassword)) { cancel('Setup cancelled.'); process.exit(0); }

        const bootstrapSpinner = spinner();
        bootstrapSpinner.start('Creating database, user, and pgvector extension...');
        try {
          const { actions } = await ensurePostgresDatabase({
            admin: { host: dbHost, port: dbPort, user: adminUser, password: adminPassword },
            sigil: { database: dbName, user: dbUser, password: finalDbPassword },
          });
          bootstrapSpinner.stop(`Bootstrapped: ${actions.join(', ')}`);
        } catch (err) {
          bootstrapSpinner.stop('Bootstrap failed');
          cancel(err.message);
          process.exit(1);
        }
      } else {
        cancel(`Postgres setup failed: ${diag.hint}`);
        process.exit(1);
      }
    }
  }

  // ── Write config ──────────────────────────────────────────────────────────
  //
  // Build the .env by starting from EXISTING keys (preserves anything the
  // user added manually or that earlier init runs collected) and overlaying
  // the values we just prompted. This is the fix for the long-standing
  // bug where re-running `sigil init` would silently drop keys it didn't
  // ask about (e.g., SIGIL_DB_*, custom env vars).

  if (!dryRun) await fs.mkdir(cortexHome, { recursive: true });
  const encryptionKey = existing.SIGIL_ENCRYPTION_KEY || generateSecret(64);

  const finalEnv = { ...existing };
  finalEnv.LLM_PROVIDER = llmProvider;
  finalEnv.OLLAMA_HOST = existing.OLLAMA_HOST || 'http://localhost:11434';
  // Provider env overlays last so a user-supplied OLLAMA_HOST (when ollama
  // is the picked LLM) wins over the default; same for any other key the
  // provider's setup() returned.
  Object.assign(finalEnv, providerEnv);
  finalEnv.EMBEDDING_PROVIDER = embeddingProvider;
  finalEnv.EMBEDDING_MODEL = embeddingModel;
  finalEnv.EMBEDDING_DIMENSIONS = String(embeddingDimensions);
  finalEnv.DEFAULT_NAMESPACE = namespace;
  finalEnv.SIGIL_ENCRYPTION_KEY = encryptionKey;
  finalEnv.SIGIL_DB_TYPE = 'postgres';
  finalEnv.SIGIL_DB_HOST = dbHost;
  finalEnv.SIGIL_DB_PORT = String(dbPort);
  finalEnv.SIGIL_DB_NAME = dbName;
  finalEnv.SIGIL_DB_USER = dbUser;
  finalEnv.SIGIL_DB_PASSWORD = finalDbPassword;

  const envContent = [
    `# Sigil — generated ${new Date().toISOString().slice(0, 10)}`,
    '# (re-running `sigil init` preserves unrecognised keys — edit manually as needed)',
    '',
    ...Object.entries(finalEnv).map(([k, v]) => `${k}=${v}`),
  ].join('\n');

  const envResult = await safeWrite(envPath, envContent, { dryRun });
  planFile(envResult.action, envPath, `${envResult.bytes} bytes`);

  // ── Database (Postgres — required) ────────────────────────────────────────

  if (!dryRun) {
    dotenvConfig({ path: envPath, override: true, quiet: true });

    const dbSpinner = spinner();
    dbSpinner.start('Initialising memory database...');
    try {
      const { MIGRATIONS_DIR: migrationDir } = await import('./lib/paths.js');
      const cortexDb = (await import('./db/cortex.js')).default;
      const [, migrations] = await cortexDb.migrate.latest({ directory: migrationDir });
      await cortexDb.destroy();
      dbSpinner.stop(
        migrations.length ? `Memory database ready (${migrations.length} tables created)` : 'Memory database up to date',
      );
    } catch (err) {
      dbSpinner.stop('Database setup failed');
      cancel(`${err.message}\n\nSigil 0.10.0+ requires Postgres. Set SIGIL_DB_HOST/PORT/NAME/USER/PASSWORD in ~/.sigil/.env or re-run sigil init.`);
      process.exit(1);
    }

    // ── Embedder smoke test ──────────────────────────────────────────────
    //
    // Verify the configured embedder actually works against a live "ping"
    // call before declaring init successful. Catches:
    //   - wrong model name for the picked provider (the exact bug that
    //     produced EMBEDDING_PROVIDER=ollama with model=text-embedding-3-large)
    //   - missing API keys / unreachable ollama daemon / network issues
    //   - dimension mismatch between embedder output and EMBEDDING_DIMENSIONS
    //
    // This is the LAST barrier before clients get configured — once we
    // write hooks pointing at a broken embedder, every future Claude session
    // would silently fail to inject memory.
    const embedSpinner = spinner();
    embedSpinner.start(`Verifying ${embeddingProvider} embedder...`);
    try {
      // Use the higher-level ingestion embedder so API keys + dimensions
      // + caching flow through the same path the hooks use at runtime.
      // Calling getEmbedder() directly would bypass the per-call
      // providerConfig plumbing that supplies the API key.
      const { embed } = await import('./ingestion/embedder.js');
      const vec = await embed('ping');
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error(`embedder returned ${typeof vec} (length ${vec?.length}) — expected number[]`);
      }
      if (vec.length !== embeddingDimensions) {
        throw new Error(
          `embedder returned ${vec.length}d vector but config says EMBEDDING_DIMENSIONS=${embeddingDimensions}d.\n`
          + `This means ${embeddingProvider}/${embeddingModel} doesn't produce ${embeddingDimensions}d embeddings — `
          + 'one of them is wrong.',
        );
      }
      embedSpinner.stop(`Embedder healthy (${vec.length}d via ${embeddingProvider}/${embeddingModel})`);
    } catch (err) {
      embedSpinner.stop('Embedder check failed');
      cancel(
        `${embeddingProvider}/${embeddingModel} cannot embed: ${err.message}\n\n`
        + 'Your config was written to ' + envPath + ' — fix the root cause then re-run sigil init:\n'
        + (embeddingProvider === 'ollama'
          ? '  • ensure `ollama serve` is running\n  • run `ollama pull ' + embeddingModel + '` to fetch the model\n'
          : '  • verify OPENAI_API_KEY is valid and has embedding access\n  • check the model name matches an embedding model (text-embedding-3-large / -small)\n')
        + '\nSigil init aborted before any AI clients were touched — your existing setup is unchanged.',
      );
      process.exit(1);
    }
  } else {
    planFile('migrate', 'postgres', `${config.db.host}:${config.db.port}/${config.db.database}`);
    planFile('verify', 'embedder', `${embeddingProvider}/${embeddingModel} — live ping (skipped in dry-run)`);
  }

  // ── Client integrations ──────────────────────────────────────────────────
  //
  // Each client module under src/lib/clients/ exports { meta, detect, install }.
  // We ask the user once which clients to install for, defaulting to whatever
  // we can auto-detect on the filesystem. Picked clients run install() in
  // sequence; their plan actions feed the shared dry-run summary.

  const { listClients } = await import('./lib/clients/index.js');
  const clients = await listClients();
  const detected = await Promise.all(clients.map((c) => c.detect()));
  const detectedIds = clients.filter((_, i) => detected[i]).map((c) => c.id);

  const pickedIds = await multiselect({
    message: 'Install Sigil for which clients? (space to toggle, enter to confirm)',
    options: clients.map((c, i) => ({
      value: c.id,
      label: c.label,
      hint: detected[i] ? `${c.hint} — detected` : c.hint,
    })),
    initialValues: detectedIds.length ? detectedIds : ['claude-code'],
    required: false,
  });
  if (isCancel(pickedIds)) { cancel('Setup cancelled.'); process.exit(0); }

  const clientSpinner = spinner();
  clientSpinner.start(dryRun ? 'Computing client integration plan...' : 'Configuring client integrations...');
  for (const id of pickedIds) {
    const client = clients.find((c) => c.id === id);
    const { actions } = await client.install({ dryRun });
    for (const a of actions) planFile(a.action, a.path, a.detail);
  }
  if (!dryRun) {
    const { updateContextSnapshot } = await import('./memory/facts/hot-context.js');
    await updateContextSnapshot({ namespace: namespace.toString() }).catch(() => {});
  }
  clientSpinner.stop(
    dryRun
      ? 'Plan computed.'
      : pickedIds.length
        ? `Configured ${pickedIds.length} client${pickedIds.length > 1 ? 's' : ''}: ${pickedIds.join(', ')}`
        : 'No clients selected — skipping integration step',
  );

  // ── Done ──────────────────────────────────────────────────────────────────

  if (dryRun) {
    const lines = planned.map((p) => `  ${pad(p.action, 8)} ${p.path}${p.detail ? `  (${p.detail})` : ''}`);
    note(
      [
        'Dry run — no files were written. The following would happen:',
        '',
        ...lines,
        '',
        'Each existing file would be backed up to <path>.sigil.bak before its first',
        'modification. Re-run without --dry-run to apply.',
      ].join('\n'),
      'Plan',
    );
    outro('Dry run complete.');
    return;
  }

  note(
    [
      `Memory store  ~/.sigil/db  (embedded, no server needed)`,
      `Config        ${envPath}`,
      `Claude        ~/.claude/CLAUDE.md — Sigil is now your memory`,
      `Backups       any pre-existing files saved to <path>.sigil.bak`,
      '',
      'Claude will search Sigil before answering and save important',
      'facts automatically. Start a new Claude session to begin.',
      '',
      'Quick start:',
      '  sigil remember "your first fact"',
      '  sigil ingest <file-or-url>',
      '  sigil search "anything"',
    ].join('\n'),
    'Setup complete',
  );

  outro('Open a new Claude Code session to start using Sigil.');
}

function pad(s, n) { return String(s).padEnd(n); }

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
  sigil doctor

Checks: Postgres connection, LLM provider, embedding provider, hook registration, hook error budget.`);
    process.exit(0);
  }

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

  // Database
  try {
    const cortexDb = (await import('./db/cortex.js')).default;
    const config = (await import('./config.js')).default;
    await cortexDb.raw('SELECT 1');
    log('ok', 'Database', `Postgres @ ${config.db.host}:${config.db.port}/${config.db.database}`);

    const { getFactCount } = await import('./memory/facts/store.js');
    const { getStats } = await import('./memory/documents/store.js');
    const [facts, stats] = await Promise.all([getFactCount(), getStats()]);
    log('ok', 'Stored data', `${stats.documentCount} docs, ${stats.totalChunks} chunks, ${facts} facts`);
    await cortexDb.destroy();
  } catch (err) {
    const msg = err.message || String(err);
    if (/ECONNREFUSED|connection refused|password authentication failed/i.test(msg)) {
      log('fail', 'Database', `Postgres unreachable — ${msg.split('\n')[0]}`);
      log('warn', 'Recovery', "check that Postgres is running and SIGIL_DB_* env vars are set in ~/.sigil/.env");
    } else {
      log('fail', 'Database', msg);
    }
  }

  // LLM provider
  try {
    const { detectProvider, isOllamaReachable, isClaudeCliAvailable } = await import('./lib/llm/registry.js');
    const config = (await import('./config.js')).default;
    const provider = await detectProvider();

    if (provider === 'anthropic') log('ok', 'LLM provider', `anthropic (API key set)`);
    else if (provider === 'openai') log('ok', 'LLM provider', `openai (API key set)`);
    else if (provider === 'openrouter') log('ok', 'LLM provider', `openrouter (model=${config.llm.openrouterModel})`);
    else if (provider === 'ollama') log('ok', 'LLM provider', `ollama @ ${config.llm.ollamaHost}`);
    else if (provider === 'claude-cli') log('ok', 'LLM provider', 'claude-cli (Claude Code subscription)');
    else log('warn', 'LLM provider', provider);
  } catch (err) {
    log('fail', 'LLM provider', err.message.split('\n')[0]);
  }

  // Embedding provider
  try {
    const { detectEmbeddingProvider } = await import('./lib/llm/registry.js');
    const config = (await import('./config.js')).default;
    const provider = await detectEmbeddingProvider();
    log('ok', 'Embedding provider', `${provider} / ${config.embedding.model}`);
  } catch (err) {
    log('fail', 'Embedding provider', err.message.split('\n')[0]);
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
      const result = await client.verify();
      if (result.installed) {
        log('ok', `${client.label} integration`, 'configured');
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

  const { listFacts } = await import('./memory/facts/store.js');
  const config = (await import('./config.js')).default;
  const cortexDb = (await import('./db/cortex.js')).default;

  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1] || config.defaults.namespace;
  const category = args.find((a) => a.startsWith('--category='))?.split('=')[1];
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || 20);

  const facts = await listFacts({ namespace, category, limit });

  if (!facts.length) {
    console.log('No facts found.');
  } else {
    for (const fact of facts) {
      const importance = fact.importance === 'vital' ? ' [VITAL]' : '';
      console.log(`${fact.uid.slice(0, 8)} [${fact.category}]${importance} ${fact.content}`);
    }
    console.log(`\n${facts.length} fact${facts.length > 1 ? 's' : ''} shown. Use 'sigil forget <id>' to delete.`);
  }

  await cortexDb.destroy();
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

  const { deleteFact } = await import('./memory/facts/store.js');
  const cortexDb = (await import('./db/cortex.js')).default;

  const idArg = args[0];

  // Resolve to a UID — accept three input forms so users can paste whatever
  // they see in `sigil facts` / `sigil search` output without thinking
  // about which kind of identifier it is.
  let match;
  if (/^\d+$/.test(idArg)) {
    // Pure-numeric → numeric row id
    [match] = await cortexDb('fact').where({ id: Number(idArg) }).limit(1);
  } else if (idArg.startsWith('fact-')) {
    // UID or UID prefix
    [match] = await cortexDb('fact').where('uid', 'like', `${idArg}%`).limit(1);
  } else {
    // Bare prefix fallback
    [match] = await cortexDb('fact').where('uid', 'like', `${idArg}%`).limit(1);
  }

  if (!match) {
    console.error(`No fact matches: ${idArg}`);
    await cortexDb.destroy();
    process.exit(1);
  }

  const deleted = await deleteFact(match.uid);
  if (!deleted) {
    console.error(`No fact matches: ${idArg}`);
    await cortexDb.destroy();
    process.exit(1);
  }

  console.log(`Forgotten: ${deleted.content}`);
  await cortexDb.destroy();
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

Examples:
  sigil remember "I prefer tabs over spaces"
  sigil remember "Uses React" "Prefers TypeScript" "Deadline is April 20"
  sigil remember --bg "user likes dark mode" "project uses Postgres"`);
    process.exit(0);
  }

  const background = flags.includes('--bg') || flags.includes('--background');

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
    // Spawn detached process and return immediately
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      [process.argv[1], 'remember', ...facts],
      { detached: true, stdio: 'ignore', env: { ...process.env } },
    );
    child.unref();
    console.log(`Saving ${facts.length} fact${facts.length > 1 ? 's' : ''} in background...`);
    return;
  }

  const { ingestDocument } = await import('./ingestion/pipeline.js');
  const config = (await import('./config.js')).default;
  const cortexDb = (await import('./db/cortex.js')).default;

  // Ingest sequentially. Parallel ingests with shared topics ("auth",
  // "TypeScript", "Smara") race on entity creation AND on entity-rename
  // updates — Stage 4's insert-on-conflict handles the create race, but
  // updateName can still hit a unique-violation when two ingests try to
  // rename different entity rows to the same canonical name. Sequential
  // is ~Nx slower for N facts but eliminates the contention class entirely
  // and preserves AUDM's pairwise dedup invariants. (`sigil remember A B C`
  // typical: 3 facts × ~1.5s = 4.5s, fine for any UX.)
  const results = [];
  for (const text of facts) {
    const result = await ingestDocument({ content: text, namespace: config.defaults.namespace, classify: true });
    results.push(result);
  }

  let totalAdded = 0;
  let totalUpdated = 0;
  let alreadyKnown = 0;

  for (const result of results) {
    if (result.skipped || result.route === 'noise') {
      alreadyKnown++;
    } else {
      totalAdded += result.facts?.added ?? 0;
      totalUpdated += result.facts?.updated ?? 0;
      if ((result.facts?.added ?? 0) + (result.facts?.updated ?? 0) === 0) alreadyKnown++;
    }
  }

  // Refresh hot-context snapshot so new facts are available at next session start
  if (totalAdded + totalUpdated > 0) {
    const { updateContextSnapshot } = await import('./memory/facts/hot-context.js');
    await updateContextSnapshot({ namespace: config.defaults.namespace }).catch(() => {});
  }

  await cortexDb.destroy();

  const parts = [];
  if (totalAdded)   parts.push(`${totalAdded} new`);
  if (totalUpdated) parts.push(`${totalUpdated} updated`);
  if (alreadyKnown) parts.push(`${alreadyKnown} already known`);
  console.log(parts.length ? `Remembered. (${parts.join(', ')})` : 'Already known.');
}


// ─── Register MCP ────────────────────────────────────────────────────────────

async function runRegister(args) {
  if (args.includes('--help')) {
    console.log(`sigil register — Register Sigil as a Claude Code MCP server

Usage:
  sigil register [--print]

Options:
  --print   Print the config JSON without modifying files`);
    process.exit(0);
  }

  const globalEnvPath = join(homedir(), '.sigil', '.env');
  const envPath = existsSync(globalEnvPath) ? globalEnvPath : resolve(process.cwd(), '.env');
  await doRegister(PKG_DIR, envPath, args.includes('--print'));
}

async function doRegister(pkgDir, envPath, printOnly = false) {
  const fs = await import('node:fs/promises');

  const serverPath = join(pkgDir, 'src', 'server.js');

  const mcpEntry = {
    command: process.execPath,
    args: [serverPath, '--mcp'],
    env: { DOTENV_CONFIG_PATH: envPath },
  };

  const configJson = JSON.stringify({ mcpServers: { sigil: mcpEntry } }, null, 2);

  if (printOnly) {
    console.log('\nAdd this to your Claude Code MCP config:\n');
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
      _execSync(
        `claude mcp add sigil -s user -- ${process.execPath} ${serverPath} --mcp`,
        { stdio: 'pipe', env: { ...process.env, DOTENV_CONFIG_PATH: envPath } },
      );
      console.log('Registered sigil MCP server via `claude mcp add`.');
      console.log(`  Server: ${serverPath}`);
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
      const config = JSON.parse(raw);
      config.mcpServers = config.mcpServers || {};
      config.mcpServers.sigil = mcpEntry;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log(`Registered sigil MCP server in ${configPath}`);
      registered = true;
      break;
    } catch {
      // Try next path
    }
  }

  if (!registered) {
    console.log('Could not auto-register. Add this to your Claude Code MCP configuration:\n');
    console.log(configJson);
    console.log('\nOr run: claude mcp add sigil -- node ' + serverPath + ' --mcp');
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
  --skip-facts        Skip fact extraction
  --skip-entities     Skip entity linking

Examples:
  sigil ingest ./docs/README.md
  sigil ingest "docs/**/*.md"
  sigil ingest https://example.com/page
  sigil ingest file1.md file2.md --namespace=engineering`);
    process.exit(0);
  }

  const { ingestDocument } = await import('./ingestion/pipeline.js');
  const { readSource, readSources } = await import('./ingestion/sources/file.js');
  const { fetchSource } = await import('./ingestion/sources/url.js');
  const cortexDb = (await import('./db/cortex.js')).default;

  const namespace = flags.find((f) => f.startsWith('--namespace='))?.split('=')[1];
  const skipFacts = flags.includes('--skip-facts');
  const skipEntities = flags.includes('--skip-entities');

  const results = { success: [], failed: [], skipped: [] };
  const startTime = Date.now();

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
        const result = await ingestDocument({
          content: source.content,
          title: source.title,
          sourcePath: source.sourcePath,
          sourceType: source.sourceType,
          contentType: source.contentType,
          namespace,
          metadata: source.metadata,
          skipFacts,
          skipEntities,
        });

        if (result.skipped) {
          results.skipped.push(source.title);
          console.log(`  Skipped (unchanged)`);
        } else {
          results.success.push(source.title);
          console.log(`  Done — ${result.chunkCount} chunks, ${result.facts.total} facts (${result.facts.added} new, ${result.facts.updated} updated)`);
        }
      }
    } catch (err) {
      console.error(`  Failed: ${input} — ${err.message}`);
      results.failed.push({ input, error: err.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${results.success.length} ingested, ${results.skipped.length} skipped, ${results.failed.length} failed`);

  if (results.success.length > 0) {
    const config = (await import('./config.js')).default;
    const { updateContextSnapshot } = await import('./memory/facts/hot-context.js');
    await updateContextSnapshot({ namespace: config.defaults.namespace }).catch(() => {});
  }

  await cortexDb.destroy();

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
  --graph             Enable graph enhancement
  --route             Enable LLM query routing
  --synthesize        Enable LLM answer synthesis
  --chunks            Include raw chunk matches
  --no-graph          Disable graph enhancement

Examples:
  sigil search "authentication flow"
  sigil search "deploy process" --namespace=engineering
  sigil search "API design" --limit=5`);
    process.exit(0);
  }

  const { search } = await import('./memory/search/hybrid.js');
  const config = (await import('./config.js')).default;
  const cortexDb = (await import('./db/cortex.js')).default;

  const nsFlag = flags.find((f) => f.startsWith('--namespace='))?.split('=')[1];
  const namespaces = nsFlag ? nsFlag.split(',') : [config.defaults.namespace];
  const limit = Number(flags.find((f) => f.startsWith('--limit='))?.split('=')[1] || 10);
  const useGraph = flags.includes('--graph') && !flags.includes('--no-graph');
  const route = flags.includes('--route');
  const synthesize = flags.includes('--synthesize');
  const includeChunks = flags.includes('--chunks') || synthesize;

  const { facts, chunks, synthesized } = await search(query, {
    namespaces,
    limit,
    useGraph,
    route,
    synthesize,
    includeChunks,
  });

  if (synthesized) {
    console.log(synthesized);
  }

  if (facts.length) {
    console.log(`\nFacts (${facts.length}):`);
    for (const fact of facts) {
      console.log(`  ${fact.content}${formatRelevance(fact)}`);
    }
  }

  if (chunks.length) {
    console.log(`\nChunks (${chunks.length}):`);
    for (const chunk of chunks) {
      const preview = chunk.content?.slice(0, 120).replace(/\n/g, ' ');
      console.log(`  ${preview}...${formatRelevance(chunk)}`);
    }
  }

  if (!facts.length && !chunks.length) {
    console.log('No results found.');
  }

  await cortexDb.destroy();
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

  const config = (await import('./config.js')).default;
  const cortexDb = (await import('./db/cortex.js')).default;
  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1] || config.defaults.namespace;
  const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? Number(limitArg) : 20;
  const explain = args.includes('--explain');

  if (explain) {
    // Don't write the snapshot — show which kind each fact came from.
    await import('./memory/pods/kinds/index.js');
    const { activeKinds } = await import('./memory/pods/registry.js');
    const { factsInPodsByRecency } = await import('./memory/facts/hot-context.js');

    const ctx = { namespace, cwd: process.cwd() };
    const active = await activeKinds(ctx);
    console.log(`Hot-context blend for namespace=${namespace}:`);
    console.log('');
    for (const { kind, scope } of active) {
      console.log(`  ${kind.name} (budget=${kind.hotContextBudget}, ${kind.visibility})`);
      let facts;
      try {
        if (typeof kind.fetchFacts === 'function') {
          facts = await kind.fetchFacts(ctx, { slots: kind.hotContextBudget, namespace });
        } else {
          facts = await factsInPodsByRecency(scope, namespace, kind.hotContextBudget);
        }
      } catch (err) {
        facts = [];
        console.log(`    (failed: ${err.message})`);
      }
      if (!facts || facts.length === 0) {
        console.log('    (no facts)');
      } else {
        for (const f of facts.slice(0, kind.hotContextBudget)) {
          console.log(`    - ${(typeof f === 'string' ? f : f.content || '').slice(0, 120)}`);
        }
      }
      console.log('');
    }
    await cortexDb.destroy();
    return;
  }

  const { updateContextSnapshot } = await import('./memory/facts/hot-context.js');
  const { writeSharedInstructions } = await import('./lib/clients/instructions.js');
  await writeSharedInstructions();
  const count = await updateContextSnapshot({ namespace, limit });
  await cortexDb.destroy();

  if (count) {
    console.log(`Context refreshed — ${count} facts written to ~/.sigil/CLAUDE.md`);
  } else {
    console.log('No facts found. Ingest some content first.');
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

async function runStatus(args) {
  if (args.includes('--help')) {
    console.log(`sigil status — Show knowledge base statistics

Usage:
  sigil status [--namespace=<ns>]`);
    process.exit(0);
  }

  const { getStats } = await import('./memory/documents/store.js');
  const { getEntityCount } = await import('./memory/entities/store.js');
  const { getRelationCount } = await import('./memory/entities/relations.js');
  const { getFactCount } = await import('./memory/facts/store.js');
  const { getEntityHebbianStats } = await import('./memory/lifecycle/entity-hebbian.js');
  const cortexDb = (await import('./db/cortex.js')).default;

  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1];

  const [docStats, factCount, documents, people, topics, relations, podRows, hebbian] = await Promise.all([
    getStats(namespace),
    getFactCount(namespace),
    getEntityCount('document'),
    getEntityCount('person'),
    getEntityCount('topic'),
    getRelationCount(),
    cortexDb('pod').where({ status: 'active' }).select('podType').then((rows) => rows),
    getEntityHebbianStats({ topN: 3 }).catch(() => null),
  ]);

  const podsByType = podRows.reduce((acc, r) => {
    acc[r.podType] = (acc[r.podType] || 0) + 1;
    return acc;
  }, {});
  const podSummary = Object.entries(podsByType).map(([t, n]) => `${n} ${t}`).join(', ') || '—';

  console.log(`Sigil Knowledge Base${namespace ? ` (${namespace})` : ''}`);
  console.log(`  Documents:  ${docStats.documentCount}`);
  console.log(`  Chunks:     ${docStats.totalChunks}`);
  console.log(`  Facts:      ${factCount} active`);
  console.log(`  Entities:   ${documents} documents, ${people} people, ${topics} topics`);
  console.log(`  Relations:  ${relations}`);
  console.log(`  Pods:       ${podSummary}`);
  if (hebbian) {
    const avg = hebbian.avgStrength ? hebbian.avgStrength.toFixed(2) : '0';
    const max = hebbian.maxStrength ? hebbian.maxStrength.toFixed(2) : '0';
    console.log(`  Co-retrieval edges: ${hebbian.edgeCount} (avg ${avg}, max ${max})`);
    if (hebbian.topPairs.length) {
      console.log('  Top pairs by decayed strength:');
      for (const p of hebbian.topPairs) {
        console.log(`    ${p.aName} ↔ ${p.bName}  (decayed ${Number(p.decayed).toFixed(2)})`);
      }
    }
  }

  await cortexDb.destroy();
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

  const before = await getLifecycleStats();
  const promoted = await promoteFreshFacts();
  const closed = await closeEditingWindows();
  const factEdgesConsolidated = consolidateCoRetrievalEdges ? await consolidateCoRetrievalEdges() : 0;
  const entityEdgesConsolidated = consolidateEntityCoRetrievalEdges ? await consolidateEntityCoRetrievalEdges() : 0;
  const after = await getLifecycleStats();

  console.log('Memory maintenance:');
  console.log(`  Stages — fresh: ${before.fresh}→${after.fresh}, stable: ${before.stable}→${after.stable}, editing: ${before.editing}→${after.editing}`);
  console.log(`  Promoted (fresh→stable): ${promoted}`);
  console.log(`  Closed editing windows (editing→stable): ${closed}`);
  if (factEdgesConsolidated) console.log(`  Fact co-retrieval edges consolidated: ${factEdgesConsolidated}`);
  if (entityEdgesConsolidated) console.log(`  Entity co-retrieval edges consolidated: ${entityEdgesConsolidated}`);

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
    console.log(`sigil reset — Wipe Sigil's setup and re-run init

Usage:
  sigil reset           Show a confirmation prompt before wiping
  sigil reset --yes     Skip the prompt (for scripting); same as --confirm

Wipes:
  ~/.sigil/                      entire data directory (DB + config + CLAUDE.md)
  ~/.claude/CLAUDE.md            removes the @~/.sigil/CLAUDE.md import line

Then automatically runs 'sigil init' to walk you through fresh setup.
Hooks in ~/.claude/settings.json are re-registered by init (idempotent).`);
    process.exit(0);
  }

  const skipConfirm = args.includes('--confirm') || args.includes('--yes') || args.includes('-y');
  const home = homedir();
  const sigilDir = join(home, '.sigil');
  const claudeMdPath = join(home, '.claude', 'CLAUDE.md');

  if (!skipConfirm) {
    const clack = await import('@clack/prompts');
    clack.intro('Sigil — reset');
    clack.note(
      [
        'This will:',
        `  - delete ${sigilDir} (DB, config, CLAUDE.md, all stored facts)`,
        `  - remove the @~/.sigil/CLAUDE.md import line from ${claudeMdPath}`,
        '  - re-run sigil init from scratch (you will be re-prompted for provider + key)',
        '',
        'Hooks in ~/.claude/settings.json stay registered — init refreshes them.',
      ].join('\n'),
      'About to reset',
    );

    const proceed = await clack.confirm({
      message: 'Wipe everything and re-init?',
      initialValue: false,
    });

    if (clack.isCancel(proceed) || proceed !== true) {
      clack.cancel('Reset cancelled. Nothing changed.');
      process.exit(0);
    }
  }

  // Kill any running Sigil MCP servers before nuking their DB out from under them.
  // Best effort — pkill returning non-zero (no matches) is fine.
  try { _execSync('pkill -f "sigil/dist/server.js --mcp"', { stdio: 'pipe' }); } catch {}
  try { _execSync('pkill -f ".sigil/db" ', { stdio: 'pipe' }); } catch {}

  // Deliberately do NOT import db/cortex.js here. That module exports a
  // singleton knex pool initialised at first import; touching it now caches
  // a pool bound to the directory we're about to delete, and the later
  // runInit() re-import returns that same dead instance from the module
  // cache → "Unable to acquire a connection" on the very next migrate.
  // Letting init be the first importer in this process gets a clean pool.

  // Wipe ~/.sigil/ entirely.
  const fs = await import('node:fs/promises');
  if (existsSync(sigilDir)) {
    await fs.rm(sigilDir, { recursive: true, force: true });
  }

  // Strip the @import line from ~/.claude/CLAUDE.md (init will re-add it at end).
  await removeClaudeMdImport();

  console.log('');
  console.log('Wipe complete. Starting init...');
  console.log('');

  // Hand off to the regular init flow. runInit handles its own success message
  // and process.exit, so we return cleanly from here.
  await runInit([]);
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

async function isOllamaServerRunning(host) {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function startOllamaServe() {
  // Detached + ignored stdio so the daemon survives this CLI exit and doesn't
  // pollute the init UI. Caller is responsible for unref()ing once we're done
  // talking to it.
  return _spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
  });
}

async function waitForOllamaServer(host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOllamaServerRunning(host)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function generateSecret(bytes) {
  return randomBytes(bytes).toString('hex');
}
