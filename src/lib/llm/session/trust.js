/**
 * Pre-accept Claude Code's folder-trust dialog for the worker's workspace.
 *
 * A warm worker is launched detached inside tmux with no human at the keyboard.
 * On the FIRST `claude` run in a directory it has never seen, Claude Code opens
 * an interactive prompt:
 *
 *     Accessing workspace: /Users/you/.sigil
 *     ❯ 1. Yes, I trust this folder
 *       2. No, exit
 *
 * and blocks there forever. Every worker then dies on the boot handshake
 * ("silent after 10000ms → recycling ×3 → staying on one-shot"), so enabling
 * the engine silently changes nothing. This writes the exact record pressing
 * "1" would write, so the pane boots straight to the prompt.
 *
 * Scope: ONE directory — Sigil's own home, which the daemon owns and which
 * holds no user code. We never touch trust for any other project.
 *
 * KNOWN RACE: a `claude` running elsewhere holds ~/.claude.json in memory and
 * rewrites it wholesale on exit, which can drop our key. That is self-healing —
 * the next daemon start re-adds it — so we don't lock the file.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_CONFIG_PATH = join(homedir(), '.claude.json');

/**
 * Ensure `dir` is marked trusted in Claude Code's config. Returns what happened
 * so the caller can log it: 'already' | 'added' | 'skipped:<reason>'.
 * Never throws — a failure here must not stop the daemon booting.
 *
 * @param {string} dir           absolute workspace path to trust
 * @param {object} [io]          fs seams for tests
 */
export async function ensureFolderTrusted(dir, io = {}) {
  const path = io.path || CLAUDE_CONFIG_PATH;
  const read = io.readFile || readFile;
  const write = io.writeFile || writeFile;
  const mv = io.rename || rename;

  let raw;
  try {
    raw = await read(path, 'utf8');
  } catch {
    // No ~/.claude.json at all means Claude Code has never run as this user;
    // creating one from scratch would be guessing at a schema we don't own.
    return 'skipped:no-config';
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return 'skipped:unparseable';
  }
  if (!cfg || typeof cfg !== 'object') return 'skipped:unparseable';

  if (cfg.projects?.[dir]?.hasTrustDialogAccepted === true) return 'already';

  cfg.projects = cfg.projects || {};
  cfg.projects[dir] = {
    ...(cfg.projects[dir] || {}),
    hasTrustDialogAccepted: true,
    // Without this the worker gets the onboarding walkthrough instead of a
    // prompt — a different interactive wall, same dead pane.
    hasCompletedProjectOnboarding: true,
  };

  // Write-then-rename: a crash mid-write must not leave the user with a
  // truncated ~/.claude.json and no Claude Code.
  const tmp = `${path}.sigil-tmp`;
  try {
    await write(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    await mv(tmp, path);
  } catch {
    return 'skipped:write-failed';
  }
  return 'added';
}
