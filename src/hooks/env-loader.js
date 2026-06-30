// Hook process bootstrap. config.json is the single source of truth (loaded
// lazily by config.js → config-store), so we no longer load any .env file here.
// The only thing this still does is stamp agent provenance for the in-process
// hook path: hooks import the memory code directly and bypass the daemon, so
// currentAgent() reads SIGIL_AGENT from the process env rather than the
// per-request ALS. (SIGIL_AGENT is process-identity, not config — see the
// bootstrap allowlist in src/config.js.)
export function loadHookEnv() {
  if (!process.env.SIGIL_AGENT) process.env.SIGIL_AGENT = 'claude-code';
}
