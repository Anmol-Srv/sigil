/**
 * Codex CLI client integration.
 *
 * Writes three things under $CODEX_HOME (default ~/.codex):
 *   1. hooks.json   — native hooks: SessionStart loads memory, UserPromptSubmit
 *                     recalls per prompt, Stop saves the turn (handed to a
 *                     background process). Same contract as Claude Code's.
 *   2. config.toml  — [mcp_servers.sigil], so the agent can also search and
 *                     save through tools.
 *   3. AGENTS.md    — a marker-delimited instructions block.
 *
 * Codex runs a user hook only after it has been reviewed and trusted in
 * `/hooks`, and trust is tied to the hook's exact command. So the commands are
 * kept stable across reconnects, and `status` reports "approve in /hooks"
 * until a hook has actually run.
 *
 * config.toml is edited as text (toml-table.js): only Sigil's own table
 * changes, so the user's comments and ordering survive.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';

import TOML from '@iarna/toml';

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';
import { buildSharedInstructions } from './instructions.js';
import { HOOK_SHIM_PATH, MCP_SHIM_PATH, writeLauncherShim, resolveServerPath } from './shim.js';
import { readJsonConfig, writeJsonConfig, sigilMcpEntry, stripNestedSigilHooks, isSigilHookCommand } from './config-files.js';
import { upsertTomlTable, deleteTomlTable } from './toml-table.js';

const AGENT = 'codex-cli';
const MCP_TABLE = 'mcp_servers.sigil';

const BEGIN_MARKER = '<!-- BEGIN sigil -->';
const END_MARKER = '<!-- END sigil -->';

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}
const configPath = () => join(codexHome(), 'config.toml');
const agentsPath = () => join(codexHome(), 'AGENTS.md');
const hooksPath = () => join(codexHome(), 'hooks.json');

const meta = {
  id: AGENT,
  label: 'Codex CLI',
  hint: 'native hooks + MCP + AGENTS.md',
  capabilities: { sessionStart: 'auto', recall: 'auto', capture: 'auto', tools: 'mcp' },
  // Shown until a hook has actually run.
  firstRunHint: 'Open Codex and approve Sigil\'s hooks with /hooks',
  requiresRestart: true,
};

async function detect() {
  return detectInstalled({ dirs: [codexHome()], bins: ['codex'] });
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

// Quote the shim path so a home directory with spaces stays one argument.
const hookCommand = (name) => `'${HOOK_SHIM_PATH}' ${name} --agent=${AGENT}`;

function sigilHookGroups() {
  return {
    SessionStart: { hooks: [{ type: 'command', command: hookCommand('session-start'), timeout: 15, statusMessage: 'Loading memory' }] },
    UserPromptSubmit: { hooks: [{ type: 'command', command: hookCommand('user-prompt-submit'), timeout: 10, statusMessage: 'Searching memory' }] },
    // Not `async: true`: `codex exec` never ran an async Stop hook in testing.
    // The hook hands the save to a background process and returns at once.
    Stop: { hooks: [{ type: 'command', command: hookCommand('stop'), timeout: 10 }] },
  };
}
export const CODEX_HOOK_EVENTS = Object.keys(sigilHookGroups());

async function writeHooks({ dryRun = false } = {}) {
  const path = hooksPath();
  const { data, missing, error } = await readJsonConfig(path);
  if (error) return { action: 'skip', path, detail: `${error} — not touched; fix or move it, then re-run` };

  const before = JSON.stringify(data);
  data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  stripNestedSigilHooks(data.hooks);
  for (const [event, group] of Object.entries(sigilHookGroups())) {
    data.hooks[event] = [...(data.hooks[event] || []), group];
  }
  if (JSON.stringify(data) === before) return { action: 'skip', path, detail: 'sigil hooks up to date' };

  const result = await writeJsonConfig(path, data, { dryRun });
  return {
    action: result.action,
    path,
    detail: missing ? 'new hooks.json with sigil hooks' : `+${CODEX_HOOK_EVENTS.join(', +')} hooks (other hooks preserved)`,
  };
}

function findSigilHook(hooks, event) {
  for (const g of hooks?.[event] || []) {
    for (const h of g?.hooks || []) if (isSigilHookCommand(h?.command)) return h.command;
  }
  return null;
}

// ── MCP entry in config.toml ──────────────────────────────────────────────────

async function writeMcpEntry({ dryRun = false } = {}) {
  const path = configPath();
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') return { action: 'skip', path, detail: `could not read (${err.code}) — not touched` };
  }

  await writeLauncherShim({ dryRun });
  let next;
  try {
    next = upsertTomlTable(text, MCP_TABLE, sigilMcpEntry(AGENT));
  } catch (err) {
    return { action: 'skip', path, detail: `invalid TOML — not touched (${err.message.split('\n')[0]})` };
  }
  if (next.text === text) return { action: 'skip', path, detail: '[mcp_servers.sigil] up to date' };

  if (!dryRun) await mkdir(codexHome(), { recursive: true });
  const result = await safeWrite(path, next.text, { dryRun });
  return {
    action: result.action,
    path,
    detail: !text ? 'new config.toml with sigil MCP entry'
      : next.lossless ? '+[mcp_servers.sigil] (rest of file unchanged)'
        : '+[mcp_servers.sigil] (file re-written: comments not kept — a backup is at config.toml.sigil.bak)',
  };
}

// ── AGENTS.md block ───────────────────────────────────────────────────────────

function buildSigilBlock() {
  return [BEGIN_MARKER, buildSharedInstructions({ transport: 'mcp' }), END_MARKER].join('\n');
}

async function writeAgentsFile({ dryRun = false } = {}) {
  const path = agentsPath();
  if (!dryRun) await mkdir(codexHome(), { recursive: true });
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';

  const block = buildSigilBlock();
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);
  let next;
  let detail;
  if (beginIdx !== -1 && endIdx > beginIdx) {
    next = `${existing.slice(0, beginIdx)}${block}${existing.slice(endIdx + END_MARKER.length)}`;
    detail = 'sigil block replaced (other content preserved)';
  } else if (!existing.trim()) {
    next = `${block}\n`;
    detail = 'new AGENTS.md with sigil block';
  } else {
    next = `${existing}${existing.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
    detail = 'appended sigil block (existing content preserved)';
  }
  if (next === existing) return { action: 'skip', path, detail: 'block already up to date' };
  const result = await safeWrite(path, next, { dryRun });
  return { action: result.action, path, detail };
}

// ── Contract ──────────────────────────────────────────────────────────────────

async function install({ dryRun = false } = {}) {
  const actions = [];
  actions.push(await writeMcpEntry({ dryRun }));
  actions.push(await writeHooks({ dryRun }));
  actions.push(await writeAgentsFile({ dryRun }));
  return { actions: actions.filter(Boolean) };
}

/**
 * Is Sigil installed into Codex? `partial` means some of Sigil's entries are
 * there but not all (an older install, or a hand edit) — `sigil connect`
 * repairs it.
 */
async function verify({ deep = false } = {}) {
  const missing = [];
  let anyPresent = false;

  let config = null;
  if (existsSync(configPath())) {
    try {
      config = TOML.parse(await readFile(configPath(), 'utf8'));
    } catch (err) {
      return { installed: false, partial: false, reason: `~/.codex/config.toml unparseable: ${err.message.split('\n')[0]}` };
    }
  }
  if (config?.mcp_servers?.sigil) anyPresent = true;
  else missing.push('MCP entry in config.toml');

  const { data: hooksFile, error: hooksError } = await readJsonConfig(hooksPath());
  if (hooksError) return { installed: false, partial: anyPresent, reason: `~/.codex/hooks.json ${hooksError}` };
  const missingHooks = CODEX_HOOK_EVENTS.filter((e) => !findSigilHook(hooksFile?.hooks, e));
  if (missingHooks.length < CODEX_HOOK_EVENTS.length) anyPresent = true;
  if (missingHooks.length) missing.push(`hooks (${missingHooks.join(', ')})`);

  const agents = existsSync(agentsPath()) ? await readFile(agentsPath(), 'utf8') : '';
  if (agents.includes(BEGIN_MARKER) && agents.includes(END_MARKER)) anyPresent = true;
  else missing.push('instructions block in AGENTS.md');

  if (missing.length) {
    return { installed: false, partial: anyPresent, reason: `missing: ${missing.join('; ')}` };
  }

  for (const shim of [MCP_SHIM_PATH, HOOK_SHIM_PATH]) {
    if (!existsSync(shim)) return { installed: false, partial: true, reason: `launcher missing at ${shim} — run \`sigil connect\`` };
  }
  const serverPath = resolveServerPath();
  if (!existsSync(serverPath)) {
    return { installed: false, partial: true, reason: `MCP server missing at ${serverPath} — run \`sigil connect\`` };
  }
  if (deep) {
    const { verifyMcpRoundTrip } = await import('./roundtrip.js');
    const rt = await verifyMcpRoundTrip(serverPath);
    if (!rt.ok) return { installed: false, partial: true, reason: `MCP round-trip failed: ${rt.reason}` };
  }
  return { installed: true };
}

async function uninstall({ dryRun = false } = {}) {
  const actions = [];

  const cfg = configPath();
  if (existsSync(cfg)) {
    const text = await readFile(cfg, 'utf8');
    try {
      const res = deleteTomlTable(text, MCP_TABLE);
      if (res.removed) {
        const result = await safeWrite(cfg, res.text, { dryRun });
        actions.push({ action: result.action, path: cfg, detail: res.lossless ? '-[mcp_servers.sigil] (rest of file unchanged)' : '-[mcp_servers.sigil] (file re-written)' });
      } else {
        actions.push({ action: 'skip', path: cfg, detail: '[mcp_servers.sigil] not present' });
      }
    } catch (err) {
      actions.push({ action: 'skip', path: cfg, detail: `unparseable — not touched: ${err.message.split('\n')[0]}` });
    }
  }

  const hp = hooksPath();
  if (existsSync(hp)) {
    const { data, error } = await readJsonConfig(hp);
    if (error) {
      actions.push({ action: 'skip', path: hp, detail: `${error} — not touched` });
    } else if (stripNestedSigilHooks(data.hooks || {})) {
      const result = await writeJsonConfig(hp, data, { dryRun });
      actions.push({ action: result.action, path: hp, detail: 'sigil hooks removed (other hooks preserved)' });
    } else {
      actions.push({ action: 'skip', path: hp, detail: 'no sigil hooks to remove' });
    }
  }

  const ap = agentsPath();
  if (existsSync(ap)) {
    const before = await readFile(ap, 'utf8');
    const beginIdx = before.indexOf(BEGIN_MARKER);
    const endIdx = before.indexOf(END_MARKER);
    if (beginIdx !== -1 && endIdx > beginIdx) {
      const head = before.slice(0, beginIdx).replace(/\n+$/, '');
      const tail = before.slice(endIdx + END_MARKER.length).replace(/^\n+/, '');
      const after = head && tail ? `${head}\n\n${tail}` : (head || tail);
      const result = await safeWrite(ap, after.endsWith('\n') || !after ? after : `${after}\n`, { dryRun });
      actions.push({ action: result.action, path: ap, detail: 'sigil block removed (other content preserved)' });
    } else {
      actions.push({ action: 'skip', path: ap, detail: 'sigil block not present' });
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
  writeHooks,
  writeAgentsFile,
  resolveServerPath,
};
