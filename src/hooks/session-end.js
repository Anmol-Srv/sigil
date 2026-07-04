#!/usr/bin/env node
import './_recursion-guard.js'; // fork-bomb backstop (L4) — MUST be the first import

/**
 * SessionEnd hook — closes the active session pod and (if enough facts were
 * gathered) saves a synthesized end-of-session summary.
 *
 * All of that work — synthesis (LLM) + the DB writes — runs in the DAEMON via
 * the `endSession` RPC. The hook is a thin client: it never opens the embedded
 * DB itself (which, in single-process PGlite mode, would abort the WASM engine
 * the daemon holds — finding 6.1). Best-effort: if the daemon is unreachable the
 * `sigil maintain` staleness sweep closes any pod older than 6h as a backstop.
 *
 * Receives on stdin (JSON): { session_id, transcript_path?, summary?, cwd?, ... }
 */

import { loadHookEnv } from './env-loader.js';
import { maskSecrets } from './secret-mask.js';
import { breakerOpen, tripBreaker, resetBreaker } from './daemon-breaker.js';
import { readStdin } from './io.js';

loadHookEnv();

// SessionEnd is async (no user-facing latency). The daemon completes the work
// even if this client call times out, so we bound it generously and never block.
const END_TIMEOUT_MS = 25_000;

async function main() {
  const raw = await readStdin();
  if (!raw) return respond();

  let input;
  try { input = JSON.parse(raw); } catch { return respond(); }
  if (!input.session_id) return respond();

  // Circuit breaker (F5): if a recent hook found the daemon wedged, don't poke it
  // — the `sigil maintain` staleness sweep closes the pod as a backstop.
  if (breakerOpen()) {
    process.stderr.write('[sigil:session-end] daemon breaker open — skipping (maintain sweep will close the pod)\n');
    return respond();
  }

  const { connectOrStartDaemon } = await import('../clients/auto-spawn.js');
  let client;
  try {
    client = await connectOrStartDaemon({ quiet: true, timeoutMs: END_TIMEOUT_MS });
    await client.call('endSession', {
      sessionId: input.session_id,
      cwd: input.cwd || null,
      transcriptPath: input.transcript_path || null,
      summary: input.summary || null,
      conclusion: input.conclusion || null,
    });
    resetBreaker(); // reached the daemon — clear any breaker a prior hook set
  } catch (err) {
    // Best-effort: log only. We never open the DB directly as a fallback, and a
    // missed close self-heals via the `sigil maintain` staleness sweep. An
    // alive-but-wedged daemon trips the breaker so other hooks degrade fast.
    if (err?.name === 'SigilDaemonBusyError') tripBreaker();
    process.stderr.write(`[sigil:session-end] ${maskSecrets(err.message)}\n`);
  } finally {
    if (client) await client.close().catch(() => {});
  }

  return respond();
}

function respond() {
  process.stdout.write('{}');
}

main();
