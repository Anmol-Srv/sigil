// Hook process bootstrap. config.json is the single source of truth (loaded
// lazily by config.js → config-store), so we no longer load any .env file here.
// The only thing this still does is stamp agent provenance: SIGIL_AGENT is sent
// with every daemon request, so recall and saves are attributed to the agent
// whose hook made them. The agent comes from `--agent=<id>` on the hook command
// line (written by each connector); entries without it are Claude Code's.
// (SIGIL_AGENT is process-identity, not config — see the bootstrap allowlist in
// src/config.js.)
import { hookAgent } from './host.js';

export function loadHookEnv() {
  process.env.SIGIL_AGENT = hookAgent();
}
