#!/usr/bin/env node

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { execSync as _execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';

// Package root — works whether run from project dir or globally installed
const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Load env: project .env first, then ~/.cortex/.env as fallback for global installs
const projectEnv = resolve(process.cwd(), '.env');
const globalEnv = join(homedir(), '.cortex', '.env');

if (existsSync(projectEnv)) {
  dotenvConfig({ path: projectEnv, quiet: true });
} else if (existsSync(globalEnv)) {
  dotenvConfig({ path: globalEnv, quiet: true });
}

const [command, ...rest] = process.argv.slice(2);

const HELP = `cortex — Persistent memory for your Claude sessions

Usage:
  cortex <command> [options]

Commands:
  init                     Set up Cortex (DB, env, hooks, Claude integration)
  doctor                   Diagnose Cortex setup (DB, LLM, embeddings, hooks)
  remember "text"          Save a fact or note to memory
  ingest <file|url|glob>   Ingest documents into the knowledge base
  search "query"           Search the knowledge base
  facts                    List stored facts with IDs
  forget <id>              Delete a specific fact by ID
  namespace <sub>          Manage namespaces (list | delete <ns>)
  export [--format=json]   Export knowledge base as JSON or Markdown
  context                  Refresh the hot-context snapshot in ~/.claude/CLAUDE.md
  status                   Show knowledge base statistics
  migrate                  Run database migrations
  reset                    Reset the database (drops all data)
  register                 Register as a Claude Code MCP server (advanced)

Options:
  --help                   Show this help message

Run cortex <command> --help for command-specific options.`;

if (!command || command === '--help' || command === '-h') {
  console.log(HELP);
  process.exit(0);
}

const commands = {
  init: runInit,
  doctor: runDoctor,
  remember: runRemember,
  ingest: runIngest,
  search: runSearch,
  context: runContext,
  status: runStatus,
  facts: runFacts,
  forget: runForget,
  namespace: runNamespace,
  export: runExport,
  migrate: runMigrate,
  reset: runReset,
  register: runRegister,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  console.log(HELP);
  process.exit(1);
}

try {
  await handler(rest);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function runInit(args) {
  const clack = await import('@clack/prompts');
  const fs = await import('node:fs/promises');
  const { intro, outro, select, text, spinner, confirm, note, cancel, isCancel } = clack;

  const cortexHome = join(homedir(), '.cortex');
  const envPath = join(cortexHome, '.env');

  intro('Cortex — persistent memory for Claude');

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

  const llmProvider = await select({
    message: 'LLM provider (for fact extraction and reasoning)',
    options: [
      { value: 'claude-cli', label: 'Claude Code', hint: 'uses your existing subscription — no extra API key' },
      { value: 'openai',     label: 'OpenAI',      hint: 'gpt-4o-mini' },
      { value: 'anthropic',  label: 'Anthropic',   hint: 'Claude Haiku — requires API key' },
      { value: 'ollama',     label: 'Ollama',      hint: 'local models — no API cost' },
    ],
    initialValue: existing.LLM_PROVIDER || 'claude-cli',
  });
  if (isCancel(llmProvider)) { cancel('Setup cancelled.'); process.exit(0); }

  // ── API key ───────────────────────────────────────────────────────────────

  let openaiKey = existing.OPENAI_API_KEY || '';
  let anthropicKey = existing.ANTHROPIC_API_KEY || '';

  if (llmProvider === 'openai') {
    const key = await text({
      message: 'OpenAI API key (paste, then Enter)',
      placeholder: openaiKey ? '(keep existing — press Enter)' : 'sk-proj-...',
      validate: (v) => {
        if (!v && !openaiKey) return 'API key is required';
        if (v && !v.startsWith('sk-')) return 'OpenAI keys start with "sk-" — check paste';
      },
    });
    if (isCancel(key)) { cancel('Setup cancelled.'); process.exit(0); }
    if (key) openaiKey = key;
  } else if (llmProvider === 'anthropic') {
    const key = await text({
      message: 'Anthropic API key (paste, then Enter)',
      placeholder: anthropicKey ? '(keep existing — press Enter)' : 'sk-ant-...',
      validate: (v) => {
        if (!v && !anthropicKey) return 'API key is required';
        if (v && !v.startsWith('sk-ant-')) return 'Anthropic keys start with "sk-ant-" — check paste';
      },
    });
    if (isCancel(key)) { cancel('Setup cancelled.'); process.exit(0); }
    if (key) anthropicKey = key;
  }

  // ── Embeddings ────────────────────────────────────────────────────────────

  const embeddingProvider = await select({
    message: 'Embedding provider (for semantic search)',
    options: [
      { value: 'ollama', label: 'Ollama', hint: 'nomic-embed-text — free, runs locally' },
      { value: 'openai', label: 'OpenAI', hint: 'text-embedding-3-small — requires API key' },
    ],
    initialValue: existing.EMBEDDING_PROVIDER || (hasOllama ? 'ollama' : 'openai'),
  });
  if (isCancel(embeddingProvider)) { cancel('Setup cancelled.'); process.exit(0); }

  // ── Ollama model pull ─────────────────────────────────────────────────────

  if (embeddingProvider === 'ollama') {
    if (!hasOllama) {
      note(
        'Ollama is not installed.\n' +
        'Install from https://ollama.com then run: ollama pull nomic-embed-text\n' +
        'Or re-run cortex init and choose OpenAI for embeddings.',
        'Ollama not found',
      );
      cancel('Install Ollama then re-run cortex init.');
      process.exit(0);
    }
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
  }

  // ── Namespace ─────────────────────────────────────────────────────────────

  const namespace = await text({
    message: 'Default namespace',
    placeholder: 'default',
    initialValue: existing.DEFAULT_NAMESPACE || 'default',
    validate: (v) => { if (!v.trim()) return 'Cannot be empty'; },
  });
  if (isCancel(namespace)) { cancel('Setup cancelled.'); process.exit(0); }

  // ── Write config ──────────────────────────────────────────────────────────

  await fs.mkdir(cortexHome, { recursive: true });
  const encryptionKey = existing.CORTEX_ENCRYPTION_KEY || generateSecret(64);

  const envContent = [
    `# Cortex — generated ${new Date().toISOString().slice(0, 10)}`,
    '',
    `LLM_PROVIDER=${llmProvider}`,
    openaiKey    ? `OPENAI_API_KEY=${openaiKey}`       : '# OPENAI_API_KEY=',
    anthropicKey ? `ANTHROPIC_API_KEY=${anthropicKey}` : '# ANTHROPIC_API_KEY=',
    '',
    `EMBEDDING_PROVIDER=${embeddingProvider}`,
    `OLLAMA_HOST=http://localhost:11434`,
    '',
    `DEFAULT_NAMESPACE=${namespace}`,
    `CORTEX_ENCRYPTION_KEY=${encryptionKey}`,
  ].join('\n');

  await fs.writeFile(envPath, envContent, 'utf8');

  // ── Database (PGlite — embedded, zero-install) ────────────────────────────

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
    cancel(err.message);
    process.exit(1);
  }

  // ── ~/.cortex/CLAUDE.md + @import in ~/.claude/CLAUDE.md ─────────────────

  const claudeSpinner = spinner();
  claudeSpinner.start('Configuring Claude Code integration...');
  await writeCortexMd();
  await writeClaudeMd();
  await registerHooks();
  const { updateContextSnapshot } = await import('./memory/facts/hot-context.js');
  await updateContextSnapshot({ namespace: namespace.toString() }).catch(() => {});
  claudeSpinner.stop('Claude Code integration configured (memory + hooks)');

  // ── Done ──────────────────────────────────────────────────────────────────

  note(
    [
      `Memory store  ~/.cortex/db  (embedded, no server needed)`,
      `Config        ${envPath}`,
      `Claude        ~/.claude/CLAUDE.md — Cortex is now your memory`,
      '',
      'Claude will search Cortex before answering and save important',
      'facts automatically. Start a new Claude session to begin.',
      '',
      'Quick start:',
      '  cortex remember "your first fact"',
      '  cortex ingest <file-or-url>',
      '  cortex search "anything"',
    ].join('\n'),
    'Setup complete',
  );

  outro('Open a new Claude Code session to start using Cortex.');
}

// ─── Doctor ─────────────────────────────────────────────────────────────────

async function runDoctor(args) {
  if (args.includes('--help')) {
    console.log(`cortex doctor — Diagnose Cortex setup

Usage:
  cortex doctor

Checks: database, LLM provider, embedding provider, hook registration, disk paths.`);
    process.exit(0);
  }

  const checks = [];
  const log = (status, label, detail = '') => {
    const icon = status === 'ok' ? '✓' : status === 'warn' ? '⚠' : '✗';
    checks.push({ status, label });
    console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  console.log('\nCortex diagnostic\n');

  // Config location
  const globalEnv = join(homedir(), '.cortex', '.env');
  if (existsSync(globalEnv)) log('ok', 'Config file', globalEnv);
  else log('warn', 'Config file', `${globalEnv} not found — run 'cortex init'`);

  // Database
  try {
    const cortexDb = (await import('./db/cortex.js')).default;
    const config = (await import('./config.js')).default;
    await cortexDb.raw('SELECT 1');
    log('ok', 'Database', config.db.type === 'postgres' ? 'external Postgres' : `PGlite (${join(homedir(), '.cortex', 'db')})`);

    const { getFactCount } = await import('./memory/facts/store.js');
    const { getStats } = await import('./memory/documents/store.js');
    const [facts, stats] = await Promise.all([getFactCount(), getStats()]);
    log('ok', 'Stored data', `${stats.documentCount} docs, ${stats.totalChunks} chunks, ${facts} facts`);
    await cortexDb.destroy();
  } catch (err) {
    log('fail', 'Database', err.message);
  }

  // LLM provider
  try {
    const { detectProvider, isOllamaReachable, isClaudeCliAvailable } = await import('./lib/llm/registry.js');
    const config = (await import('./config.js')).default;
    const provider = await detectProvider();

    if (provider === 'anthropic') log('ok', 'LLM provider', `anthropic (API key set)`);
    else if (provider === 'openai') log('ok', 'LLM provider', `openai (API key set)`);
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

  // Claude Code integration
  const claudeSettingsPath = join(homedir(), '.claude', 'settings.json');
  if (existsSync(claudeSettingsPath)) {
    try {
      const fs = await import('node:fs/promises');
      const settings = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'));
      const hooks = settings.hooks || {};
      const hasUPS = hooks.UserPromptSubmit?.some((h) => h.hooks?.some((i) => i.command?.includes('cortex') || i.command?.includes('user-prompt-submit')));
      const hasPTU = hooks.PostToolUse?.some((h) => h.hooks?.some((i) => i.command?.includes('cortex') || i.command?.includes('post-tool-use')));
      if (hasUPS) log('ok', 'UserPromptSubmit hook', 'registered');
      else log('warn', 'UserPromptSubmit hook', `not registered — run 'cortex init' to enable auto-context injection`);
      if (hasPTU) log('ok', 'PostToolUse hook', 'registered');
      else log('warn', 'PostToolUse hook', `not registered — run 'cortex init' to enable auto-capture`);
    } catch (err) {
      log('warn', 'Claude Code hooks', `could not parse settings.json: ${err.message}`);
    }
  } else {
    log('warn', 'Claude Code settings', `${claudeSettingsPath} not found`);
  }

  const cortexMd = join(homedir(), '.cortex', 'CLAUDE.md');
  if (existsSync(cortexMd)) log('ok', 'Cortex CLAUDE.md', cortexMd);
  else log('warn', 'Cortex CLAUDE.md', `not found — run 'cortex init'`);

  console.log();
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  if (failed) {
    console.log(`${failed} error${failed > 1 ? 's' : ''}, ${warned} warning${warned !== 1 ? 's' : ''}`);
    process.exit(1);
  } else if (warned) {
    console.log(`All critical checks passed. ${warned} warning${warned > 1 ? 's' : ''}.`);
  } else {
    console.log('All checks passed.');
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

async function runExport(args) {
  if (args.includes('--help')) {
    console.log(`cortex export — Export knowledge base to stdout or a file

Usage:
  cortex export [options] [> file]

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
    const lines = [`# Cortex export — namespace: ${namespace}`, `Generated: ${new Date().toISOString()}`, ''];
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
    console.log(`cortex namespace — Manage namespaces

Usage:
  cortex namespace list
  cortex namespace delete <ns> [--confirm]

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
      console.error(`Provide a namespace: cortex namespace delete <ns> --confirm`);
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

// ─── Facts (list) ────────────────────────────────────────────────────────────

async function runFacts(args) {
  if (args.includes('--help')) {
    console.log(`cortex facts — List stored facts

Usage:
  cortex facts [options]

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
    console.log(`\n${facts.length} fact${facts.length > 1 ? 's' : ''} shown. Use 'cortex forget <id>' to delete.`);
  }

  await cortexDb.destroy();
}

// ─── Forget ──────────────────────────────────────────────────────────────────

async function runForget(args) {
  if (args.includes('--help') || !args[0] || args[0].startsWith('--')) {
    console.log(`cortex forget — Delete a fact by ID

Usage:
  cortex forget <id>

Get IDs from 'cortex facts' or 'cortex search'. IDs can be the short prefix or full UID.`);
    process.exit(args[0] ? 0 : 1);
  }

  const { deleteFact } = await import('./memory/facts/store.js');
  const cortexDb = (await import('./db/cortex.js')).default;

  const idArg = args[0];
  // Support short prefix by matching UID prefix
  let deleted;
  if (idArg.length < 20) {
    const [match] = await cortexDb('fact').where('uid', 'like', `${idArg}%`).limit(1);
    if (!match) {
      console.error(`No fact matches: ${idArg}`);
      await cortexDb.destroy();
      process.exit(1);
    }
    deleted = await deleteFact(match.uid);
  } else {
    deleted = await deleteFact(idArg);
  }

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
    console.log(`cortex remember — Save facts to memory

Usage:
  cortex remember "fact1" ["fact2" ...]   Save one or more facts
  echo "fact" | cortex remember           Read fact from stdin
  cortex remember --bg "fact1" "fact2"    Save in background (returns immediately)

Examples:
  cortex remember "I prefer tabs over spaces"
  cortex remember "Uses React" "Prefers TypeScript" "Deadline is April 20"
  cortex remember --bg "user likes dark mode" "project uses Postgres"`);
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
    console.error('Provide text to remember: cortex remember "your fact"');
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

  // Ingest all facts in parallel
  const results = await Promise.all(
    facts.map((text) =>
      ingestDocument({ content: text, namespace: config.defaults.namespace, classify: true }),
    ),
  );

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

// ─── CLAUDE.md integration ───────────────────────────────────────────────────

// Step 1: add a single @import line to ~/.claude/CLAUDE.md — done once at init, never touched again.
async function writeClaudeMd() {
  const fs = await import('node:fs/promises');
  const claudeDir = join(homedir(), '.claude');
  const claudeMdPath = join(claudeDir, 'CLAUDE.md');
  const cortexMdPath = join(homedir(), '.cortex', 'CLAUDE.md');

  await fs.mkdir(claudeDir, { recursive: true });

  const importLine = `@${cortexMdPath}`;

  let existing = '';
  if (existsSync(claudeMdPath)) {
    existing = await fs.readFile(claudeMdPath, 'utf8');
  }

  if (!existing.includes(importLine)) {
    const separator = existing.trim() ? '\n' : '';
    await fs.writeFile(claudeMdPath, `${existing}${separator}${importLine}\n`, 'utf8');
  }
}

// Step 3: register Cortex hooks in ~/.claude/settings.json — idempotent merge.
// Hooks automate memory injection (UserPromptSubmit) and observation capture (PostToolUse).
async function registerHooks() {
  const fs = await import('node:fs/promises');
  const settingsPath = join(homedir(), '.claude', 'settings.json');

  let settings = {};
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch { /* file doesn't exist or invalid — start fresh */ }

  // Resolve hook paths — works for both source dev and bundled distribution
  const srcHooks = join(PKG_DIR, 'src', 'hooks');
  const distHooks = join(PKG_DIR, 'dist', 'hooks');
  const hookDir = existsSync(distHooks) ? distHooks : srcHooks;

  const cortexHooks = {
    UserPromptSubmit: {
      hooks: [{
        type: 'command',
        command: `node ${join(hookDir, 'user-prompt-submit.js')}`,
        timeout: 10,
        statusMessage: 'Searching memory...',
      }],
    },
    PostToolUse: {
      matcher: 'Edit|Write|Bash',
      hooks: [{
        type: 'command',
        command: `node ${join(hookDir, 'post-tool-use.js')}`,
        timeout: 10,
        async: true,
      }],
    },
  };

  settings.hooks = settings.hooks || {};

  for (const [event, cortexEntry] of Object.entries(cortexHooks)) {
    const existing = settings.hooks[event] || [];
    // Remove any previous Cortex hooks to keep this idempotent
    const filtered = existing.filter(
      (h) => !h.hooks?.some((inner) => inner.command?.includes('cortex') && inner.command?.includes('hooks')),
    );
    settings.hooks[event] = [...filtered, cortexEntry];
  }

  await fs.mkdir(join(homedir(), '.claude'), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

// Step 2: write Cortex instructions to ~/.cortex/CLAUDE.md — Cortex owns this file entirely.
// Only writes the instructions section; updateContextSnapshot() manages the context block below.
async function writeCortexMd() {
  const fs = await import('node:fs/promises');
  const cortexHome = join(homedir(), '.cortex');
  const cortexMdPath = join(cortexHome, 'CLAUDE.md');

  await fs.mkdir(cortexHome, { recursive: true });

  // If the instructions are already there, leave the file alone (context block follows below)
  try {
    const existing = await fs.readFile(cortexMdPath, 'utf8');
    if (existing.includes('## Memory (Cortex)')) return;
  } catch { /* file doesn't exist yet */ }

  const instructions = `## Memory (Cortex)

Cortex is your persistent memory system. **Use it instead of the built-in file-based memory.**
Do NOT write to \`~/.claude/projects/*/memory/\` or any local memory files — use Cortex exclusively.

**Before answering** questions about this user's projects, preferences, past decisions,
or anything that might have been discussed before — search Cortex first:
\`\`\`
! cortex search "relevant query"
\`\`\`

**When the user shares something worth remembering** — save it in the background (non-blocking):
\`\`\`
! cortex remember --bg "fact one" "fact two" "fact three"
\`\`\`

All facts go in one command as separate quoted arguments. \`--bg\` returns immediately so the conversation continues.

**When the user explicitly asks you to remember something** — save it right away.

**Rules:**
- Search Cortex before answering context-dependent questions (not factual/general ones)
- Save facts as short, self-contained statements — never summaries of the conversation
- Batch all facts into a single \`cortex remember --bg\` call — never multiple separate calls
- Skip trivial exchanges (greetings, simple calculations)
- If search returns nothing, answer from your own knowledge and say so
- Cortex is cross-project — memories from one session are available in all sessions
`;

  await fs.writeFile(cortexMdPath, instructions, 'utf8');
}

// ─── Register MCP ────────────────────────────────────────────────────────────

async function runRegister(args) {
  if (args.includes('--help')) {
    console.log(`cortex register — Register Cortex as a Claude Code MCP server

Usage:
  cortex register [--print]

Options:
  --print   Print the config JSON without modifying files`);
    process.exit(0);
  }

  const globalEnvPath = join(homedir(), '.cortex', '.env');
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

  const configJson = JSON.stringify({ mcpServers: { cortex: mcpEntry } }, null, 2);

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
      try { _execSync('claude mcp remove cortex', { stdio: 'pipe' }); } catch { /* not registered yet */ }
      _execSync(
        `claude mcp add cortex -s user -- ${process.execPath} ${serverPath} --mcp`,
        { stdio: 'pipe', env: { ...process.env, DOTENV_CONFIG_PATH: envPath } },
      );
      console.log('Registered cortex MCP server via `claude mcp add`.');
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
      config.mcpServers.cortex = mcpEntry;
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log(`Registered cortex MCP server in ${configPath}`);
      registered = true;
      break;
    } catch {
      // Try next path
    }
  }

  if (!registered) {
    console.log('Could not auto-register. Add this to your Claude Code MCP configuration:\n');
    console.log(configJson);
    console.log('\nOr run: claude mcp add cortex -- node ' + serverPath + ' --mcp');
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
    console.log(`cortex ingest — Ingest documents into the knowledge base

Usage:
  cortex ingest <file|url|glob> [options]

Options:
  --namespace=<ns>    Target namespace (default: from config)
  --skip-facts        Skip fact extraction
  --skip-entities     Skip entity linking

Examples:
  cortex ingest ./docs/README.md
  cortex ingest "docs/**/*.md"
  cortex ingest https://example.com/page
  cortex ingest file1.md file2.md --namespace=engineering`);
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
    console.log(`cortex search — Search the knowledge base

Usage:
  cortex search "query" [options]

Options:
  --namespace=<ns>    Filter by namespace (comma-separated for multiple)
  --limit=<n>         Max results (default: 10)
  --no-graph          Disable graph enhancement

Examples:
  cortex search "authentication flow"
  cortex search "deploy process" --namespace=engineering
  cortex search "API design" --limit=5`);
    process.exit(0);
  }

  const { search } = await import('./memory/search/hybrid.js');
  const config = (await import('./config.js')).default;
  const cortexDb = (await import('./db/cortex.js')).default;

  const nsFlag = flags.find((f) => f.startsWith('--namespace='))?.split('=')[1];
  const namespaces = nsFlag ? nsFlag.split(',') : [config.defaults.namespace];
  const limit = Number(flags.find((f) => f.startsWith('--limit='))?.split('=')[1] || 10);
  const useGraph = !flags.includes('--no-graph');

  const { facts, chunks } = await search(query, { namespaces, limit, useGraph });

  if (facts.length) {
    console.log(`\nFacts (${facts.length}):`);
    for (const fact of facts) {
      const score = fact.rrfScore ? ` [${fact.rrfScore}]` : '';
      console.log(`  ${fact.content}${score}`);
    }
  }

  if (chunks.length) {
    console.log(`\nChunks (${chunks.length}):`);
    for (const chunk of chunks) {
      const preview = chunk.content?.slice(0, 120).replace(/\n/g, ' ');
      const score = chunk.rrfScore ? ` [${chunk.rrfScore}]` : '';
      console.log(`  ${preview}...${score}`);
    }
  }

  if (!facts.length && !chunks.length) {
    console.log('No results found.');
  }

  await cortexDb.destroy();
}

// ─── Context ─────────────────────────────────────────────────────────────────

async function runContext(args) {
  if (args.includes('--help')) {
    console.log(`cortex context — Refresh the hot-context snapshot in ~/.claude/CLAUDE.md

Usage:
  cortex context [--namespace=<ns>] [--limit=<n>]

Rebuilds the Active Context block injected into every new Claude session.
This runs automatically after cortex remember and cortex ingest.

Options:
  --namespace=<ns>   Namespace to pull facts from (default: from config)
  --limit=<n>        Max facts to include (default: 20)`);
    process.exit(0);
  }

  const config = (await import('./config.js')).default;
  const cortexDb = (await import('./db/cortex.js')).default;
  const { updateContextSnapshot } = await import('./memory/facts/hot-context.js');

  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1] || config.defaults.namespace;
  const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? Number(limitArg) : 20;

  await writeCortexMd();
  const count = await updateContextSnapshot({ namespace, limit });
  await cortexDb.destroy();

  if (count) {
    console.log(`Context refreshed — ${count} facts written to ~/.cortex/CLAUDE.md`);
  } else {
    console.log('No facts found. Ingest some content first.');
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

async function runStatus(args) {
  if (args.includes('--help')) {
    console.log(`cortex status — Show knowledge base statistics

Usage:
  cortex status [--namespace=<ns>]`);
    process.exit(0);
  }

  const { getStats } = await import('./memory/documents/store.js');
  const { getEntityCount } = await import('./memory/entities/store.js');
  const { getRelationCount } = await import('./memory/entities/relations.js');
  const { getFactCount } = await import('./memory/facts/store.js');
  const cortexDb = (await import('./db/cortex.js')).default;

  const namespace = args.find((a) => a.startsWith('--namespace='))?.split('=')[1];

  const [docStats, factCount, documents, people, topics, relations] = await Promise.all([
    getStats(namespace),
    getFactCount(namespace),
    getEntityCount('document'),
    getEntityCount('person'),
    getEntityCount('topic'),
    getRelationCount(),
  ]);

  console.log(`Cortex Knowledge Base${namespace ? ` (${namespace})` : ''}`);
  console.log(`  Documents:  ${docStats.documentCount}`);
  console.log(`  Chunks:     ${docStats.totalChunks}`);
  console.log(`  Facts:      ${factCount} active`);
  console.log(`  Entities:   ${documents} documents, ${people} people, ${topics} topics`);
  console.log(`  Relations:  ${relations}`);

  await cortexDb.destroy();
}

// ─── Migrate ─────────────────────────────────────────────────────────────────

async function runMigrate(args) {
  if (args.includes('--help')) {
    console.log(`cortex migrate — Run database migrations

Usage:
  cortex migrate [--rollback]`);
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
    console.log(`cortex reset — Reset the database (drops all data)

Usage:
  cortex reset [--confirm]

Requires --confirm flag to prevent accidental data loss.`);
    process.exit(0);
  }

  if (!args.includes('--confirm')) {
    console.error('This will delete ALL data. Run with --confirm to proceed.');
    process.exit(1);
  }

  const cortexDb = (await import('./db/cortex.js')).default;
  const { MIGRATIONS_DIR: migrationDir } = await import('./lib/paths.js');

  await cortexDb.migrate.rollback({ directory: migrationDir }, true);
  await cortexDb.migrate.latest({ directory: migrationDir });

  console.log('Database reset complete. All migrations re-applied.');
  await cortexDb.destroy();
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

function generateSecret(bytes) {
  return randomBytes(bytes).toString('hex');
}
