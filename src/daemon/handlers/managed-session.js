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
}
