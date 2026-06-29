/**
 * ingestTurn — the Stop hook's write path, run inside the daemon.
 *
 * The Stop hook classifies a turn into facts (an LLM call — no DB) hook-side,
 * then hands the facts here so the daemon (the sole DB owner) does the database
 * work: resolve the active session/project pods and save each fact through the
 * AUDM pipeline with pod attachment. This is the same `ensureActivePodsForHook`
 * + `saveFacts` the spool replayer (`drainStopSpool`) already runs in-daemon, so
 * there is exactly one save path — no drift between live, replay, and RPC.
 *
 * Moving this off the hook process is what fixes the embedded single-process
 * conflict: a per-turn hook opening PGlite while the daemon holds it aborts the
 * WASM engine (finding 6.1). Now nothing but the daemon touches the DB.
 */
export function registerIngestTurn(registry) {
  registry.register('ingestTurn', async (params = {}) => {
    const facts = Array.isArray(params.facts) ? params.facts.filter(Boolean) : [];
    if (facts.length === 0) return { saved: 0, podUids: 0 };

    // Resolve the active pods (session + project today). Best-effort: if pod
    // dispatch fails, still save the facts to the namespace (attached to none)
    // rather than dropping memorable content.
    let podUids = [];
    try {
      const { ensureActivePodsForHook } = await import('../../memory/pods/hook-dispatcher.js');
      const dispatch = await ensureActivePodsForHook({
        sessionId: params.sessionId || null,
        cwd: params.cwd || null,
        transcriptPath: params.transcriptPath || null,
      });
      podUids = dispatch.podUids || [];
    } catch (err) {
      // Surface in the daemon log; the save below still runs.
       
      console.error(`[ingestTurn] pod dispatch failed: ${err.message}`);
    }

    // saveFacts runs the AUDM ingest (classify:false — the hook already did it)
    // with pod attachment, then refreshes the hot-context snapshot. throwOnError
    // so a save failure reaches the hook, which spools the turn for replay.
    const { saveFacts } = await import('../../hooks/stop-classify.js');
    await saveFacts(facts, { podUids, throwOnError: true });

    return { saved: facts.length, podUids: podUids.length };
  });
}
