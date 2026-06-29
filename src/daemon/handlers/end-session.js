/**
 * endSession — the SessionEnd hook's logic, run inside the daemon.
 *
 * The hook must not open the embedded DB while the daemon holds it (single-process
 * PGlite → WASM abort, finding 6.1). So SessionEnd is now a thin client: it
 * forwards { sessionId, cwd, transcriptPath, summary, conclusion } here and the
 * daemon (sole DB owner) does the work — synthesize a durable end-of-session
 * summary fact (LLM + DB), then close the active session pod. If the cursor
 * doesn't match the session that stopped, it's a no-op (the `sigil maintain`
 * staleness sweep closes any pod older than 6h as a backstop).
 */
const MIN_FACTS_TO_SYNTHESIZE = 3;
const MAX_FACTS_IN_PROMPT = 40;

export function registerEndSession(registry) {
  registry.register('endSession', async (params = {}) => {
    const sessionId = params.sessionId;
    if (!sessionId) return { closed: false, reason: 'no-session-id' };

    const { endActiveSession, getActiveCursor } = await import('../../memory/pods/active-session.js');
    const cursor = await getActiveCursor();
    // Only act if the cursor matches the session that just stopped.
    if (!cursor || cursor.session_id !== sessionId) return { closed: false, reason: 'cursor-mismatch' };

    // Synthesize BEFORE closing the pod. Best-effort — a synthesis failure must
    // not block the close (the session still ends cleanly).
    let synthesized = false;
    try {
      synthesized = await synthesizeSummary({
        sessionPodUid: cursor.pod_uid,
        cwd: params.cwd || cursor.cwd || null,
        sessionId,
        transcriptPath: params.transcriptPath || cursor.transcript_path || null,
      });
    } catch (err) {
       
      console.error(`[endSession] synthesis failed: ${err.message}`);
    }

    await endActiveSession({
      conclusion: params.summary || params.conclusion || null,
      summary: params.summary || null,
    });
    return { closed: true, synthesized };
  });
}

/** Synthesize a one-fact session summary and save it via the ingest pipeline. */
async function synthesizeSummary({ sessionPodUid, cwd, sessionId, transcriptPath }) {
  if (!sessionPodUid) return false;

  const podStore = await import('../../memory/pods/store.js');
  const podMembership = await import('../../memory/pods/membership.js');
  const sessionPod = await podStore.findByUid(sessionPodUid);
  if (!sessionPod) return false;

  const memberRows = await podMembership.listMembers(sessionPod.id, {
    memberType: 'fact',
    limit: MAX_FACTS_IN_PROMPT,
  });
  if (memberRows.length < MIN_FACTS_TO_SYNTHESIZE) return false;

  const factTexts = memberRows
    .map((r) => r.content || r.fact_content || r.factContent)
    .filter(Boolean);
  if (factTexts.length < MIN_FACTS_TO_SYNTHESIZE) return false;

  const { promptJson } = await import('../../lib/llm.js');
  const { get, getSchemaDoc } = await import('../../memory/pods/registry.js');
  await import('../../memory/pods/kinds/index.js'); // ensure registered

  const kind = get('claude_session');
  const schemaDoc = (await getSchemaDoc(kind)) || '';

  const prompt = [
    'You are writing the durable end-of-session summary for a Claude Code session.',
    '',
    'Schema guide (how to write facts for the claude_session kind):',
    schemaDoc.slice(0, 2000),
    '',
    'Session facts gathered during this session:',
    factTexts.map((f, i) => `  ${i + 1}. ${f}`).join('\n'),
    '',
    'Write ONE summary fact (60-220 chars) that captures the single most useful thing a future session in the same project would want to know about this one. Past tense. Specific. No filler. Do not repeat individual facts verbatim — synthesize the essence.',
    '',
    'Return JSON: { "summary": "<one-line summary fact>", "topics": ["...", "..."] }',
  ].join('\n');

  let out;
  try {
    out = await promptJson(prompt, { caller: 'session-end-synth' });
  } catch {
    return false;
  }
  const summary = typeof out?.summary === 'string' ? out.summary.trim() : null;
  if (!summary || summary.length < 30) return false;

  // Attach the summary to all active kinds' pods (session + project — the
  // project pod keeps the durable copy). classify:false: we already have the
  // final fact text, so skip the LLM extractor inside the pipeline.
  const { ensureActivePodsForHook } = await import('../../memory/pods/hook-dispatcher.js');
  const { podUids } = await ensureActivePodsForHook({ sessionId, cwd, transcriptPath });

  const { ingestDocument } = await import('../../ingestion/pipeline.js');
  const { default: config } = await import('../../config.js');

  await ingestDocument({
    content: summary,
    namespace: config.defaults.namespace,
    classify: false,
    podUids,
  });
  return true;
}
