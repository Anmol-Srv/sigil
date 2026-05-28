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
import { currentRequestContext } from './request-context.js';

// Keep individual trace payloads bounded so a pathological search (hundreds
// of candidates) can't bloat a row or the WS frame. Detail is already
// shaped/capped by callers; this is a backstop.
const MAX_DETAIL_BYTES = 256 * 1024;

function provenance() {
  // request-context (AsyncLocalStorage) is populated by rpc-registry.dispatch
  // around each handler: { device, transport }. Local in-process calls (and
  // tests) get null.
  const ctx = currentRequestContext();
  return {
    deviceId: ctx?.device?.id ?? null,
    transport: ctx?.transport ?? null,
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
  const { deviceId, transport } = provenance();

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
    bus.emit('trace', { uid, kind, summary, namespace, durationMs, deviceId, transport, detail: safeDetail });
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
      device_id: deviceId,
      transport,
      detail: JSON.stringify(safeDetail),
    });
    return uid;
  } catch (err) {
    console.error('[trace-store] persist failed:', err.message);
    return null;
  }
}

/** Latest traces, newest first. Optionally filtered by kind / namespace / before-ts. */
async function listTraces({ kind = null, namespace = null, before = null, limit = 50 } = {}) {
  let q = cortexDb('trace_event')
    .select('uid', 'kind', 'ts', 'duration_ms as durationMs', 'namespace', 'summary', 'device_id as deviceId', 'transport', 'detail')
    .orderBy('ts', 'desc')
    .limit(Math.min(Number(limit) || 50, 200));
  if (kind) q = q.where({ kind });
  if (namespace) q = q.where({ namespace });
  if (before) q = q.where('ts', '<', before);
  const rows = await q;
  // pg returns jsonb already parsed; normalize just in case.
  return rows.map((r) => ({ ...r, detail: typeof r.detail === 'string' ? safeParse(r.detail) : r.detail }));
}

async function getTrace(uid) {
  const row = await cortexDb('trace_event')
    .select('uid', 'kind', 'ts', 'duration_ms as durationMs', 'namespace', 'summary', 'device_id as deviceId', 'transport', 'detail')
    .where({ uid })
    .first();
  if (!row) return null;
  return { ...row, detail: typeof row.detail === 'string' ? safeParse(row.detail) : row.detail };
}

async function clearTraces() {
  const n = await cortexDb('trace_event').del();
  return { cleared: n };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

export { recordTrace, listTraces, getTrace, clearTraces };
