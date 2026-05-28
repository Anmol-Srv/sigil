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
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

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

export const PROMPTS_DIR = join(PKG_ROOT, 'prompts');
export const MIGRATIONS_DIR = join(PKG_ROOT, 'src', 'db', 'migrations');

const HOME = homedir();
export const SIGIL_HOME = join(HOME, '.sigil');
export const SIGIL_ENV_PATH = join(SIGIL_HOME, '.env');
export const SIGIL_DB_PATH = join(SIGIL_HOME, 'db');
export const SIGIL_MD_PATH = join(SIGIL_HOME, 'CLAUDE.md');
export const SIGIL_SCHEMAS_DIR = join(SIGIL_HOME, 'schemas');
export const SIGIL_HOOK_ERRORS_LOG = join(SIGIL_HOME, '.hook-errors.log');
export const SIGIL_LAST_CLEAN_DOCTOR = join(SIGIL_HOME, '.last-clean-doctor');
export const SIGIL_ACTIVE_SESSION_CURSOR = join(SIGIL_HOME, '.active-session.json');
export const SIGIL_STOP_CURSOR = join(SIGIL_HOME, '.stop-cursor.json');
export const SIGIL_HOOK_DEDUP = join(SIGIL_HOME, '.hook-dedup.json');

// Daemon
export const SIGIL_DAEMON_SOCK = join(SIGIL_HOME, 'sock');
export const SIGIL_DAEMON_PID  = join(SIGIL_HOME, 'sigild.pid');
export const SIGIL_DAEMON_LOG  = join(SIGIL_HOME, 'sigild.log');

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

export { PKG_ROOT };
