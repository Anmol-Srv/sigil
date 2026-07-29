/**
 * Codex CLI client integration.
 *
 * Codex CLI uses TOML, a markdown rules file, and a user-level hooks file:
 *   1. ~/.codex/config.toml      — MCP server registration under
 *                                   [mcp_servers.sigil]
 *   2. ~/.codex/AGENTS.md        — agent rules (community-shared format —
 *                                   Aider and others also read AGENTS.md)
 *   3. ~/.codex/hooks.json       — one UserPromptSubmit recall hook
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

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import TOML from '@iarna/toml';

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';
import { buildSharedInstructions, hasCurrentInstructions } from './instructions.js';
import { writeCodexSigilSkill, removeCodexSigilSkill, CODEX_SIGIL_SKILL_PATH, hasCurrentSigilSkill } from './skill.js';
import { HOOK_SHIM_PATH, MCP_SHIM_PATH, writeLauncherShim, resolveServerPath } from './shim.js';

const CODEX_HOME = join(homedir(), '.codex');
const CODEX_CONFIG_PATH = join(CODEX_HOME, 'config.toml');
const CODEX_AGENTS_PATH = join(CODEX_HOME, 'AGENTS.md');
const CODEX_HOOKS_PATH = join(CODEX_HOME, 'hooks.json');

const BEGIN_MARKER = '<!-- BEGIN sigil -->';
const END_MARKER = '<!-- END sigil -->';

const meta = {
  id: 'codex-cli',
  label: 'Codex CLI',
  hint: 'MCP + one prompt-time recall hook (approve once in /hooks)',
  automaticRecall: true,
};

async function detect() {
  return detectInstalled({ dirs: [CODEX_HOME], bins: ['codex'] });
}


// Read existing TOML if present, set mcp_servers.sigil, write back.
// NOTE: @iarna/toml strips ALL comments on round-trip — only key/value data
// survives. The keys we don't touch are preserved (values intact), but any
// inline or standalone comments in the user's config.toml are lost. Ordering
// of untouched top-level tables may also shift.
async function writeMcpEntry({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  let config = {};
  try {
    const raw = await fs.readFile(CODEX_CONFIG_PATH, 'utf8');
    config = TOML.parse(raw);
  } catch (err) {
    // ENOENT (no file yet) is the only safe "start fresh" case. A TOML parse
    // error means the file has content we can't round-trip; overwriting it
    // would destroy every other key the user configured. Refuse to touch it,
    // matching the uninstall() path.
    if (err.code !== 'ENOENT') {
      return {
        action: 'skip',
        path: CODEX_CONFIG_PATH,
        detail: `invalid TOML — not touched (${err.message})`,
      };
    }
  }

  const existedBefore = existsSync(CODEX_CONFIG_PATH);

  config.mcp_servers = config.mcp_servers || {};
  // Point `command` at the stable MCP shim (~/.sigil/bin/sigil-mcp), not a
  // baked `node /abs/dist/server.js` — survives Node-version switches /
  // reinstalls. config.json remains the source of truth for runtime config.
  await writeLauncherShim({ dryRun });
  config.mcp_servers.sigil = {
    command: MCP_SHIM_PATH,
    args: [],
    // Provenance only. A shared Sigil store must still show that Codex wrote
    // a fact, rather than collapsing all stdio clients into generic `mcp`.
    // Codex documents `env` as the supported per-MCP-server environment map.
    env: { SIGIL_AGENT: 'codex' },
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
    buildSharedInstructions({ transport: 'mcp', automaticRecall: true }),
    END_MARKER,
  ].join('\n');
}

const LEGACY_SIGIL_HOOK_FILES = ['user-prompt-submit.js', 'stop.js', 'post-tool-use.js', 'session-end.js'];

function isSigilHook(command) {
  return typeof command === 'string'
    && (command.includes('sigil-hook')
      || (command.includes('sigil')
        && LEGACY_SIGIL_HOOK_FILES.some((file) => command.endsWith(file) || command.includes(`/${file}`))));
}

// Remove Sigil-owned commands while preserving any other hook sharing the
// same event group. Codex runs all matching UserPromptSubmit hooks, so a
// reconnect must replace ours without deleting another product's integration.
function stripSigilHooks(hooks) {
  let touched = false;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const nextEntries = [];
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) {
        nextEntries.push(entry);
        continue;
      }
      const nextInner = entry.hooks.filter((inner) => !isSigilHook(inner?.command));
      if (nextInner.length !== entry.hooks.length) touched = true;
      if (nextInner.length) nextEntries.push({ ...entry, hooks: nextInner });
    }
    if (nextEntries.length) hooks[event] = nextEntries;
    else if (entries.length) {
      delete hooks[event];
      touched = true;
    }
  }
  return touched;
}

function findSigilPromptHook(hooks) {
  for (const [entryIndex, entry] of (hooks?.UserPromptSubmit || []).entries()) {
    for (const [hookIndex, hook] of (entry?.hooks || []).entries()) {
      if (isSigilHook(hook?.command)) {
        return {
          command: hook.command,
          trustStateKey: `${CODEX_HOOKS_PATH}:user_prompt_submit:${entryIndex}:${hookIndex}`,
        };
      }
    }
  }
  return null;
}

// Codex's stable UserPromptSubmit event is the correct automatic-recall point:
// one read-only search per user message. PreToolUse would run repeatedly inside
// a turn and recreate the session-loop and resource amplification we removed.
async function mergeHooks({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  let hooksFile = {};
  try {
    hooksFile = JSON.parse(await fs.readFile(CODEX_HOOKS_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const detail = err instanceof SyntaxError
        ? `invalid JSON — not touched (${err.message}); fix or move it, then re-run`
        : `could not read (${err.code || err.message}) — not touched; fix permissions/ownership, then re-run`;
      return { action: 'skip', path: CODEX_HOOKS_PATH, detail };
    }
  }
  if (!hooksFile || typeof hooksFile !== 'object' || Array.isArray(hooksFile)
    || (hooksFile.hooks != null && (typeof hooksFile.hooks !== 'object' || Array.isArray(hooksFile.hooks)))) {
    return { action: 'skip', path: CODEX_HOOKS_PATH, detail: 'invalid hooks shape — not touched; fix it, then re-run' };
  }

  await writeLauncherShim({ dryRun });
  hooksFile.hooks = hooksFile.hooks || {};
  stripSigilHooks(hooksFile.hooks);
  hooksFile.hooks.UserPromptSubmit = [
    ...(hooksFile.hooks.UserPromptSubmit || []),
    {
      hooks: [{
        type: 'command',
        // Mark the hook itself too. Without this, the shared hook script
        // defaults to Claude Code and an actual Codex recall looks like it
        // came from the wrong client in diagnostics.
        command: `SIGIL_AGENT=codex '${HOOK_SHIM_PATH}' user-prompt-submit`,
        timeout: 10,
        statusMessage: 'Searching Sigil memory...',
      }],
    },
  ];

  const existedBefore = existsSync(CODEX_HOOKS_PATH);
  if (!dryRun) await fs.mkdir(CODEX_HOME, { recursive: true });
  const result = await safeWrite(CODEX_HOOKS_PATH, `${JSON.stringify(hooksFile, null, 2)}\n`, { dryRun });
  return {
    action: result.action,
    path: CODEX_HOOKS_PATH,
    detail: existedBefore
      ? '+UserPromptSubmit recall hook (other hooks preserved)'
      : 'new hooks.json with prompt-time recall',
  };
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

  const hooks = await mergeHooks({ dryRun });
  if (hooks) actions.push(hooks);

  const skill = await writeCodexSigilSkill({ dryRun });
  if (skill) actions.push({ action: skill.action, path: skill.path, detail: `${skill.bytes ?? 0} bytes` });

  return { actions };
}

// Upgrade only the marker-owned AGENTS block and Sigil's own skill. Deliberately
// leave config.toml and hooks.json alone: a healthy Codex connection should not
// lose user comments or cause Codex to reconsider a previously trusted hook.
async function refresh({ dryRun = false } = {}) {
  const actions = [];
  const agents = await writeAgentsFile({ dryRun });
  if (agents) actions.push(agents);
  const skill = await writeCodexSigilSkill({ dryRun });
  if (skill) actions.push({ action: skill.action, path: skill.path, detail: `${skill.bytes ?? 0} bytes` });
  return { actions };
}

async function verify({ deep = false } = {}) {
  const fs = await import('node:fs/promises');
  const guidanceIssues = [];

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
  if (config.mcp_servers.sigil.env?.SIGIL_AGENT !== 'codex') {
    return { installed: false, reason: 'Codex provenance is stale — run `sigil connect --clients codex-cli`' };
  }

  if (!existsSync(CODEX_AGENTS_PATH)) {
    guidanceIssues.push('AGENTS guidance');
  } else {
    const agents = await fs.readFile(CODEX_AGENTS_PATH, 'utf8');
    if (!agents.includes(BEGIN_MARKER) || !agents.includes(END_MARKER) || !hasCurrentInstructions(agents)) {
      guidanceIssues.push('AGENTS guidance');
    }
  }

  if (!existsSync(CODEX_HOOKS_PATH)) {
    return { installed: false, reason: '~/.codex/hooks.json missing — automatic recall is not registered' };
  }
  let hooksFile;
  try {
    hooksFile = JSON.parse(await fs.readFile(CODEX_HOOKS_PATH, 'utf8'));
  } catch (err) {
    return { installed: false, reason: `~/.codex/hooks.json is not valid JSON: ${err.message}` };
  }
  const hook = findSigilPromptHook(hooksFile?.hooks);
  if (!hook) {
    return { installed: false, reason: 'Sigil UserPromptSubmit hook missing from ~/.codex/hooks.json' };
  }
  if (!existsSync(CODEX_SIGIL_SKILL_PATH)) {
    guidanceIssues.push('skill');
  } else {
    try {
      const skill = await fs.readFile(CODEX_SIGIL_SKILL_PATH, 'utf8');
      if (!hasCurrentSigilSkill(skill)) guidanceIssues.push('skill');
    } catch {
      guidanceIssues.push('skill');
    }
  }

  // The registered command is the stable shim; it (and its target server) must
  // exist. Catches a moved/reinstalled Sigil.
  if (!existsSync(MCP_SHIM_PATH)) {
    return { installed: false, reason: `MCP launcher missing at ${MCP_SHIM_PATH} — run \`sigil connect\`` };
  }
  if (hook.command.includes('sigil-hook') && !existsSync(HOOK_SHIM_PATH)) {
    return { installed: false, reason: `hook launcher missing at ${HOOK_SHIM_PATH} — run \`sigil connect\`` };
  }
  const serverPath = resolveServerPath();
  if (!existsSync(serverPath)) {
    return { installed: false, reason: `MCP server missing at ${serverPath} — run \`sigil connect\` to refresh` };
  }
  // Deep: prove the server actually starts and answers a tool call.
  if (deep) {
    const { verifyMcpRoundTrip, verifyPromptHookRoundTrip } = await import('./roundtrip.js');
    const rt = await verifyMcpRoundTrip(serverPath);
    if (!rt.ok) return { installed: false, reason: `MCP round-trip failed: ${rt.reason}` };
    const hookRt = await verifyPromptHookRoundTrip(hook.command);
    if (!hookRt.ok) return { installed: false, reason: `prompt hook round-trip failed: ${hookRt.reason}` };
  }

  // A shell round-trip proves the command works, but Codex skips a user hook
  // until its exact definition is trusted through `/hooks`.
  const trusted = Boolean(config.hooks?.state?.[hook.trustStateKey]?.trusted_hash);
  const attentionItems = [];
  if (!trusted) {
    attentionItems.push('automatic recall is waiting for Codex approval — open a new Codex session, run `/hooks`, and trust the Sigil UserPromptSubmit hook');
  }
  if (guidanceIssues.length) {
    attentionItems.push(`Sigil ${[...new Set(guidanceIssues)].join(' and ')} ${guidanceIssues.length === 1 ? 'is' : 'are'} missing or out of date — run \`sigil update\` to refresh them. Automatic recall remains connected.`);
  }
  const attention = attentionItems.length ? attentionItems.join(' ') : null;
  const attentionKind = attentionItems.length === 2
    ? 'multiple'
    : (!trusted ? 'approval' : (guidanceIssues.length ? 'outdated' : null));
  return { installed: true, attention, attentionKind };
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

  // Remove only Sigil's command from hooks.json. A Codex user may have other
  // hooks in the same event group, and they must remain untouched.
  if (existsSync(CODEX_HOOKS_PATH)) {
    let hooksFile;
    try {
      hooksFile = JSON.parse(await fs.readFile(CODEX_HOOKS_PATH, 'utf8'));
    } catch (err) {
      actions.push({ action: 'skip', path: CODEX_HOOKS_PATH, detail: `invalid JSON — not touched: ${err.message}` });
      return { actions };
    }
    if (!hooksFile || typeof hooksFile !== 'object' || Array.isArray(hooksFile)
      || (hooksFile.hooks != null && (typeof hooksFile.hooks !== 'object' || Array.isArray(hooksFile.hooks)))) {
      actions.push({ action: 'skip', path: CODEX_HOOKS_PATH, detail: 'invalid hooks shape — not touched' });
    } else if (stripSigilHooks(hooksFile.hooks || {})) {
      hooksFile.hooks = hooksFile.hooks || {};
      const result = await safeWrite(CODEX_HOOKS_PATH, `${JSON.stringify(hooksFile, null, 2)}\n`, { dryRun });
      actions.push({ action: result.action, path: CODEX_HOOKS_PATH, detail: 'Sigil prompt hook removed (other hooks preserved)' });
    } else {
      actions.push({ action: 'skip', path: CODEX_HOOKS_PATH, detail: 'Sigil prompt hook not present' });
    }
  }

  const skillRemoval = await removeCodexSigilSkill({ dryRun });
  if (skillRemoval) actions.push(skillRemoval);

  return { actions };
}

export {
  meta,
  detect,
  install,
  refresh,
  uninstall,
  verify,
  writeMcpEntry,
  writeAgentsFile,
  mergeHooks,
  resolveServerPath,
};
