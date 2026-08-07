/**
 * Claude Code client integration.
 *
 * Installs four things into the user's ~/.claude/ directory:
 *   1. ~/.sigil/CLAUDE.md              — shared instructions (delegated to instructions.js)
 *   2. ~/.claude/CLAUDE.md             — adds one @import line pointing at (1)
 *   3. ~/.claude/settings.json         — merges 4 hook entries (UserPromptSubmit,
 *                                        PostToolUse, Stop, SessionEnd)
 *   4. ~/.claude/skills/sigil/SKILL.md — the `/sigil` skill: a preamble that
 *                                        self-tests the live connection + guides
 *                                        the user (delegated to skill.js)
 *
 * Each function is idempotent: re-running sigil init detects prior writes
 * and either skips or merges cleanly.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import { safeWrite } from '../safe-write.js';
import { detectInstalled } from './detect.js';
import { writeSharedInstructions, SHARED_INSTRUCTIONS_PATH } from './instructions.js';
import { writeSigilSkill, removeSigilSkill, SIGIL_SKILL_PATH } from './skill.js';
import { HOOK_SHIM_PATH, LAUNCHER_SHIM_PATH, writeLauncherShim } from './shim.js';

const CLAUDE_HOME = join(homedir(), '.claude');
const CLAUDE_MD_PATH = join(CLAUDE_HOME, 'CLAUDE.md');
const CLAUDE_SETTINGS_PATH = join(CLAUDE_HOME, 'settings.json');

const meta = {
  id: 'claude-code',
  label: 'Claude Code',
  hint: 'hooks + @import — full auto-injection',
};

// Recognise a hook command as ours, in any form we have ever written:
//   - `'~/.sigil/bin/sigil-hook' stop`             the hook shim
//   - `'~/.sigil/bin/sigil' preamble ...`          the CLI shim (SessionStart)
//   - `node /abs/path/dist/hooks/stop.js`          legacy baked path
// Matching on the stable ~/.sigil/bin/ prefix covers both shims; the filename
// list keeps legacy installs recognisable across varying install paths.
const SIGIL_HOOK_FILES = [
  'user-prompt-submit.js',
  'stop.js',
  'post-tool-use.js',
  'session-end.js',
];
function isSigilHook(cmd) {
  return typeof cmd === 'string'
    && (cmd.includes('.sigil/bin/')
      || cmd.includes('sigil-hook')
      || SIGIL_HOOK_FILES.some((fn) => cmd.endsWith(fn) || cmd.includes(`/${fn}`)));
}

/**
 * Remove every Sigil hook entry from a settings.hooks map, in place, dropping
 * events we emptied. Returns true if anything changed. Shared by mergeHooks
 * (strip-then-readd) and uninstall so the two can never drift apart.
 */
function stripSigilHooks(hooks = {}) {
  let touched = false;
  for (const event of Object.keys(hooks)) {
    const before = hooks[event];
    if (!Array.isArray(before)) continue;
    const after = before.filter((h) => !h.hooks?.some((inner) => isSigilHook(inner.command)));
    if (after.length === before.length) continue;
    touched = true;
    if (after.length === 0) delete hooks[event];
    else hooks[event] = after;
  }
  return touched;
}

async function detect() {
  return detectInstalled({ dirs: [CLAUDE_HOME], bins: ['claude'] });
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
// Hook commands invoke the STABLE hook shim (~/.sigil/bin/sigil-hook <name>)
// rather than `node /abs/path/dist/hooks/<name>.js`. The shim path never moves,
// so a Node version switch or reinstall can't leave settings.json pointing at a
// dead path; the shim re-resolves the real script at runtime and fails safe if
// it can't (see shim.js). We ensure the shim exists before referencing it.
async function mergeHooks({ dryRun = false } = {}) {
  const fs = await import('node:fs/promises');

  await writeLauncherShim({ dryRun });

  let settings = {};
  try {
    const raw = await fs.readFile(CLAUDE_SETTINGS_PATH, 'utf8');
    settings = JSON.parse(raw);
  } catch (err) {
    // ENOENT is fine — a fresh settings.json is the correct outcome. Anything
    // else means the file EXISTS but we couldn't load it; starting fresh here
    // would silently WIPE every other hook/setting the user has (gstack hooks,
    // statusline, permissions, ...). Mirror cursor.js / codex-cli.js and refuse
    // to touch it — surface it instead. Distinguish the two non-ENOENT cases so
    // the user fixes the right thing: a SyntaxError is malformed JSON; anything
    // else (EACCES, EPERM, EISDIR, ...) is an I/O problem on a file that may be
    // perfectly valid JSON we just can't read.
    if (err.code !== 'ENOENT') {
      const detail = err instanceof SyntaxError
        ? `invalid JSON — not touched (${err.message}); fix or move it, then re-run`
        : `could not read (${err.code || err.message}) — not touched; fix permissions/ownership, then re-run`;
      return { action: 'skip', path: CLAUDE_SETTINGS_PATH, detail };
    }
  }

  // Quote the shim path so a homedir with spaces still parses as one argument.
  const hook = (name) => `'${HOOK_SHIM_PATH}' ${name}`;

  const sigilHooks = {
    // Runs the same engine as the `prime` MCP tool. Two jobs: it WARMS the
    // daemon, the embedded DB and the embedding model before the first real
    // prompt (a cold path was blowing the read hook's ~9s budget and injecting
    // nothing), and it puts Sigil's health in the agent's context so a degraded
    // brain reads as "SIGIL: degraded" instead of silently empty recall.
    SessionStart: {
      hooks: [{
        type: 'command',
        command: `'${LAUNCHER_SHIM_PATH}' preamble --format=lines`,
        timeout: 10,
        statusMessage: 'Priming memory...',
      }],
    },
    UserPromptSubmit: {
      hooks: [{
        type: 'command',
        command: hook('user-prompt-submit'),
        timeout: 10,
        statusMessage: 'Searching memory...',
      }],
    },
    // NOTE: no PostToolUse entry. That hook has been a deliberate no-op since
    // tool-activity facts were dropped (see post-tool-use.js) — registering it
    // spawned a Node process on every Edit/Write/Bash purely to print `{}`, on
    // the hottest path in the agent loop. Re-enabling the hook means re-adding
    // an entry here. stripLegacyHooks() below removes it from existing installs.
    Stop: {
      hooks: [{
        type: 'command',
        command: hook('stop'),
        timeout: 30,
        async: true,
      }],
    },
    SessionEnd: {
      hooks: [{
        type: 'command',
        command: hook('session-end'),
        timeout: 10,
        async: true,
      }],
    },
  };

  const existedBefore = existsSync(CLAUDE_SETTINGS_PATH);
  settings.hooks = settings.hooks || {};

  // Strip EVERY Sigil hook from EVERY event first, then add back only what we
  // register now. Sweeping all events (rather than just the ones we're about to
  // write) is what lets a hook we've RETIRED — PostToolUse — actually disappear
  // from an existing install instead of lingering forever.
  stripSigilHooks(settings.hooks);
  for (const [event, entry] of Object.entries(sigilHooks)) {
    settings.hooks[event] = [...(settings.hooks[event] || []), entry];
  }

  if (!dryRun) await fs.mkdir(CLAUDE_HOME, { recursive: true });
  const newContent = JSON.stringify(settings, null, 2);
  const result = await safeWrite(CLAUDE_SETTINGS_PATH, newContent, { dryRun });
  return {
    action: result.action,
    path: CLAUDE_SETTINGS_PATH,
    detail: existedBefore
      ? `+${Object.keys(sigilHooks).join(', +')} hooks (other settings preserved)`
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

  // The /sigil skill — a gstack-style preamble that self-tests the connection
  // and guides the user. Claude-Code-only (skills are a Claude Code feature).
  const skillResult = await writeSigilSkill({ dryRun });
  if (skillResult) {
    actions.push({ action: skillResult.action, path: skillResult.path, detail: `${skillResult.bytes ?? 0} bytes` });
  }

  return { actions };
}

// Returns whether Sigil is currently installed into Claude Code's config —
// distinct from `detect()` which only asks "is Claude Code present on this
// machine." `sigil doctor` uses this to flag drift (e.g., user edited
// settings.json by hand and dropped a hook).
async function verify({ deep = false } = {}) {
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
  // PostToolUse is deliberately absent — it is no longer registered (see
  // mergeHooks), so requiring it here would report every healthy install as
  // drifted and send the user in a `sigil init` loop that never converges.
  const required = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];

  // Find the command string registered for an event, if any. Recognises every
  // form we've written (both shims + the legacy baked path) via isSigilHook.
  const findHookCommand = (event) => {
    for (const h of hooks[event] || []) {
      for (const inner of h.hooks || []) {
        if (isSigilHook(inner.command)) return inner.command;
      }
    }
    return null;
  };

  const missing = required.filter((event) => !findHookCommand(event));
  if (missing.length) {
    return { installed: false, reason: `hooks missing: ${missing.join(', ')}` };
  }

  // Registered isn't enough — the hook must be reachable on disk. A moved or
  // reinstalled repo could leave settings.json pointing at a stale path;
  // without this check `sigil doctor` reports a false green while every hook
  // silently fails. Shim form: the shim file must exist (it self-heals/fails
  // safe at runtime). Legacy form: the .js script must exist.
  for (const event of required) {
    const cmd = findHookCommand(event);
    // Shim forms: the referenced shim must exist (it self-heals / fails safe at
    // runtime). SessionStart runs the CLI shim, the rest run the hook shim.
    const shim = cmd.includes('sigil-hook') ? HOOK_SHIM_PATH
      : cmd.includes('.sigil/bin/') ? LAUNCHER_SHIM_PATH
        : null;
    if (shim) {
      if (!existsSync(shim)) {
        return { installed: false, reason: `hook launcher missing: ${shim} (run \`sigil init\`)` };
      }
      continue;
    }
    const pathMatch = cmd.match(/(\/[^\s"']+\.js)/);
    if (pathMatch && !existsSync(pathMatch[1])) {
      return { installed: false, reason: `hook file missing on disk: ${pathMatch[1]} (run \`sigil init\`)` };
    }
  }

  // The /sigil skill (preamble self-test + guidance). Less critical than hooks —
  // memory still works without it — but a healthy install ships it, so flag its
  // absence as drift `sigil init` will repair.
  if (!existsSync(SIGIL_SKILL_PATH)) {
    return { installed: false, reason: '/sigil skill missing — run `sigil init`' };
  }

  // Deep: actually run the UserPromptSubmit hook with a synthetic payload and
  // confirm it returns cleanly — catches a hook that crashes at runtime even
  // though its file exists (bad config, MODULE_NOT_FOUND in a dep, etc.).
  if (deep) {
    const cmd = findHookCommand('UserPromptSubmit');
    const { verifyClaudeHookRoundTrip } = await import('./roundtrip.js');
    const rt = await verifyClaudeHookRoundTrip(cmd);
    if (!rt.ok) return { installed: false, reason: `hook round-trip failed: ${rt.reason}` };
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
    if (stripSigilHooks(settings.hooks || {})) {
      const result = await safeWrite(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), { dryRun });
      actions.push({ action: result.action, path: CLAUDE_SETTINGS_PATH, detail: 'sigil hooks removed (other entries preserved)' });
    } else {
      actions.push({ action: 'skip', path: CLAUDE_SETTINGS_PATH, detail: 'no sigil hooks to remove' });
    }
  }

  // Remove the /sigil skill.
  const skillRemoval = await removeSigilSkill({ dryRun });
  if (skillRemoval) actions.push(skillRemoval);

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
