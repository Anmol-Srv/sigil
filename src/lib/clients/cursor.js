/**
 * Cursor client integration.
 *
 * Writes three things under ~/.cursor:
 *   1. hooks.json        — sessionStart loads memory into the new session,
 *                          beforeSubmitPrompt keeps the prompt, stop saves the
 *                          turn. Cursor's prompt hook can only allow or block, so
 *                          there is no automatic recall per prompt.
 *   2. mcp.json          — Sigil's MCP server, for recall during a session (the
 *                          `search` tool) and explicit saves.
 *   3. rules/sigil.mdc   — an always-applied rule telling the agent to search
 *                          memory before answering.
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';
import { buildSharedInstructions } from './instructions.js';
import { HOOK_SHIM_PATH, MCP_SHIM_PATH, writeLauncherShim, resolveServerPath } from './shim.js';
import {
  readJsonConfig, writeJsonConfig, upsertJsonMcpServer, removeJsonMcpServer, hasJsonMcpServer,
  stripFlatSigilHooks, isSigilHookCommand,
} from './config-files.js';

const AGENT = 'cursor';
const CURSOR_HOME = join(homedir(), '.cursor');
const CURSOR_MCP_PATH = join(CURSOR_HOME, 'mcp.json');
const CURSOR_HOOKS_PATH = join(CURSOR_HOME, 'hooks.json');
const CURSOR_RULES_PATH = join(CURSOR_HOME, 'rules', 'sigil.mdc');

const meta = {
  id: AGENT,
  label: 'Cursor',
  hint: 'hooks load + save memory; MCP tools for recall',
  capabilities: { sessionStart: 'auto', recall: 'tool', capture: 'auto', tools: 'mcp' },
  firstRunHint: 'Start a new Cursor agent chat',
  requiresRestart: true,
};

async function detect() {
  return detectInstalled({ dirs: [CURSOR_HOME], apps: ['Cursor'], bins: ['cursor', 'cursor-agent'] });
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

const hookCommand = (name) => `'${HOOK_SHIM_PATH}' ${name} --agent=${AGENT}`;

function sigilHooks() {
  return {
    sessionStart: { command: hookCommand('session-start'), timeout: 15 },
    beforeSubmitPrompt: { command: hookCommand('user-prompt-submit'), timeout: 5 },
    // The hook hands the save to a background process and returns at once.
    stop: { command: hookCommand('stop'), timeout: 10 },
  };
}
export const CURSOR_HOOK_EVENTS = Object.keys(sigilHooks());

async function writeHooks({ dryRun = false } = {}) {
  const { data, missing, error } = await readJsonConfig(CURSOR_HOOKS_PATH);
  if (error) return { action: 'skip', path: CURSOR_HOOKS_PATH, detail: `${error} — not touched; fix or move it, then re-run` };

  const before = JSON.stringify(data);
  if (data.version == null) data.version = 1;
  data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  stripFlatSigilHooks(data.hooks);
  for (const [event, entry] of Object.entries(sigilHooks())) {
    data.hooks[event] = [...(data.hooks[event] || []), entry];
  }
  if (JSON.stringify(data) === before) return { action: 'skip', path: CURSOR_HOOKS_PATH, detail: 'sigil hooks up to date' };

  const result = await writeJsonConfig(CURSOR_HOOKS_PATH, data, { dryRun });
  return {
    action: result.action,
    path: CURSOR_HOOKS_PATH,
    detail: missing ? 'new hooks.json with sigil hooks' : `+${CURSOR_HOOK_EVENTS.join(', +')} hooks (other hooks preserved)`,
  };
}

// ── Rule ──────────────────────────────────────────────────────────────────────

// `alwaysApply: true` puts the instructions in every prompt — the closest
// thing Cursor has to per-prompt recall.
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
  if (!dryRun) await mkdir(dirname(CURSOR_RULES_PATH), { recursive: true });
  const result = await safeWrite(CURSOR_RULES_PATH, buildRulesFile(), { dryRun });
  return { action: result.action, path: CURSOR_RULES_PATH, detail: `${result.bytes ?? 0} bytes, alwaysApply=true` };
}

// ── Contract ──────────────────────────────────────────────────────────────────

async function writeMcpEntry({ dryRun = false } = {}) {
  await writeLauncherShim({ dryRun });
  return upsertJsonMcpServer(CURSOR_MCP_PATH, AGENT, { dryRun });
}

async function install({ dryRun = false } = {}) {
  const actions = [];
  actions.push(await writeMcpEntry({ dryRun }));
  actions.push(await writeHooks({ dryRun }));
  actions.push(await writeRulesFile({ dryRun }));
  return { actions: actions.filter(Boolean) };
}

async function verify({ deep = false } = {}) {
  const missing = [];
  let anyPresent = false;

  const mcp = await hasJsonMcpServer(CURSOR_MCP_PATH);
  if (mcp.error) return { installed: false, partial: false, reason: `~/.cursor/mcp.json ${mcp.error}` };
  if (mcp.present) anyPresent = true;
  else missing.push('MCP entry in mcp.json');

  const { data: hooksFile, error } = await readJsonConfig(CURSOR_HOOKS_PATH);
  if (error) return { installed: false, partial: anyPresent, reason: `~/.cursor/hooks.json ${error}` };
  const missingHooks = CURSOR_HOOK_EVENTS.filter((e) => !(hooksFile?.hooks?.[e] || []).some((h) => isSigilHookCommand(h?.command)));
  if (missingHooks.length < CURSOR_HOOK_EVENTS.length) anyPresent = true;
  if (missingHooks.length) missing.push(`hooks (${missingHooks.join(', ')})`);

  if (existsSync(CURSOR_RULES_PATH)) anyPresent = true;
  else missing.push('rule ~/.cursor/rules/sigil.mdc');

  if (missing.length) return { installed: false, partial: anyPresent, reason: `missing: ${missing.join('; ')}` };

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

  const mcp = await removeJsonMcpServer(CURSOR_MCP_PATH, { dryRun });
  if (mcp) actions.push(mcp);

  if (existsSync(CURSOR_HOOKS_PATH)) {
    const { data, error } = await readJsonConfig(CURSOR_HOOKS_PATH);
    if (error) {
      actions.push({ action: 'skip', path: CURSOR_HOOKS_PATH, detail: `${error} — not touched` });
    } else if (stripFlatSigilHooks(data.hooks || {})) {
      const result = await writeJsonConfig(CURSOR_HOOKS_PATH, data, { dryRun });
      actions.push({ action: result.action, path: CURSOR_HOOKS_PATH, detail: 'sigil hooks removed (other hooks preserved)' });
    } else {
      actions.push({ action: 'skip', path: CURSOR_HOOKS_PATH, detail: 'no sigil hooks to remove' });
    }
  }

  // We own this file; no other tool writes it.
  if (existsSync(CURSOR_RULES_PATH)) {
    if (!dryRun) await unlink(CURSOR_RULES_PATH);
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
  writeMcpEntry,
  writeHooks,
  writeRulesFile,
  resolveServerPath,
};
