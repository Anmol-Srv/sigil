/**
 * Codex CLI client integration.
 *
 * Codex CLI uses TOML for its config and a markdown rules file:
 *   1. ~/.codex/config.toml      — MCP server registration under
 *                                   [mcp_servers.sigil]
 *   2. ~/.codex/AGENTS.md        — agent rules (community-shared format —
 *                                   Aider and others also read AGENTS.md)
 *
 * Two design constraints:
 *
 *   - TOML, not JSON. Parsed via @iarna/toml so user-added comments and
 *     ordering survive round-trips for the keys we don't touch.
 *
 *   - AGENTS.md may already contain the user's own rules (or rules from
 *     other tools). We never overwrite — we maintain a marker-delimited
 *     `<!-- BEGIN sigil -->...<!-- END sigil -->` block, replacing it on
 *     re-run and leaving everything outside the markers untouched.
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import TOML from '@iarna/toml';

import { safeWrite } from '../safe-write.js';
import { buildSharedInstructions } from './instructions.js';

const CODEX_HOME = join(homedir(), '.codex');
const CODEX_CONFIG_PATH = join(CODEX_HOME, 'config.toml');
const CODEX_AGENTS_PATH = join(CODEX_HOME, 'AGENTS.md');
const SIGIL_ENV_PATH = join(homedir(), '.sigil', '.env');

// Package root — same trick the other client modules use to find dist/ vs src/.
const PKG_DIR = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const BEGIN_MARKER = '<!-- BEGIN sigil -->';
const END_MARKER = '<!-- END sigil -->';

const meta = {
  id: 'codex-cli',
  label: 'Codex CLI',
  hint: 'TOML config + AGENTS.md (no native hooks)',
};

async function detect() {
  return existsSync(CODEX_HOME);
}

function resolveServerPath() {
  const distServer = join(PKG_DIR, 'dist', 'server.js');
  const srcServer = join(PKG_DIR, 'src', 'server.js');
  return existsSync(distServer) ? distServer : srcServer;
}

// Read existing TOML if present, set mcp_servers.sigil, write back.
// @iarna/toml preserves the keys we don't touch on round-trip; ordering of
// untouched top-level tables is the only thing that may shift.
async function writeMcpEntry({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  let config = {};
  try {
    const raw = await fs.readFile(CODEX_CONFIG_PATH, 'utf8');
    config = TOML.parse(raw);
  } catch { /* file doesn't exist or invalid — start fresh */ }

  const existedBefore = existsSync(CODEX_CONFIG_PATH);

  config.mcp_servers = config.mcp_servers || {};
  config.mcp_servers.sigil = {
    command: process.execPath,
    args: [resolveServerPath(), '--mcp'],
    env: { DOTENV_CONFIG_PATH: SIGIL_ENV_PATH },
  };

  if (!dryRun) await fs.mkdir(CODEX_HOME, { recursive: true });
  const result = await safeWrite(CODEX_CONFIG_PATH, TOML.stringify(config), { dryRun });
  return {
    action: result.action,
    path: CODEX_CONFIG_PATH,
    detail: existedBefore
      ? '+[mcp_servers.sigil] (other keys preserved)'
      : 'new config.toml with sigil MCP entry',
  };
}

// Build the marker-delimited block we own inside AGENTS.md.
function buildSigilBlock() {
  return [
    BEGIN_MARKER,
    buildSharedInstructions(),
    END_MARKER,
  ].join('\n');
}

// Splice the sigil block into AGENTS.md without touching anything outside
// the BEGIN/END markers. New file → write the block alone. Existing block →
// replace in place. No prior block → append at the end.
async function writeAgentsFile({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  if (!dryRun) await fs.mkdir(CODEX_HOME, { recursive: true });

  let existing = '';
  if (existsSync(CODEX_AGENTS_PATH)) {
    existing = await fs.readFile(CODEX_AGENTS_PATH, 'utf8');
  }

  const block = buildSigilBlock();
  let next;
  let detail;

  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    // Replace the existing block — keeps everything outside markers intact.
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + END_MARKER.length);
    next = `${before}${block}${after}`;
    detail = 'sigil block replaced (other content preserved)';
  } else if (!existing.trim()) {
    next = `${block}\n`;
    detail = 'new AGENTS.md with sigil block';
  } else {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    next = `${existing}${separator}${block}\n`;
    detail = 'appended sigil block (existing content preserved)';
  }

  if (next === existing) {
    return { action: 'skip', path: CODEX_AGENTS_PATH, detail: 'block already up to date' };
  }

  const result = await safeWrite(CODEX_AGENTS_PATH, next, { dryRun });
  return { action: result.action, path: CODEX_AGENTS_PATH, detail };
}

async function install({ dryRun = false } = {}) {
  const actions = [];

  const mcp = await writeMcpEntry({ dryRun });
  if (mcp) actions.push(mcp);

  const agents = await writeAgentsFile({ dryRun });
  if (agents) actions.push(agents);

  return { actions };
}

async function verify() {
  const fs = await import('node:fs/promises');

  if (!existsSync(CODEX_CONFIG_PATH)) {
    return { installed: false, reason: '~/.codex/config.toml missing' };
  }
  let config;
  try {
    config = TOML.parse(await fs.readFile(CODEX_CONFIG_PATH, 'utf8'));
  } catch (err) {
    return { installed: false, reason: `~/.codex/config.toml unparseable: ${err.message}` };
  }
  if (!config.mcp_servers?.sigil) {
    return { installed: false, reason: '[mcp_servers.sigil] missing from ~/.codex/config.toml' };
  }

  if (!existsSync(CODEX_AGENTS_PATH)) {
    return { installed: false, reason: '~/.codex/AGENTS.md missing' };
  }
  const agents = await fs.readFile(CODEX_AGENTS_PATH, 'utf8');
  if (!agents.includes(BEGIN_MARKER) || !agents.includes(END_MARKER)) {
    return { installed: false, reason: 'sigil block markers missing from ~/.codex/AGENTS.md' };
  }

  return { installed: true };
}

async function uninstall({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  const actions = [];

  // Remove [mcp_servers.sigil] from TOML, preserve other keys
  if (existsSync(CODEX_CONFIG_PATH)) {
    let config;
    try {
      config = TOML.parse(await fs.readFile(CODEX_CONFIG_PATH, 'utf8'));
    } catch (err) {
      actions.push({ action: 'skip', path: CODEX_CONFIG_PATH, detail: `unparseable — not touched: ${err.message}` });
      return { actions };
    }
    if (config.mcp_servers?.sigil) {
      delete config.mcp_servers.sigil;
      // Drop the parent table if we emptied it
      if (Object.keys(config.mcp_servers).length === 0) delete config.mcp_servers;
      const result = await safeWrite(CODEX_CONFIG_PATH, TOML.stringify(config), { dryRun });
      actions.push({ action: result.action, path: CODEX_CONFIG_PATH, detail: '-[mcp_servers.sigil]' });
    } else {
      actions.push({ action: 'skip', path: CODEX_CONFIG_PATH, detail: '[mcp_servers.sigil] not present' });
    }
  }

  // Remove only the marker-delimited block from AGENTS.md, preserve the rest
  if (existsSync(CODEX_AGENTS_PATH)) {
    const before = await fs.readFile(CODEX_AGENTS_PATH, 'utf8');
    const beginIdx = before.indexOf(BEGIN_MARKER);
    const endIdx = before.indexOf(END_MARKER);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const head = before.slice(0, beginIdx).replace(/\n+$/, '');
      const tail = before.slice(endIdx + END_MARKER.length).replace(/^\n+/, '');
      const after = head && tail ? `${head}\n\n${tail}` : (head || tail);
      const result = await safeWrite(CODEX_AGENTS_PATH, after.endsWith('\n') ? after : `${after}\n`, { dryRun });
      actions.push({ action: result.action, path: CODEX_AGENTS_PATH, detail: 'sigil block removed (other content preserved)' });
    } else {
      actions.push({ action: 'skip', path: CODEX_AGENTS_PATH, detail: 'sigil block not present' });
    }
  }

  return { actions };
}

export {
  meta,
  detect,
  install,
  uninstall,
  verify,
  writeMcpEntry,
  writeAgentsFile,
  resolveServerPath,
};
