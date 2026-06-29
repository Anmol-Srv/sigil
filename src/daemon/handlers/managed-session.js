/**
 * Daemon RPC for the managed-session worker channel.
 *
 * The worker MCP server (src/mcp/worker-server.js) calls these two methods over
 * the daemon socket; they forward to the in-process SessionManager that owns the
 * warm workers. Split out here so worker callbacks travel the same RPC registry
 * as every other daemon method.
 *
 *   worker → get_task      → managedSession.getTask    → manager.getTask()
 *   worker → submit_result → managedSession.submitResult → manager.submitResult()
 *
 * If no manager is running (managed sessions disabled), getTask reports empty and
 * submitResult is a no-op — a stray worker callback can never throw the daemon.
 */
export function registerManagedSession(registry) {
  registry.register('managedSession.getTask', async ({ workerId } = {}) => {
    const { getSessionManager } = await import('../../lib/llm/session/index.js');
    const mgr = getSessionManager();
    if (!mgr) return { empty: true };
    return mgr.getTask(workerId);
  });

  registry.register('managedSession.submitResult', async ({ workerId, reqId, result } = {}) => {
    const { getSessionManager } = await import('../../lib/llm/session/index.js');
    const mgr = getSessionManager();
    if (!mgr) return { ok: true, noManager: true };
    return mgr.submitResult(workerId, reqId, result);
  });

  // engine.status — live snapshot for the GUI Engine view. Reports config +
  // whether the warm engine is actually running, plus per-worker state. When
  // disabled / no tmux / wrong provider, `running` is false and the GUI shows
  // the one-shot empty state. Read-only; safe to poll.
  registry.register('engine.status', async () => {
    const { getSessionManager } = await import('../../lib/llm/session/index.js');
    const { default: config } = await import('../../config.js');
    const ms = config.llm.managedSession;

    let tmuxAvailable = false;
    try {
      const { createTmux } = await import('../../lib/llm/session/tmux.js');
      tmuxAvailable = await createTmux().available();
    } catch { /* tmux probe best-effort */ }

    const mgr = getSessionManager();
    const stats = mgr ? mgr.stats() : { workers: [], queued: {}, pending: 0 };
    return {
      enabled: ms.enabled,
      running: !!mgr,
      provider: config.llm.provider || null,
      tmuxAvailable,
      poolSize: ms.poolSize,
      tokenBudget: ms.tokenBudget,
      sessionPrefix: 'sigil-',
      ...stats,
    };
  });
}
