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
 * Format: one JSON object per line (JSONL), plus an append-only acknowledgement
 * sidecar. Neither replay nor capacity trimming rewrites the live spool, so a
 * concurrent Stop hook append cannot be erased by a rename race.
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { SIGIL_STOP_SPOOL } from '../lib/paths.js';
import { maskSecrets } from './secret-mask.js';

// Cap the spool so a long outage can't grow it unbounded. Oldest entries are
// dropped first (a very old un-replayable message is the least valuable).
const MAX_SPOOL_ENTRIES = 500;
const REPLAY_BATCH_SIZE = 20;
const ACK_PATH = `${SIGIL_STOP_SPOOL}.acked`;

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
      uid: `stop-${randomUUID()}`,
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
    const acked = readAcked();
    return readFileSync(SIGIL_STOP_SPOOL, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((entry) => !acked.has(entryKey(entry)));
  } catch {
    return [];
  }
}

function entryKey(entry) {
  if (entry.uid) return entry.uid;
  return `legacy-${createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 24)}`;
}

function readAcked() {
  if (!existsSync(ACK_PATH)) return new Set();
  try {
    return new Set(readFileSync(ACK_PATH, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function acknowledge(entries) {
  if (!entries.length) return;
  appendFileSync(ACK_PATH, `${entries.map(entryKey).join('\n')}\n`, 'utf8');
}

function trimSpool() {
  const entries = readSpool();
  if (entries.length > MAX_SPOOL_ENTRIES) {
    // Logically discard the oldest entries through the same append-only ACK
    // path used by replay. Rewriting the spool here would reintroduce the exact
    // cross-process race the ACK design removed from drainStopSpool().
    acknowledge(entries.slice(0, entries.length - MAX_SPOOL_ENTRIES));
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

  const { classifyTurns, saveFacts } = await import('./stop-classify.js');

  let drained = 0;
  let replayed = 0;

  for (let offset = 0; offset < entries.length; offset += REPLAY_BATCH_SIZE) {
    const batch = entries.slice(offset, offset + REPLAY_BATCH_SIZE);
    try {
      const classified = await classifyTurns(batch.map((entry) => entry.message));
      const facts = classified.flat();
      if (facts.length) {
        await saveFacts(facts, { podUids: [], throwOnError: true });
        replayed += facts.length;
      }
      // Append-only acknowledgements avoid the old read→rewrite race where a
      // live hook appended a new turn between those steps and the drain's rename
      // silently erased it.
      acknowledge(batch);
      drained += batch.length;
    } catch {
      // Still failing (provider/DB down) → leave every entry unacknowledged.
    }
  }

  return { drained, remaining: readSpool().length, replayed };
}

export { appendSpool, drainStopSpool, spoolCount };
