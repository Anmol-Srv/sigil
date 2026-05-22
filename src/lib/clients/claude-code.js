/**
 * Claude Code client integration.
 *
 * Installs three things into the user's ~/.claude/ directory:
 *   1. ~/.sigil/CLAUDE.md           — shared instructions (delegated to instructions.js)
 *   2. ~/.claude/CLAUDE.md          — adds one @import line pointing at (1)
 *   3. ~/.claude/settings.json      — merges 4 hook entries (UserPromptSubmit,
 *                                     PostToolUse, Stop, SessionEnd)
 *
 * Each function is idempotent: re-running sigil init detects prior writes
 * and either skips or merges cleanly.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { safeWrite } from '../safe-write.js';
import { writeSharedInstructions, SHARED_INSTRUCTIONS_PATH } from './instructions.js';

const CLAUDE_HOME = join(homedir(), '.claude');
const CLAUDE_MD_PATH = join(CLAUDE_HOME, 'CLAUDE.md');
const CLAUDE_SETTINGS_PATH = join(CLAUDE_HOME, 'settings.json');

// Resolve to the package root regardless of whether we're running from source
// or from the bundled `dist/`. Same logic as cli.js's PKG_DIR computation.
const PKG_DIR = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

const meta = {
  id: 'claude-code',
  label: 'Claude Code',
  hint: 'hooks + @import — full auto-injection',
};

async function detect() {
  return existsSync(CLAUDE_HOME);
}

// Adds the single @~/.sigil/CLAUDE.md line to ~/.claude/CLAUDE.md.
// Idempotent: skips if the line is already present, otherwise appends.
async function writeImportLine({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  if (!dryRun) await fs.mkdir(CLAUDE_HOME, { recursive: true });

  const importLine = `@${SHARED_INSTRUCTIONS_PATH}`;
  let existing = '';
  if (existsSync(CLAUDE_MD_PATH)) {
    existing = await fs.readFile(CLAUDE_MD_PATH, 'utf8');
  }

  if (existing.includes(importLine)) {
    return { action: 'skip', path: CLAUDE_MD_PATH, detail: 'already imports sigil CLAUDE.md' };
  }

  const separator = existing.trim() ? '\n' : '';
  const newContent = `${existing}${separator}${importLine}\n`;
  const result = await safeWrite(CLAUDE_MD_PATH, newContent, { dryRun });
  return {
    action: result.action,
    path: CLAUDE_MD_PATH,
    detail: existing ? '+1 @import line' : 'new file',
  };
}

// Merges Sigil's 4 hook entries into ~/.claude/settings.json.
//
// Hook scripts ship in two places:
//   - src/hooks/*.js   when running from source
//   - dist/hooks/*.js  when running from the published binary
// We prefer dist/ if present so installed users get the bundled scripts.
async function mergeHooks({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  let settings = {};
  try {
    const raw = await fs.readFile(CLAUDE_SETTINGS_PATH, 'utf8');
    settings = JSON.parse(raw);
  } catch { /* file doesn't exist or invalid — start fresh */ }

  const srcHooks = join(PKG_DIR, 'src', 'hooks');
  const distHooks = join(PKG_DIR, 'dist', 'hooks');
  const hookDir = existsSync(distHooks) ? distHooks : srcHooks;

  const sigilHooks = {
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
    Stop: {
      hooks: [{
        type: 'command',
        command: `node ${join(hookDir, 'stop.js')}`,
        timeout: 30,
        async: true,
      }],
    },
    SessionEnd: {
      hooks: [{
        type: 'command',
        command: `node ${join(hookDir, 'session-end.js')}`,
        timeout: 10,
        async: true,
      }],
    },
  };

  const existedBefore = existsSync(CLAUDE_SETTINGS_PATH);
  settings.hooks = settings.hooks || {};

  // Recognise prior Sigil hooks by their script filename — robust against
  // varying install paths (some users have the binary under /cortex/,
  // others /sigil/, others /opt/, ...). Filtering by literal "sigil" in
  // the path missed installs whose path didn't contain it — causing every
  // re-run of sigil init to APPEND a duplicate hook entry.
  const SIGIL_HOOK_FILES = [
    'user-prompt-submit.js',
    'stop.js',
    'post-tool-use.js',
    'session-end.js',
  ];
  const isSigilHook = (cmd) =>
    typeof cmd === 'string' && SIGIL_HOOK_FILES.some((fn) => cmd.endsWith(fn) || cmd.includes(`/${fn}`));

  for (const [event, entry] of Object.entries(sigilHooks)) {
    const existing = settings.hooks[event] || [];
    const filtered = existing.filter(
      (h) => !h.hooks?.some((inner) => isSigilHook(inner.command)),
    );
    settings.hooks[event] = [...filtered, entry];
  }

  if (!dryRun) await fs.mkdir(CLAUDE_HOME, { recursive: true });
  const newContent = JSON.stringify(settings, null, 2);
  const result = await safeWrite(CLAUDE_SETTINGS_PATH, newContent, { dryRun });
  return {
    action: result.action,
    path: CLAUDE_SETTINGS_PATH,
    detail: existedBefore
      ? '+UserPromptSubmit, +PostToolUse, +Stop, +SessionEnd hooks (other settings preserved)'
      : 'new settings.json with sigil hooks',
  };
}

// Top-level install handler. Returns an array of plan actions so the init
// orchestrator can fold them into its dry-run summary.
async function install({ dryRun = false } = {}) {
  const actions = [];

  const instructions = await writeSharedInstructions({ dryRun });
  if (instructions) {
    actions.push({
      action: instructions.action,
      path: instructions.path,
      detail: `${instructions.bytes ?? 0} bytes`,
    });
  }

  const importResult = await writeImportLine({ dryRun });
  if (importResult) actions.push(importResult);

  const hooksResult = await mergeHooks({ dryRun });
  if (hooksResult) actions.push(hooksResult);

  return { actions };
}

// Returns whether Sigil is currently installed into Claude Code's config —
// distinct from `detect()` which only asks "is Claude Code present on this
// machine." `sigil doctor` uses this to flag drift (e.g., user edited
// settings.json by hand and dropped a hook).
async function verify() {
  const fs = await import('node:fs/promises');
  const importLine = `@${SHARED_INSTRUCTIONS_PATH}`;

  if (!existsSync(CLAUDE_MD_PATH)) {
    return { installed: false, reason: '~/.claude/CLAUDE.md missing — run `sigil init`' };
  }
  const md = await fs.readFile(CLAUDE_MD_PATH, 'utf8');
  if (!md.includes(importLine)) {
    return { installed: false, reason: '@import line missing from ~/.claude/CLAUDE.md' };
  }

  if (!existsSync(CLAUDE_SETTINGS_PATH)) {
    return { installed: false, reason: '~/.claude/settings.json missing — hooks not registered' };
  }
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(CLAUDE_SETTINGS_PATH, 'utf8'));
  } catch {
    return { installed: false, reason: '~/.claude/settings.json is not valid JSON' };
  }
  const hooks = settings.hooks || {};
  const required = ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];
  const missing = required.filter((event) => {
    const entries = hooks[event] || [];
    return !entries.some((h) => h.hooks?.some((inner) => typeof inner.command === 'string'
      && (inner.command.includes('user-prompt-submit.js')
       || inner.command.includes('post-tool-use.js')
       || inner.command.includes('stop.js')
       || inner.command.includes('session-end.js'))));
  });
  if (missing.length) {
    return { installed: false, reason: `hooks missing: ${missing.join(', ')}` };
  }

  return { installed: true };
}

// Symmetric to install(). Removes the @import line, strips Sigil's hook
// entries from settings.json, and leaves everything else intact. Does NOT
// delete ~/.sigil/CLAUDE.md (that's shared with other clients; `sigil reset`
// is the right command for a full wipe).
async function uninstall({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');
  const actions = [];

  // Strip @import from ~/.claude/CLAUDE.md
  if (existsSync(CLAUDE_MD_PATH)) {
    const importLine = `@${SHARED_INSTRUCTIONS_PATH}`;
    const before = await fs.readFile(CLAUDE_MD_PATH, 'utf8');
    const re = new RegExp(`^${importLine.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\n?`, 'gm');
    const after = before.replace(re, '');
    if (after !== before) {
      const result = await safeWrite(CLAUDE_MD_PATH, after, { dryRun });
      actions.push({ action: result.action, path: CLAUDE_MD_PATH, detail: '-1 @import line' });
    } else {
      actions.push({ action: 'skip', path: CLAUDE_MD_PATH, detail: '@import not present' });
    }
  }

  // Strip Sigil hook entries from settings.json
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    let settings;
    try {
      settings = JSON.parse(await fs.readFile(CLAUDE_SETTINGS_PATH, 'utf8'));
    } catch {
      actions.push({ action: 'skip', path: CLAUDE_SETTINGS_PATH, detail: 'invalid JSON — not touched' });
      return { actions };
    }
    const SIGIL_HOOK_FILES = ['user-prompt-submit.js', 'stop.js', 'post-tool-use.js', 'session-end.js'];
    const isSigilHook = (cmd) =>
      typeof cmd === 'string' && SIGIL_HOOK_FILES.some((fn) => cmd.endsWith(fn) || cmd.includes(`/${fn}`));

    let touched = false;
    for (const event of Object.keys(settings.hooks || {})) {
      const before = settings.hooks[event];
      const after = before.filter((h) => !h.hooks?.some((inner) => isSigilHook(inner.command)));
      if (after.length !== before.length) {
        touched = true;
        if (after.length === 0) delete settings.hooks[event];
        else settings.hooks[event] = after;
      }
    }
    if (touched) {
      const result = await safeWrite(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), { dryRun });
      actions.push({ action: result.action, path: CLAUDE_SETTINGS_PATH, detail: 'sigil hooks removed (other entries preserved)' });
    } else {
      actions.push({ action: 'skip', path: CLAUDE_SETTINGS_PATH, detail: 'no sigil hooks to remove' });
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
  // Exposed for direct use by `sigil reset` and similar low-level callers.
  writeImportLine,
  mergeHooks,
};
