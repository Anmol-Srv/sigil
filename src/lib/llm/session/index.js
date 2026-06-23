/**
 * Process-wide holder + init for the managed-session engine.
 *
 * Exactly one SessionManager lives in the daemon process (the sole owner of the
 * warm tmux workers). The managed-session provider reads it via
 * getSessionManager(); the daemon boot wires + starts it via
 * initSessionManager(). Non-daemon processes (hooks, CLI) never hold a manager —
 * their managed-session provider calls fall straight through to the one-shot
 * path. Mirrors src/daemon/registry-holder.js.
 */
import { createTmux } from './tmux.js';
import { getDriver, supportedSourceTypes } from './drivers/index.js';
import { SessionManager } from './manager.js';

let current = null;          // the daemon's SessionManager (or null)
let healthTimer = null;

export function getSessionManager() { return current; }
export function setSessionManager(m) { current = m; }

/**
 * One-shot fallback for a task of a given source type. v1 only drives `claude`,
 * whose fallback is the existing one-shot claude-cli provider — i.e. exactly
 * today's behavior, so the managed engine can never be worse than the status quo.
 */
async function fallbackFor(task) {
  const { chat } = await import('../providers/claude-cli.js');
  return chat(task.prompt, { model: task.model, jsonMode: !!task.schema });
}

/**
 * Build, start, and register the manager — called once at daemon boot. Returns
 * the manager, or null if managed sessions are disabled / unavailable (no tmux),
 * in which case provider calls transparently use the one-shot path.
 *
 * @param {object} opts  { config, log }
 */
export async function initSessionManager({ config, log = () => {} } = {}) {
  const ms = config?.llm?.managedSession;
  if (!ms?.enabled) { log('managed-session: disabled'); return null; }

  const tmux = createTmux();
  if (!(await tmux.available())) {
    log('managed-session: tmux not found on PATH — staying on one-shot path');
    return null;
  }

  // v1 drives only the configured LLM provider when it is claude-cli; other
  // providers (api keys) don't need warm sessions. The pool is keyed by source
  // type; today that's 'claude'.
  const provider = config.llm.provider || '';
  if (provider && provider !== 'claude-cli') {
    log(`managed-session: provider is "${provider}" (not claude-cli) — staying on one-shot path`);
    return null;
  }

  const { SIGIL_HOME, PKG_ROOT } = await import('../../paths.js');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');

  const pools = {};
  for (const sourceType of supportedSourceTypes()) {
    pools[sourceType] = ms.poolSize;
    if (config.llm.cliModel) pools[`${sourceType}:model`] = config.llm.cliModel;
  }

  // Resolve the worker MCP server entry. PKG_ROOT is bundle-stable; prefer the
  // built dist/ entry (production) and fall back to the src/ file (dev runs from
  // source). Computed HERE, not from a driver's import.meta.url — that file is
  // bundled away in production and would resolve wrong.
  const distEntry = join(PKG_ROOT, 'dist', 'mcp', 'worker-server.js');
  const srcEntry = join(PKG_ROOT, 'src', 'mcp', 'worker-server.js');
  const workerServer = {
    command: process.execPath,
    args: [existsSync(distEntry) ? distEntry : srcEntry],
  };

  const manager = new SessionManager({
    tmux,
    getDriver,
    fallback: fallbackFor,
    scratchDir: join(SIGIL_HOME, 'sessions'),
    pools,
    workerServer,
    tokenBudget: ms.tokenBudget,
    taskTimeoutMs: ms.taskTimeoutMs,
    firstTaskTimeoutMs: ms.firstTaskTimeoutMs,
    log,
  });

  await manager.start();
  setSessionManager(manager);

  // Active health sweep — recycle a worker wedged on an auth/trust dialog before
  // its dead-man timeout fires. unref'd so it never holds the process open.
  healthTimer = setInterval(() => { manager.probeHealth().catch(() => {}); }, ms.healthProbeMs);
  healthTimer.unref?.();

  log(`managed-session: started (${supportedSourceTypes().join(',')} × ${ms.poolSize}, budget=${ms.tokenBudget})`);
  return manager;
}

/** Stop the manager + health sweep. Called from the daemon shutdown hook. */
export async function shutdownSessionManager() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (current) { await current.stop().catch(() => {}); current = null; }
}
