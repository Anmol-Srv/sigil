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
    let facts = Array.isArray(params.facts) ? params.facts.filter(Boolean) : [];

    // Two entry points, one save path.
    //
    // Claude Code's Stop hook classifies in the HOOK process (it already has
    // the turn, and doing the LLM call there keeps the daemon free) and posts
    // finished facts. Hermes is a Python plugin that cannot run our classifier,
    // so it posts the raw turn and the daemon classifies. Both converge on the
    // saveFacts call below — the alternative, a second write path for Hermes,
    // is how `remember` ended up bypassing pods and extraction in the first
    // place.
    if (!facts.length && params.userMessage) {
      const { classifyTurn } = await import('../../hooks/stop-classify.js');
      try {
        facts = (await classifyTurn(String(params.userMessage))) || [];
      } catch (err) {
        console.error(`[ingestTurn] classify failed: ${err.message}`);
        return { saved: 0, podUids: 0, classified: 0, error: 'classify_failed' };
      }
    }

    if (facts.length === 0) return { saved: 0, podUids: 0, classified: 0 };

    // Resolve the active pods (session + project today). Best-effort: if pod
    // dispatch fails, still save the facts to the namespace (attached to none)
    // rather than dropping memorable content.
    let podUids = [];
    try {
      // A Hermes profile is its own durable scope and has no cwd, so it does
      // not go through the session/project dispatcher at all.
      if (params.profile) {
        const { ensureHermesProfilePod } = await import('../../memory/pods/kinds/hermes_profile.js');
        const pod = await ensureHermesProfilePod({
          profile: params.profile,
          hermesHome: params.hermesHome || null,
          platform: params.platform || null,
          namespace: params.namespace || null,
        });
        podUids = pod ? [{ uid: pod.uid, role: 'primary' }] : [];
      } else {
        const { ensureActivePodsForHook } = await import('../../memory/pods/hook-dispatcher.js');
        const dispatch = await ensureActivePodsForHook({
          sessionId: params.sessionId || null,
          cwd: params.cwd || null,
          transcriptPath: params.transcriptPath || null,
        });
        podUids = dispatch.podUids || [];
      }
    } catch (err) {
      // Surface in the daemon log; the save below still runs.
       
      console.error(`[ingestTurn] pod dispatch failed: ${err.message}`);
    }

    // saveFacts uses the atomic batch lane (the hook already classified) and
    // owns only short admission/commit locks. throwOnError lets the hook spool
    // the turn if embedding or persistence genuinely fails.
    const { saveFacts } = await import('../../hooks/stop-classify.js');
    await saveFacts(facts, { podUids, namespace: params.namespace || null, throwOnError: true });

    return { saved: facts.length, podUids: podUids.length, classified: facts.length };
  });
}
