/**
 * llmLog — persist an LLM cost/usage row on behalf of a CLI/hook process.
 *
 * The embedded engine is single-process: only the daemon may open it, so a
 * CLI/hook process (the stop-hook classifier, a doctor provider probe) can't
 * write its own llm_log row directly. It sends the row here instead (B6.8 /
 * field-report Defect 6 follow-up), so per-turn LLM cost tracking isn't lost in
 * embedded mode. Best-effort: the caller fire-and-forgets and never blocks on us.
 */
import cortexDb from '../../db/cortex.js';

export function registerLlmLog(registry) {
  registry.register('llmLog', async (row = {}) => {
    await cortexDb('llm_log').insert({
      provider: row.provider,
      model: row.model,
      caller: row.caller,
      // Re-clamp defensively; the client already sliced, but never trust size.
      input: row.input?.slice(0, 10000),
      response: row.response?.slice(0, 10000),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cost: row.cost,
      durationMs: row.durationMs,
      status: row.status,
      error: row.error?.slice(0, 2000),
    });
    return { ok: true };
  });
}
