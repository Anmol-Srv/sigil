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
import { PKG_ROOT } from '../paths.js';

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';
import { buildSharedInstructions } from './instructions.js';
import { MCP_SHIM_PATH, writeLauncherShim, resolveServerPath } from './shim.js';

const CURSOR_HOME = join(homedir(), '.cursor');
const CURSOR_MCP_PATH = join(CURSOR_HOME, 'mcp.json');
const CURSOR_RULES_PATH = join(CURSOR_HOME, 'rules', 'sigil.mdc');

// Package root — same trick claude-code.js uses to find dist/ vs src/.
const PKG_DIR = PKG_ROOT; // bundle-safe package root (see claude-code.js)

const meta = {
  id: 'cursor',
  label: 'Cursor',
  hint: 'global MCP + always-applied rule (no native hooks)',
};

async function detect() {
  return detectInstalled({ dirs: [CURSOR_HOME], apps: ['Cursor'], bins: ['cursor'] });
}

// Pick the MCP server file Cursor should spawn. dist/server.js if the
// package was built (real installs); src/server.js otherwise (dev).

// Merge the sigil entry into ~/.cursor/mcp.json. Preserves any other MCP
// servers the user has configured; replaces a stale sigil entry if present.
async function writeMcpEntry({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  let config = {};
  try {
    const raw = await fs.readFile(CURSOR_MCP_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch (err) {
    // ENOENT is fine — a fresh mcp.json is the correct outcome. But a parse
    // error means the file exists with content we can't understand; clobbering
    // it would wipe every other MCP server the user configured. Mirror the
    // uninstall() path and refuse to touch it.
    if (err.code !== 'ENOENT') {
      return {
        action: 'skip',
        path: CURSOR_MCP_PATH,
        detail: `invalid JSON — not touched (${err.message})`,
      };
    }
  }

  const existedBefore = existsSync(CURSOR_MCP_PATH);
  config.mcpServers = config.mcpServers || {};
  // Point `command` at the stable MCP shim (~/.sigil/bin/sigil-mcp), not a
  // baked `node /abs/dist/server.js` — the shim re-resolves the real server at
  // runtime, so a Node-version switch / reinstall can't break this entry.
  // No env block: config.json is the source of truth (the MCP server reads it
  // via getConfig()).
  await writeLauncherShim({ dryRun });
  config.mcpServers.sigil = {
    command: MCP_SHIM_PATH,
    args: [],
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
  return frontmatter + buildSharedInstructions({ transport: 'mcp' });
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

async function verify({ deep = false } = {}) {
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

  // The registered command is the stable shim; it must exist on disk.
  if (!existsSync(MCP_SHIM_PATH)) {
    return { installed: false, reason: `MCP launcher missing at ${MCP_SHIM_PATH} — run \`sigil connect\`` };
  }
  const serverPath = resolveServerPath();
  if (!existsSync(serverPath)) {
    return { installed: false, reason: `MCP server missing at ${serverPath} — run \`sigil connect\` to refresh` };
  }
  if (deep) {
    const { verifyMcpRoundTrip } = await import('./roundtrip.js');
    const rt = await verifyMcpRoundTrip(serverPath);
    if (!rt.ok) return { installed: false, reason: `MCP round-trip failed: ${rt.reason}` };
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
