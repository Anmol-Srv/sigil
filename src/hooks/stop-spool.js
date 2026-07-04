/**
 * Stop-hook save-spool — durability for memorable content the live hook
 * couldn't save.
 *
 * The Stop hook must never block Claude, so when classification or saving
 * fails (LLM provider down, DB unreachable, embedder outage), it can't retry
 * inline. Instead it appends the raw (masked) user message here. `drainStopSpool`
 * replays the spool through the same classify+save path once the system is
 * healthy — at daemon boot and from `sigil doctor`/`sigil repair`. Without this,
 * a provider outage silently dropped every memorable turn with no recovery.
 *
 * Format: one JSON object per line (JSONL). Append-only on write; rewritten
 * (tmp + rename) on drain to drop the entries that succeeded.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { SIGIL_STOP_SPOOL } from '../lib/paths.js';
import { maskSecrets } from './secret-mask.js';

// Cap the spool so a long outage can't grow it unbounded. Oldest entries are
// dropped first (a very old un-replayable message is the least valuable).
const MAX_SPOOL_ENTRIES = 500;

/**
 * Append a failed turn to the spool. Best-effort and synchronous — the hook is
 * about to exit, so we can't rely on async flushing. Message is masked here as
 * a defense-in-depth (callers already mask for logging).
 */
function appendSpool({ message, sessionId = null, cwd = null, transcriptPath = null, reason = 'unknown' }) {
  if (!message) return;
  try {
    mkdirSync(dirname(SIGIL_STOP_SPOOL), { recursive: true });
    const entry = {
      message: maskSecrets(message),
      sessionId,
      cwd,
      transcriptPath,
      reason,
      ts: Date.now(),
    };
    appendFileSync(SIGIL_STOP_SPOOL, `${JSON.stringify(entry)}\n`, 'utf8');
    trimSpool();
  } catch { /* best effort — never throw from the hook */ }
}

function readSpool() {
  if (!existsSync(SIGIL_STOP_SPOOL)) return [];
  try {
    return readFileSync(SIGIL_STOP_SPOOL, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeSpool(entries) {
  const tmp = `${SIGIL_STOP_SPOOL}.tmp`;
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  renameSync(tmp, SIGIL_STOP_SPOOL);
}

function trimSpool() {
  const entries = readSpool();
  if (entries.length > MAX_SPOOL_ENTRIES) {
    writeSpool(entries.slice(entries.length - MAX_SPOOL_ENTRIES));
  }
}

/** How many turns are waiting to be replayed (for doctor/status). */
function spoolCount() {
  return readSpool().length;
}

/**
 * Replay spooled turns through classify + save. Runs in the daemon (boot) or
 * CLI (doctor/repair), NOT in the hook. Entries that replay successfully are
 * removed; entries that still fail stay for the next attempt. Replayed facts
 * save to the default namespace (the original session pod may be long gone) —
 * recovering the fact globally beats losing it.
 *
 * @returns {Promise<{drained:number, remaining:number, replayed:number}>}
 */
async function drainStopSpool() {
  const entries = readSpool();
  if (!entries.length) return { drained: 0, remaining: 0, replayed: 0 };

  const { classifyTurn, saveFacts } = await import('./stop-classify.js');

  const survivors = [];
  let drained = 0;
  let replayed = 0;

  for (const entry of entries) {
    try {
      const facts = await classifyTurn(entry.message);
      if (facts.length) {
        await saveFacts(facts, { podUids: [], throwOnError: true, cwd: entry.cwd || null });
        replayed += facts.length;
      }
      // Success (saved, or genuinely not memorable) → drop from spool.
      drained++;
    } catch {
      // Still failing (provider/DB down) → keep for the next drain.
      survivors.push(entry);
    }
  }

  writeSpool(survivors);
  return { drained, remaining: survivors.length, replayed };
}

export { appendSpool, drainStopSpool, spoolCount };
