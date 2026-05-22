/**
 * Cursor client integration.
 *
 * Cursor has no Claude-Code-style hook system, so memory auto-injection
 * isn't available. The next-best surface is:
 *
 *   1. ~/.cursor/mcp.json              — registers Sigil's MCP server so the
 *                                         agent can call `search` and `remember`
 *                                         as tools
 *   2. ~/.cursor/rules/sigil.mdc       — global Cursor rule, always applied,
 *                                         telling the agent to consult Sigil
 *                                         before answering and to save in batches
 *
 * Without (2), Cursor users would have to manually ask the agent to search
 * memory every turn. With it, the agent is told (via system prompt) to call
 * sigil's MCP tools proactively — closing most of the UX gap vs. Claude Code's
 * UserPromptSubmit hook.
 *
 * Idempotent: re-running detects prior sigil entries in mcp.json and replaces
 * them in place; rules file is rewritten with safeWrite's backup behavior.
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { safeWrite } from '../safe-write.js';
import { buildSharedInstructions } from './instructions.js';

const CURSOR_HOME = join(homedir(), '.cursor');
const CURSOR_MCP_PATH = join(CURSOR_HOME, 'mcp.json');
const CURSOR_RULES_PATH = join(CURSOR_HOME, 'rules', 'sigil.mdc');
const SIGIL_HOME = join(homedir(), '.sigil');
const SIGIL_ENV_PATH = join(SIGIL_HOME, '.env');

// Package root — same trick claude-code.js uses to find dist/ vs src/.
const PKG_DIR = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const meta = {
  id: 'cursor',
  label: 'Cursor',
  hint: 'global MCP + always-applied rule (no native hooks)',
};

async function detect() {
  return existsSync(CURSOR_HOME);
}

// Pick the MCP server file Cursor should spawn. dist/server.js if the
// package was built (real installs); src/server.js otherwise (dev).
function resolveServerPath() {
  const distServer = join(PKG_DIR, 'dist', 'server.js');
  const srcServer = join(PKG_DIR, 'src', 'server.js');
  return existsSync(distServer) ? distServer : srcServer;
}

// Merge the sigil entry into ~/.cursor/mcp.json. Preserves any other MCP
// servers the user has configured; replaces a stale sigil entry if present.
async function writeMcpEntry({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  let config = {};
  try {
    const raw = await fs.readFile(CURSOR_MCP_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch { /* file doesn't exist or invalid — start fresh */ }

  const existedBefore = existsSync(CURSOR_MCP_PATH);
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.sigil = {
    command: process.execPath,
    args: [resolveServerPath(), '--mcp'],
    env: { DOTENV_CONFIG_PATH: SIGIL_ENV_PATH },
  };

  if (!dryRun) await fs.mkdir(CURSOR_HOME, { recursive: true });
  const result = await safeWrite(CURSOR_MCP_PATH, JSON.stringify(config, null, 2), { dryRun });
  return {
    action: result.action,
    path: CURSOR_MCP_PATH,
    detail: existedBefore
      ? '+sigil MCP server (other entries preserved)'
      : 'new mcp.json with sigil entry',
  };
}

// Build the .mdc body: YAML frontmatter + shared instructions text.
//
// Cursor reads frontmatter to decide whether a rule auto-applies. We set
// `alwaysApply: true` so these instructions surface on every prompt —
// the closest equivalent to Claude Code's @import behavior.
function buildRulesFile() {
  const frontmatter = [
    '---',
    'description: Sigil persistent memory — consult before answering, save in batches',
    'alwaysApply: true',
    '---',
    '',
  ].join('\n');
  return frontmatter + buildSharedInstructions();
}

async function writeRulesFile({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  if (!dryRun) await fs.mkdir(dirname(CURSOR_RULES_PATH), { recursive: true });
  const result = await safeWrite(CURSOR_RULES_PATH, buildRulesFile(), { dryRun });
  return {
    action: result.action,
    path: CURSOR_RULES_PATH,
    detail: `${result.bytes ?? 0} bytes, alwaysApply=true`,
  };
}

async function install({ dryRun = false } = {}) {
  const actions = [];

  const mcp = await writeMcpEntry({ dryRun });
  if (mcp) actions.push(mcp);

  const rules = await writeRulesFile({ dryRun });
  if (rules) actions.push(rules);

  return { actions };
}

async function verify() {
  const fs = await import('node:fs/promises');

  if (!existsSync(CURSOR_MCP_PATH)) {
    return { installed: false, reason: '~/.cursor/mcp.json missing' };
  }
  let config;
  try {
    config = JSON.parse(await fs.readFile(CURSOR_MCP_PATH, 'utf8'));
  } catch {
    return { installed: false, reason: '~/.cursor/mcp.json is not valid JSON' };
  }
  if (!config.mcpServers?.sigil) {
    return { installed: false, reason: 'sigil entry missing from ~/.cursor/mcp.json' };
  }

  if (!existsSync(CURSOR_RULES_PATH)) {
    return { installed: false, reason: '~/.cursor/rules/sigil.mdc missing' };
  }

  return { installed: true };
}

async function uninstall({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  const actions = [];

  // Remove sigil entry from mcp.json, preserve other servers
  if (existsSync(CURSOR_MCP_PATH)) {
    let config;
    try {
      config = JSON.parse(await fs.readFile(CURSOR_MCP_PATH, 'utf8'));
    } catch {
      actions.push({ action: 'skip', path: CURSOR_MCP_PATH, detail: 'invalid JSON — not touched' });
      return { actions };
    }
    if (config.mcpServers?.sigil) {
      delete config.mcpServers.sigil;
      const result = await safeWrite(CURSOR_MCP_PATH, JSON.stringify(config, null, 2), { dryRun });
      actions.push({ action: result.action, path: CURSOR_MCP_PATH, detail: '-sigil MCP entry' });
    } else {
      actions.push({ action: 'skip', path: CURSOR_MCP_PATH, detail: 'sigil entry not present' });
    }
  }

  // Delete the rules file outright — we own this file (no other tool writes here)
  if (existsSync(CURSOR_RULES_PATH)) {
    if (!dryRun) await fs.unlink(CURSOR_RULES_PATH);
    actions.push({ action: 'delete', path: CURSOR_RULES_PATH, detail: 'sigil rules file removed' });
  }

  return { actions };
}

export {
  meta,
  detect,
  install,
  uninstall,
  verify,
  // Exposed for low-level callers (uninstall, tests).
  writeMcpEntry,
  writeRulesFile,
  resolveServerPath,
};
