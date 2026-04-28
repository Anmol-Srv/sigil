#!/usr/bin/env node

/**
 * PostToolUse hook — captures observations from Claude's tool usage.
 *
 * Two-tier noise filtering + secret masking + session-level dedup.
 * Stores lightweight observations directly as facts (no LLM calls).
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';

import { maskSecrets } from './secret-mask.js';

// Load env before anything else
const home = process.env.HOME || process.env.USERPROFILE;
const globalEnv = join(home, '.cortex', '.env');
const localEnv = resolve(process.cwd(), '.env');
if (existsSync(localEnv)) dotenvConfig({ path: localEnv, quiet: true });
else if (existsSync(globalEnv)) dotenvConfig({ path: globalEnv, quiet: true });

// Tools that are reconnaissance, not action — always skip
const ALWAYS_SKIP_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput',
  'ToolSearch', 'Skill', 'Agent',
]);

// Bash subcommands — noise vs signal
const NOISE_BASH = new Set([
  'ls', 'pwd', 'cd', 'cat', 'head', 'tail', 'wc', 'echo', 'date', 'whoami',
  'which', 'type', 'clear', 'history', 'find', 'grep', 'rg', 'file', 'stat',
  'diff', 'man', 'cortex', 'vitest',
]);

const GIT_SIGNAL_SUBCOMMANDS = new Set([
  'commit', 'push', 'merge', 'rebase', 'tag', 'release', 'reset', 'revert',
  'cherry-pick',
]);

const GIT_NOISE_SUBCOMMANDS = new Set([
  'add', 'status', 'diff', 'log', 'show', 'branch', 'checkout', 'switch',
  'fetch', 'pull', 'stash', 'blame', 'config',
]);

// Keywords that make a routine Bash command worth capturing
const SIGNAL_KEYWORDS = [
  'error', 'fail', 'fix', 'decided', 'refactor', 'migrate',
  'deploy', 'docker', 'kubernetes', 'kubectl', 'k8s',
  'pip install', 'npm install', 'yarn add', 'pnpm add', 'brew install', 'apt install',
  'rm -rf', 'sudo', 'systemctl', 'launchctl',
];

// Session-level dedup: (tool, target) → timestamp
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const DEDUP_FILE = join(home, '.cortex', '.hook-dedup.json');

function loadDedup() {
  try {
    const data = JSON.parse(readFileSync(DEDUP_FILE, 'utf8'));
    const now = Date.now();
    // Prune stale entries on load
    for (const key of Object.keys(data)) {
      if (now - data[key] > DEDUP_WINDOW_MS) delete data[key];
    }
    return data;
  } catch { return {}; }
}

function saveDedup(map) {
  try {
    mkdirSync(dirname(DEDUP_FILE), { recursive: true });
    writeFileSync(DEDUP_FILE, JSON.stringify(map), 'utf8');
  } catch { /* best-effort */ }
}

function isDuplicate(key) {
  const map = loadDedup();
  const last = map[key];
  const now = Date.now();
  if (last && now - last < DEDUP_WINDOW_MS) {
    map[key] = now;
    saveDedup(map);
    return true;
  }
  map[key] = now;
  saveDedup(map);
  return false;
}

function bashCommandWord(cmd) {
  // Strip leading env vars: FOO=bar BAZ=qux cmd ...
  const stripped = cmd.replace(/^(\w+=\S+\s+)+/, '');
  const first = stripped.trim().split(/\s+/)[0] || '';
  return first.split('/').pop(); // "/usr/bin/git" → "git"
}

function summarize(toolName, toolInput) {
  // Reconnaissance tools — always skip
  if (ALWAYS_SKIP_TOOLS.has(toolName)) return null;

  if (toolName === 'Edit' || toolName === 'Write') {
    const file = toolInput.file_path || 'unknown file';
    const action = toolName === 'Write' ? 'Created' : 'Edited';
    return { content: `${action} ${file}`, dedupKey: `${toolName}:${file}` };
  }

  if (toolName === 'NotebookEdit') {
    const file = toolInput.notebook_path || 'unknown notebook';
    return { content: `Edited notebook ${file}`, dedupKey: `NotebookEdit:${file}` };
  }

  if (toolName === 'Bash') {
    const cmd = (toolInput.command || '').trim();
    if (!cmd) return null;

    const word = bashCommandWord(cmd);

    // Noise — skip
    if (NOISE_BASH.has(word)) return null;

    // Git / gh — check subcommand
    if (word === 'git' || word === 'gh') {
      const sub = cmd.replace(/^(git|gh)\s+/, '').split(/\s+/)[0];
      if (GIT_NOISE_SUBCOMMANDS.has(sub)) return null;
      if (GIT_SIGNAL_SUBCOMMANDS.has(sub)) {
        const shortCmd = cmd.slice(0, 200);
        return { content: `Ran: ${shortCmd}`, dedupKey: `Bash:${word} ${sub}` };
      }
      // Unknown subcommand — fall through to signal-keyword gate
    }

    // npm/pnpm/yarn install is signal; test/run is noise
    if (['npm', 'pnpm', 'yarn'].includes(word)) {
      const sub = cmd.replace(/^\S+\s+/, '').split(/\s+/)[0];
      if (['test', 'run', 'start', 'lint'].includes(sub)) return null;
    }

    // Signal-keyword gate for everything else
    const lower = cmd.toLowerCase();
    const hasSignal = SIGNAL_KEYWORDS.some((kw) => lower.includes(kw));
    if (!hasSignal) return null;

    const shortCmd = cmd.slice(0, 200);
    return { content: `Ran: ${shortCmd}`, dedupKey: `Bash:${word}:${createHash('md5').update(cmd).digest('hex').slice(0, 8)}` };
  }

  return null;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return respond();

  const input = JSON.parse(raw);
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  const summary = summarize(toolName, toolInput);
  if (!summary) return respond();

  // Dedup against recent same-action events
  if (isDuplicate(summary.dedupKey)) return respond();

  // Mask secrets before storing
  const masked = maskSecrets(summary.content);

  try {
    const { saveFact } = await import('../memory/facts/store.js');
    const { embed } = await import('../ingestion/embedder.js');
    const config = (await import('../config.js')).default;

    const embedding = await embed(masked);

    await saveFact({
      content: masked,
      category: 'observation',
      confidence: 'medium',
      importance: 'supplementary',
      namespace: config.defaults.namespace,
      sourceDocumentIds: [],
      sourceSection: 'session',
      embedding,
    });

    const cortexDb = (await import('../db/cortex.js')).default;
    await cortexDb.destroy();
  } catch (err) {
    process.stderr.write(`[cortex:post-tool-use] ${err.message}\n`);
    try {
      const cortexDb = (await import('../db/cortex.js')).default;
      await cortexDb.destroy();
    } catch { /* ignore */ }
  }

  return respond();
}

function respond() {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
    },
  };
  process.stdout.write(JSON.stringify(output));
}

main();
