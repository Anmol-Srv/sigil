/**
 * Resolve filesystem paths that are stable across both source and bundled distribution.
 *
 * In dev:    src/memory/cognitive/query-router.js → 3 levels up to package root
 * In dist:   dist/cli.js (everything bundled into one file) → 1 level up to package root
 *
 * Walking up from import.meta.url until we hit a package.json gives us the package
 * root regardless of where this file ends up after bundling.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

function findPackageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up to 10 levels max to avoid infinite loops on weird filesystems
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'prompts'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: use cwd (will fail loudly on prompt load, easier to debug)
  return process.cwd();
}

const PKG_ROOT = findPackageRoot();

/**
 * Is the running package located in an EPHEMERAL cache that a package manager
 * garbage-collects — i.e. it was launched via `pnpm dlx`, `npx`, or `yarn dlx`
 * rather than installed? Baking such a path into the shims/hooks (which is what
 * `sigil init`/`connect` do) produces a setup that:
 *   1. silently dies the moment the cache is reaped (the shim fails safe), and
 *   2. cold-boots a heavy bundled node process from that path on every hook fire
 *      (PostToolUse on every Edit/Write/Bash, ×N sessions) — a runaway pileup.
 * So the persistence-writing entrypoints refuse it and ask the user to install
 * Sigil globally first.
 *
 * @param {string} [root=PKG_ROOT]
 * @returns {{ephemeral:boolean, kind?:'pnpm-dlx'|'npx'|'temp', installHint?:string, root:string}}
 */
// The one blessed install path: the bash installer lands Sigil persistently on
// PATH and hands off to first-run. Every ephemeral-runner refusal points here
// (not `npm i -g` / `pnpm add -g`) so the guidance is a single command.
const INSTALL_SH = 'curl -fsSL https://raw.githubusercontent.com/Anmol-Srv/sigil/master/install.sh | sh';

function ephemeralPackageRoot(root = PKG_ROOT) {
  // pnpm dlx (and yarn dlx) land under a `…/dlx/<hash>/…` segment.
  if (root.includes(`${sep}dlx${sep}`)) {
    return { ephemeral: true, kind: 'pnpm-dlx', installHint: INSTALL_SH, root };
  }
  // npx caches packages under `…/_npx/<hash>/…`.
  if (root.includes(`${sep}_npx${sep}`)) {
    return { ephemeral: true, kind: 'npx', installHint: INSTALL_SH, root };
  }
  // Anything under the OS temp dir is throwaway (covers other one-shot runners).
  const tmp = tmpdir();
  if (tmp && (root === tmp || root.startsWith(tmp + sep))) {
    return { ephemeral: true, kind: 'temp', installHint: INSTALL_SH, root };
  }
  return { ephemeral: false, root };
}

export const PROMPTS_DIR = join(PKG_ROOT, 'prompts');
export const MIGRATIONS_DIR = join(PKG_ROOT, 'src', 'db', 'migrations');

const HOME = homedir();
export const SIGIL_HOME = join(HOME, '.sigil');
export const SIGIL_ENV_PATH = join(SIGIL_HOME, '.env');
// Device-local config — the single versioned source of truth that replaces
// ~/.sigil/.env (see src/setup/config-store.js). Schema-versioned + validated
// so it can't go stale across upgrades.
export const SIGIL_CONFIG_PATH = join(SIGIL_HOME, 'config.json');
export const SIGIL_DB_PATH = join(SIGIL_HOME, 'db');
export const SIGIL_MD_PATH = join(SIGIL_HOME, 'CLAUDE.md');
export const SIGIL_SCHEMAS_DIR = join(SIGIL_HOME, 'schemas');
export const SIGIL_HOOK_ERRORS_LOG = join(SIGIL_HOME, '.hook-errors.log');
export const SIGIL_LAST_CLEAN_DOCTOR = join(SIGIL_HOME, '.last-clean-doctor');
export const SIGIL_ACTIVE_SESSION_CURSOR = join(SIGIL_HOME, '.active-session.json');
export const SIGIL_STOP_CURSOR = join(SIGIL_HOME, '.stop-cursor.json');
export const SIGIL_STOP_SPOOL = join(SIGIL_HOME, '.stop-spool.jsonl');
export const SIGIL_HOOK_DEDUP = join(SIGIL_HOME, '.hook-dedup.json');

// Daemon
export const SIGIL_DAEMON_SOCK = join(SIGIL_HOME, 'sock');
export const SIGIL_DAEMON_PID  = join(SIGIL_HOME, 'sigild.pid');
export const SIGIL_DAEMON_LOG  = join(SIGIL_HOME, 'sigild.log');
export const SIGIL_HEARTBEAT   = join(SIGIL_HOME, 'heartbeat.json');
// F5 (respawn-storm guard): serializes daemon spawns across concurrent CLI/hook
// processes; records a short cooldown when the daemon is found alive-but-wedged
// so a burst of hooks degrades fast instead of each re-paying the probe cost.
export const SIGIL_SPAWN_LOCK    = join(SIGIL_HOME, '.spawn.lock');
export const SIGIL_DAEMON_BREAKER = join(SIGIL_HOME, '.daemon-breaker.json');

// GUI
export const SIGIL_GUI_TOKEN     = join(SIGIL_HOME, 'gui.token');
export const GUI_WEB_DIR_BUILT   = join(PKG_ROOT, 'dist', 'gui');     // future: minified build
export const GUI_WEB_DIR_DEV     = join(PKG_ROOT, 'src', 'gui', 'web'); // today: vanilla source
// Back-compat alias
export const GUI_WEB_DIR         = GUI_WEB_DIR_BUILT;

// Iroh — persistent node storage (identity + blob store)
export const SIGIL_IROH_DIR      = join(SIGIL_HOME, 'iroh');
export const SIGIL_IDENTITY_KEY  = join(SIGIL_HOME, 'identity.key'); // Ed25519 secret (32 bytes, hex-encoded)

export const CLAUDE_HOME = join(HOME, '.claude');
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_HOME, 'settings.json');
export const CLAUDE_MD_PATH = join(CLAUDE_HOME, 'CLAUDE.md');

export { PKG_ROOT, ephemeralPackageRoot };
