/**
 * managed-session provider — routes an LLM call to a WARM tmux worker when the
 * daemon's SessionManager is up, and transparently falls through to the one-shot
 * `claude-cli` path otherwise.
 *
 * It is an INTERNAL provider: users never pick it in `sigil init`. llm.js swaps
 * a resolved `claude-cli` provider for this one when SIGIL_MANAGED_SESSION=true,
 * so "selecting Claude Code as the driver" automatically gets warm sessions
 * where they help (inside the daemon, where ingest runs) and the proven one-shot
 * path everywhere else (hooks, CLI, no-tmux hosts).
 *
 *   chat() ─┬─ manager present + has workers → manager.submit()  (warm)
 *           └─ otherwise                      → claude-cli.chat() (one-shot)
 *
 * The manager's OWN fallback also calls claude-cli.chat(), so there is exactly
 * one one-shot implementation and no recursion.
 */
const SOURCE_TYPE = 'claude';

async function chat(input, { model, jsonMode = false, schema, temperature, caller } = {}) {
  const { getSessionManager } = await import('../session/index.js');
  const mgr = getSessionManager();

  if (mgr && mgr.hasWorkers(SOURCE_TYPE)) {
    const r = await mgr.submit({ sourceType: SOURCE_TYPE, prompt: input, model, schema, caller });
    return {
      text: r.text,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      model: r.model || model || null,
      cost: r.cost || 0,
      // Correlation for llm_log + the kind='engine' trace. workerId is null when
      // the warm engine bailed to one-shot (viaFallback).
      workerId: r.workerId ?? null,
      reqId: r.reqId ?? null,
      viaFallback: r.viaFallback ?? false,
    };
  }

  // No warm manager in this process (non-daemon caller, disabled, or no tmux):
  // use the proven one-shot path. Same provider the manager falls back to.
  const { chat: oneShot } = await import('./claude-cli.js');
  return oneShot(input, { model, jsonMode, schema, temperature });
}

// Internal provider — never surfaced in the `sigil init` picker (registry.js
// filters it out of listProvidersForSetup). meta/setup kept minimal for contract
// parity in case it is ever iterated.
const meta = {
  id: 'managed-session',
  label: 'Claude Code (managed session)',
  hint: 'internal — warm tmux worker routing for claude-cli',
  internal: true,
};

async function setup() {
  return { env: {} };
}

export { chat, meta, setup };
