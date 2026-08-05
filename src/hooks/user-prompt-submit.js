#!/usr/bin/env node

/**
 * UserPromptSubmit hook — injects relevant Sigil facts into Claude's context.
 *
 * Reads the user's prompt from stdin (JSON from Claude Code), asks the DAEMON
 * to search (it owns the DB), and returns the top facts as additionalContext.
 *
 * Why route through the daemon (Phase A of the daemon-routing refactor):
 * the embedded store (PGlite) is single-process — the daemon holds it. The old
 * behavior opened the DB directly in this per-turn hook process, which aborted
 * the WASM engine on every prompt in embedded mode (`Aborted(). Build with
 * -sASSERTIONS`), so memory injection silently failed. The daemon is now the
 * sole DB owner; this hook is a thin client over the `search` RPC.
 *
 * Budget discipline: Claude gives this hook ~10s. We bound the whole
 * connect+search to OVERALL_DEADLINE_MS and, on timeout / no daemon / any
 * error, inject NOTHING rather than blocking the prompt. We never fall back to
 * opening the DB directly (the bug we're fixing) and never fall back to the
 * global brain (that was the cross-project leak).
 */

import { maskSecrets } from './secret-mask.js';
import { recordHookError, failClosedOnBadConfig } from './error-log.js';
import { breakerOpen, tripBreaker, resetBreaker } from './daemon-breaker.js';
import { readStdin } from './io.js';
import { promptText } from './prompt-input.js';

if (!process.env.SIGIL_AGENT) process.env.SIGIL_AGENT = 'claude-code';

const MIN_QUERY_LENGTH = 8;
const MAX_FACTS = 20;
const INJECTION_BUDGET_CHARS = 4800; // ~1200 tokens
// Keep the whole connect+search comfortably under Claude's ~10s hook budget.
// A warm daemon answers in well under 1s; the headroom is for a cold embedder
// (e.g. first Ollama embed after model unload). OVERALL_DEADLINE_MS is the hard
// skip-inject ceiling; CALL_TIMEOUT_MS sits at it so the overall deadline (a
// soft skip) governs rather than the per-call timeout.
const CALL_TIMEOUT_MS = 8_000;
const OVERALL_DEADLINE_MS = 9_000;

const TIMEOUT = Symbol('timeout');
// Only emitted by `sigil doctor --deep`'s synthetic hook invocation. It proves
// that the hook reached the daemon and completed a search without putting a
// real prompt or recalled fact in any observability ledger.
export const HOOK_VERIFY_MARKER = 'sigil-hook-verify: daemon search completed';

function withDeadline(ms, promise) {
  let timer;
  const deadline = new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), ms); timer.unref?.(); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Ask the daemon to search. The daemon is the sole DB owner, so this is safe in
// embedded (single-process PGlite) mode. Returns the search response or throws.
async function searchViaDaemon(query) {
  const { connectOrStartDaemon } = await import('../clients/auto-spawn.js');
  let client;
  try {
    client = await connectOrStartDaemon({ quiet: true, timeoutMs: CALL_TIMEOUT_MS });
    const { data } = await client.call('search', {
      query,
      limit: MAX_FACTS,
      applyFloor: true,   // precision-first: drop off-topic matches (auto-injection)
      // Runtime-only evidence for the Agents page. This never writes the
      // prompt, matching facts, or a database trace. Verification probes opt
      // out so `doctor --deep` cannot fake a real Codex/Claude recall event.
      observePromptRecall: process.env.SIGIL_HOOK_VERIFY !== '1',
      // namespaces omitted on purpose — the daemon resolves its own default
      // namespace, which is the authoritative one.
    });
    return data;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function main() {
  const raw = await readStdin();
  if (!raw) return respond();

  const input = JSON.parse(raw);
  const query = promptText(input);

  // Skip short/trivial prompts.
  if (query.length < MIN_QUERY_LENGTH) return respond();

  // Config gate — fast-bail before touching the daemon if config is
  // known-broken, writing a specific fix to .hook-errors.log.
  if (await failClosedOnBadConfig('user-prompt-submit', raw)) return respond();

  // Circuit breaker (F5): a recent hook found the daemon wedged. Skip the daemon
  // entirely for the cooldown rather than re-paying the probe on every prompt —
  // that pile-on is what caused the CPU storm. The user's prompt proceeds
  // without memory injection during the short cooldown.
  if (breakerOpen()) {
    process.stderr.write('[sigil:user-prompt-submit] daemon breaker open — skipping injection\n');
    return respond();
  }

  let data;
  try {
    data = await withDeadline(OVERALL_DEADLINE_MS, searchViaDaemon(query));
  } catch (err) {
    // Classify. A handler-level error (SigilRpcError — e.g. a broken embedding
    // config) means recall is BROKEN: record it so `sigil doctor` can tell
    // "broken" from "quiet". An alive-but-wedged daemon (SigilDaemonBusyError)
    // trips the breaker so the next prompts skip fast. A timeout or transient
    // transport error (slow / a briefly-down daemon) is NOT broken — stderr only,
    // don't pollute the error budget. Either way the prompt proceeds; we NEVER
    // open the DB directly (the abort we removed).
    if (err?.name === 'SigilDaemonBusyError') tripBreaker();
    const broken = err?.name === 'SigilRpcError';
    process.stderr.write(`[sigil:user-prompt-submit] daemon search ${broken ? 'error' : 'unavailable'}: ${maskSecrets(err.message)}\n`);
    if (broken) await recordHookError('user-prompt-submit', err, raw).catch(() => {});
    return respond();
  }

  // Reached the daemon — clear any breaker a prior hook left open.
  resetBreaker();

  if (data === TIMEOUT) {
    // Budget exceeded (e.g. cold daemon start). Soft skip — NOT an error, so it
    // doesn't pollute the error budget. Better a fast prompt than a hung one.
    process.stderr.write('[sigil:user-prompt-submit] search exceeded budget — skipping injection\n');
    return respond();
  }

  // An empty hook response is intentionally fail-safe in a real agent turn,
  // but it is not enough evidence for a diagnostic. Make the synthetic deep
  // check unambiguous: only a completed daemon search gets this marker.
  if (process.env.SIGIL_HOOK_VERIFY === '1') return respond(HOOK_VERIFY_MARKER);

  const facts = data?.facts || [];
  // An empty result is precision-correct, not an error.
  if (!facts.length) return respond();

  // Token budget — take facts in score order until the cumulative char count
  // would exceed budget; always take at least one (some signal beats none).
  const chosen = [];
  let used = 0;
  for (const f of facts) {
    const len = (f.content || '').length + 4; // "- " prefix + newline
    if (chosen.length > 0 && used + len > INJECTION_BUDGET_CHARS) break;
    chosen.push(f);
    used += len;
  }

  const context = maskSecrets([
    `Sigil memory (${chosen.length} relevant facts):`,
    ...chosen.map((f) => `- ${f.content}`),
  ].join('\n'));

  return respond(context);
}

function respond(additionalContext) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      ...(additionalContext && { additionalContext }),
    },
  };
  // Flush, then force-exit: a daemon socket / pending call timer could otherwise
  // keep the event loop alive past our work. The hook's job ends at this write.
  process.stdout.write(JSON.stringify(output), () => process.exit(0));
}

main().catch((err) => {
  // Last-resort guard: never block Claude. Best-effort log, empty response.
  try { process.stderr.write(`[sigil:user-prompt-submit] fatal: ${maskSecrets(err?.message || String(err))}\n`); } catch { /* */ }
  respond();
});
