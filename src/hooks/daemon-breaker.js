/**
 * Hook circuit breaker (F5).
 *
 * When a hook discovers the daemon is alive-but-wedged (SigilDaemonBusyError),
 * hammering it on every subsequent prompt is what turned one stuck daemon into a
 * CPU storm. So the first hook to hit it trips a short, shared cooldown: every
 * hook (user-prompt-submit, stop, session-end) checks the breaker first and, if
 * it's open, degrades immediately — skip injection, spool the save — without
 * re-paying the connect/probe cost. The window is short and self-healing: after
 * it expires the next hook probes again and either reconnects (and resets the
 * breaker) or re-trips it. The breaker is a single file shared across all hook
 * processes on the machine, so one trip protects them all.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

import { SIGIL_DAEMON_BREAKER } from '../lib/paths.js';

// Long enough that a burst of rapid prompts all skip instead of piling onto a
// wedged daemon; short enough that a daemon that recovers is picked back up
// quickly. A wedged query-router in the field report held for tens of seconds.
const COOLDOWN_MS = 20_000;

// The path is injectable so tests can use a temp file instead of the real
// ~/.sigil breaker (which the live daemon's hooks read).

/** True if the breaker is open (daemon recently found wedged) — callers skip. */
export function breakerOpen(now = Date.now(), path = SIGIL_DAEMON_BREAKER) {
  try {
    const { until } = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isFinite(until) && now < until;
  } catch {
    return false; // no breaker / unreadable — treat as closed
  }
}

/** Open the breaker: skip daemon calls for COOLDOWN_MS. Best-effort. */
export function tripBreaker(now = Date.now(), path = SIGIL_DAEMON_BREAKER) {
  try {
    writeFileSync(path, JSON.stringify({ until: now + COOLDOWN_MS, ts: now }));
  } catch { /* best-effort — a missing breaker just means we probe next time */ }
}

/** Close the breaker after a successful call. Best-effort. */
export function resetBreaker(path = SIGIL_DAEMON_BREAKER) {
  try { unlinkSync(path); } catch { /* already closed */ }
}

export const BREAKER_COOLDOWN_MS = COOLDOWN_MS;
