import cortexDb from '../../db/cortex.js';
import config from '../../config.js';

// Approximate cost per 1M tokens by model
const COST_PER_M = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
};

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function calcCost(model, inputTokens, outputTokens) {
  const rates = COST_PER_M[model];
  if (!rates) return 0;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

// Rate-limit llm_log write-failure logging (F6, field-report Defect 5). The
// insert is best-effort and fire-and-forget (never stalls the caller); but when
// the DB is wedged EVERY call's insert fails, and the old per-failure
// console.error spammed the daemon log. Collapse: log at most once per window
// with a suppressed-since count.
const WRITE_FAIL_WINDOW_MS = 60_000;
let lastWriteFailLog = 0;
let suppressedWriteFails = 0;

function noteWriteFailure(msg) {
  suppressedWriteFails += 1;
  const now = Date.now();
  if (now - lastWriteFailLog < WRITE_FAIL_WINDOW_MS) return; // within window — stay quiet
  const extra = suppressedWriteFails > 1 ? ` (${suppressedWriteFails} failures in the last minute)` : '';
  console.error(`[llm-log] write failed${extra}: ${msg}`);
  lastWriteFailLog = now;
  suppressedWriteFails = 0;
}

// Decide whether an llm_log write must route through the daemon (B6.8 /
// field-report Defect 6 follow-up). The embedded engine is single-process: only
// the daemon may open it, so a CLI/hook process (the stop-hook classifier, a
// doctor probe) that writes directly hits the single-process guard and the row
// is lost. Server Postgres is multi-connection, so any process writes directly.
// Pure for testability.
export function shouldRouteLlmLog(dbMode, isDaemonProcess) {
  return dbMode === 'embedded' && !isDaemonProcess;
}

function routeThroughDaemon() {
  let mode;
  try { mode = config.db?.mode; } catch { /* config unreadable — write direct */ }
  return shouldRouteLlmLog(mode, process.env.SIGIL_DAEMON_PROCESS === '1');
}

function buildRow({ provider, model, caller, input, response, inputTokens, outputTokens, cost, durationMs, status, error, workerId, reqId, viaFallback }) {
  return {
    provider,
    model,
    caller,
    input: input?.slice(0, 10000),
    response: response?.slice(0, 10000),
    inputTokens,
    outputTokens,
    cost,
    durationMs,
    status,
    error: error?.slice(0, 2000),
    // Managed-session correlation (NULL for one-shot/API calls). workerId →
    // which warm worker served it; reqId correlates to the kind='engine' trace;
    // viaFallback → the warm engine bailed to one-shot.
    workerId: workerId ?? null,
    reqId: reqId ?? null,
    viaFallback: viaFallback ?? null,
  };
}

// Send the row to the daemon's llmLog RPC. Connects to the EXISTING daemon only
// (never auto-spawns one just to log telemetry); if none is running the row is
// dropped — it's best-effort cost tracking, never worth blocking or spawning for.
async function routeLlmLogToDaemon(row) {
  try {
    const { openSocketClient } = await import('../../clients/socket-client.js');
    const client = await openSocketClient({ timeoutMs: 3_000 });
    try { await client.call('llmLog', row); } finally { await client.close().catch(() => {}); }
  } catch (err) {
    noteWriteFailure(err.message); // rate-limited; a down daemon shouldn't spam
  }
}

function logCall(fields) {
  const row = buildRow(fields);
  if (routeThroughDaemon()) {
    routeLlmLogToDaemon(row); // fire-and-forget; never awaited on the hot path
    return;
  }
  cortexDb('llm_log').insert(row).catch((err) => noteWriteFailure(err.message));
}

// Extract an HTTP status from a provider error. Providers throw structured
// `err.status` where available; otherwise their message is shaped like
// "OpenAI error 401: ...", so fall back to that.
function statusFromError(err) {
  if (typeof err?.status === 'number') return err.status;
  const m = /error\s+(\d{3})\b/i.exec(err?.message || '');
  return m ? Number(m[1]) : null;
}

// Only retry errors that might succeed on a second attempt. A 401 (bad key),
// 400 (malformed request), or 404 (wrong model) is deterministic — retrying
// burns latency and money for the same failure. 408/429 and 5xx are transient;
// a missing status (network reset, DNS, socket hangup) is worth a retry too.
function isRetryable(err) {
  const status = statusFromError(err);
  if (status == null) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

async function withRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries || !isRetryable(err)) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Retention: llm_log and trace_event grow unbounded (one row per LLM call /
// trace event). Called from `sigil maintain` to cap their size. Returns the
// number of rows deleted from each table.
async function pruneLogs({ llmLogDays = 30, traceDays = 7 } = {}) {
  const llmDeleted = await cortexDb('llm_log')
    .where('createdAt', '<', cortexDb.raw(`NOW() - INTERVAL '${Number(llmLogDays)} days'`))
    .del()
    .catch(() => 0);
  let traceDeleted = 0;
  try {
    // trace_event timestamps its rows with `ts`, not created_at.
    traceDeleted = await cortexDb('trace_event')
      .where('ts', '<', cortexDb.raw(`NOW() - INTERVAL '${Number(traceDays)} days'`))
      .del();
  } catch { /* trace_event may not exist on older schemas — ignore */ }
  return { llmDeleted, traceDeleted };
}

export { estimateTokens, calcCost, logCall, withRetry, pruneLogs, buildRow };
