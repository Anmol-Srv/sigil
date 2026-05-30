import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';

import { SIGIL_ENV_PATH } from '../lib/paths.js';

// Env precedence: shell > project .env > global ~/.sigil/.env.
// dotenv preserves first-loaded keys, so loading project FIRST gives it
// priority; global then fills in keys the project didn't set. Matches
// src/cli.js — fixes the bug where a project .env without EMBEDDING_*
// values used to shadow the global config entirely.
export function loadHookEnv() {
  const localEnv = resolve(process.cwd(), '.env');
  if (existsSync(localEnv)) dotenvConfig({ path: localEnv, quiet: true });
  if (existsSync(SIGIL_ENV_PATH) && SIGIL_ENV_PATH !== localEnv) {
    dotenvConfig({ path: SIGIL_ENV_PATH, quiet: true });
  }
  // Agent provenance for the in-process hook path (hooks import the memory
  // code directly and bypass the daemon, so currentAgent() reads this env
  // var rather than the per-request ALS). These are Claude Code hooks; an
  // explicitly-set value still wins.
  if (!process.env.SIGIL_AGENT) process.env.SIGIL_AGENT = 'claude-code';
}
