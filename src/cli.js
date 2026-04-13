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
  init                     Set up Cortex (DB, env, migrations, Claude integration)
  remember "text"          Save a fact or note to memory
  ingest <file|url|glob>   Ingest documents into the knowledge base
  search "query"           Search the knowledge base
  context                  Refresh the hot-context snapshot in ~/.claude/CLAUDE.md
  status                   Show knowledge base statistics
  migrate                  Run database migrations
  reset                    Reset the database (drops all data)
  keys                     Manage REST API keys
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
  remember: runRemember,
  ingest: runIngest,
  search: runSearch,
  context: runContext,
  status: runStatus,
  migrate: runMigrate,
  reset: runReset,
  keys: runKeys,
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
      { value: 'openai',    label: 'OpenAI',    hint: 'gpt-4o-mini — recommended' },
      { value: 'anthropic', label: 'Anthropic', hint: 'Claude Haiku' },
      { value: 'ollama',    label: 'Ollama',    hint: 'local models — no API cost' },
    ],
    initialValue: existing.LLM_PROVIDER || 'openai',
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
    const migrationDir = join(PKG_DIR, 'src', 'db', 'migrations');
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
  claudeSpinner.start('Configuring Claude Code memory...');
  await writeCortexMd();                  // write instructions to ~/.cortex/CLAUDE.md
  await writeClaudeMd();                  // add single @import line to ~/.claude/CLAUDE.md
  const { updateContextSnapshot } = await import('./memory/facts/hot-context.js');
  await updateContextSnapshot({ namespace: namespace.toString() }).catch(() => {});
  claudeSpinner.stop('Claude memory configured');

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
          console.log(`No files matched: ${input}`);
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
  const migrationDir = join(PKG_DIR, 'src', 'db', 'migrations');

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
  const migrationDir = join(PKG_DIR, 'src', 'db', 'migrations');

  await cortexDb.migrate.rollback({ directory: migrationDir }, true);
  await cortexDb.migrate.latest({ directory: migrationDir });

  console.log('Database reset complete. All migrations re-applied.');
  await cortexDb.destroy();
}

// ─── Keys ────────────────────────────────────────────────────────────────────

async function runKeys(args) {
  const subcommand = args[0];

  if (!subcommand || args.includes('--help')) {
    console.log(`cortex keys — Manage REST API keys

Usage:
  cortex keys list
  cortex keys create --name=<name>
  cortex keys revoke <key-prefix>`);
    process.exit(0);
  }

  let auth;
  try {
    auth = await import('./api/auth.js');
  } catch {
    console.error('API key management is not available yet.');
    process.exit(1);
  }
  const { listApiKeys, createApiKey, revokeApiKey } = auth;
  const cortexDb = (await import('./db/cortex.js')).default;

  if (subcommand === 'list') {
    const keys = await listApiKeys();
    if (!keys.length) {
      console.log('No API keys.');
    } else {
      for (const k of keys) {
        console.log(`  ${k.name} — ${k.prefix}*** (created ${k.createdAt?.toISOString?.().slice(0, 10) ?? 'unknown'})`);
      }
    }
  } else if (subcommand === 'create') {
    const name = args.find((a) => a.startsWith('--name='))?.split('=')[1] || 'default';
    const { key, record } = await createApiKey(name);
    console.log(`Created: ${key}`);
    console.log(`(Store this — it won't be shown again)`);
  } else if (subcommand === 'revoke') {
    const prefix = args[1];
    if (!prefix) { console.error('Provide a key prefix to revoke.'); process.exit(1); }
    await revokeApiKey(prefix);
    console.log(`Revoked key starting with: ${prefix}`);
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
  }

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
