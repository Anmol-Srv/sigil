/**
 * trace-store — persist + broadcast the causal trace of daemon operations.
 *
 * recordTrace() does two things:
 *   1. INSERTs a durable row into trace_event (queryable history)
 *   2. emits a compact `trace` event on the bus (live Activity feed)
 *
 * It is deliberately best-effort: a tracing failure must never break the
 * operation being traced, so every DB/bus error is swallowed (logged to
 * stderr only). Callers can `await recordTrace(...)` or fire-and-forget.
 */
import { nanoid } from 'nanoid';

import cortexDb from '../db/cortex.js';
import bus from './events.js';
import { currentRequestContext, currentAgent } from './request-context.js';

// Keep individual trace payloads bounded so a pathological search (hundreds
// of candidates) can't bloat a row or the WS frame. Detail is already
// shaped/capped by callers; this is a backstop.
const MAX_DETAIL_BYTES = 256 * 1024;
const MAX_TRACE_ROWS = 1_000;
const PRUNE_EVERY_WRITES = 100;
let writesSincePrune = 0;

function provenance() {
  // request-context (AsyncLocalStorage) is populated by rpc-registry.dispatch
  // around each handler: { device, transport, agent }. Local in-process calls
  // (and tests) get null. `agent` answers "who made this call" — currentAgent()
  // also falls back to SIGIL_AGENT for in-process callers (the hooks).
  const ctx = currentRequestContext();
  return {
    transport: ctx?.transport ?? null,
    agent: currentAgent(),
  };
}

/**
 * @param {object} p
 * @param {string} p.kind        'search' | 'ingest' | 'lifecycle' | ...
 * @param {string} p.summary     one-line human description
 * @param {object} [p.detail]    structured causal trace (jsonb)
 * @param {string} [p.namespace]
 * @param {number} [p.durationMs]
 * @returns {Promise<string|null>} the trace uid, or null if persistence failed
 */
async function recordTrace({ kind, summary, detail = {}, namespace = null, durationMs = null }) {
  const uid = `trace-${nanoid(16)}`;
  const ts = new Date().toISOString();
  const { transport, agent } = provenance();

  // Bound the detail size — drop to a marker rather than reject the row.
  let safeDetail = detail;
  try {
    if (JSON.stringify(detail).length > MAX_DETAIL_BYTES) {
      safeDetail = { truncated: true, note: 'trace detail exceeded size cap', summary };
    }
  } catch {
    safeDetail = { error: 'detail not serializable' };
  }

  // Live broadcast first (cheap, never blocks on DB).
  try {
    bus.emit('trace', { uid, kind, summary, namespace, durationMs, transport, agent, detail: safeDetail });
  } catch { /* bus never throws, but be safe */ }

  // Durable write (best-effort).
  try {
    await cortexDb('trace_event').insert({
      uid,
      kind,
      ts,
      duration_ms: durationMs,
      namespace,
      summary,
      transport,
      agent,
      detail: JSON.stringify(safeDetail),
    });
    writesSincePrune += 1;
    if (writesSincePrune >= PRUNE_EVERY_WRITES) {
      writesSincePrune = 0;
      // Keep diagnostics bounded without adding a count/delete query to every
      // write. At most 99 rows can temporarily exceed the cap.
      await cortexDb.raw(
        'DELETE FROM trace_event WHERE id IN (SELECT id FROM trace_event ORDER BY ts DESC OFFSET ?)',
        [MAX_TRACE_ROWS],
      ).catch(() => {});
    }
    return uid;
  } catch (err) {
    console.error('[trace-store] persist failed:', err.message);
    return null;
  }
}

/** Latest traces, newest first. Optionally filtered by kind / agent / namespace / before-ts. */
async function listTraces({ kind = null, agent = null, namespace = null, before = null, limit = 50 } = {}) {
  let q = cortexDb('trace_event')
    .select('uid', 'kind', 'ts', 'duration_ms as durationMs', 'namespace', 'summary', 'transport', 'agent', 'detail')
    .orderBy('ts', 'desc')
    .limit(Math.min(Number(limit) || 50, 200));
  if (kind) q = q.where({ kind });
  if (agent) q = q.where({ agent });
  if (namespace) q = q.where({ namespace });
  if (before) q = q.where('ts', '<', before);
  const rows = await q;
  // pg returns jsonb already parsed; normalize just in case.
  return rows.map((r) => ({ ...r, detail: typeof r.detail === 'string' ? safeParse(r.detail) : r.detail }));
}

async function clearTraces() {
  const n = await cortexDb('trace_event').del();
  return { cleared: n };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

export { recordTrace, listTraces, clearTraces };
