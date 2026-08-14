/**
 * Ingest benchmark — acceptance, searchable-core, graph-enrichment latency,
 * plus LLM call count by stage.
 *
 * Wall-clock alone is useless for tuning this pipeline: the route the classifier
 * picks (thought vs knowledge) changes which stages run at all, a worker
 * dead-man timeout adds a flat 120s, and provider latency swings several seconds
 * per call. LLM CALL COUNT is the stable number, and it is also the thing
 * actually being optimized — every stage is ~5s whether the process is warm or
 * cold, so N is the cost.
 *
 * Runs a fixed corpus through the daemon's own `remember` RPC into a scratch
 * namespace, then reads the trace log back and aggregates by caller.
 *
 *   node scripts/bench-ingest.mjs [--keep] [--ns=bench]
 *
 * --keep leaves the scratch namespace in place for inspection.
 */
import { openSocketClient } from '../src/clients/socket-client.js';

const args = new Set(process.argv.slice(2));
const nsArg = process.argv.slice(2).find((a) => a.startsWith('--ns='));
const NS = nsArg ? nsArg.slice(5) : `bench-${process.pid}`;

// Fixed corpus. Deliberately spans the shapes that cost different amounts:
// a bare preference (few entities), a dense technical claim (many entities),
// and a restatement of an earlier one (exercises AUDM's dedup decision).
const CORPUS = [
  'The user prefers tabs over spaces in all Go source files',
  'Sigil stores facts in PGlite, an embedded WASM Postgres that allows exactly one connection at a time',
  'The managed-session engine keeps warm claude workers alive inside tmux so ingest calls skip agentic cold start',
  'Sigil keeps its facts in PGlite, a single-connection embedded Postgres compiled to WASM',
];

const ms = (n) => `${(n / 1000).toFixed(1)}s`;

const client = await openSocketClient({ timeoutMs: 600_000 });

// Warm-up, NOT measured. A cold managed-session worker takes ~10s to hand
// shake, and if the pool is mid-recycle the first save eats a boot window or a
// 120s dead-man timeout — which landed as a 229s "result" and swamped every
// other number in the run. Whatever the first save pays, it isn't the pipeline.
process.stdout.write('warming up… ');
const warm = Date.now();
await client.call('remember', { facts: ['Benchmark warm-up fact, not measured'], namespace: NS }, { timeoutMs: 600_000 });
console.log(`${ms(Date.now() - warm)}\n`);

// Traces are append-only, so a timestamp taken now is a clean cursor.
const startedAt = new Date().toISOString();
const t0 = Date.now();

const perFact = [];
for (const text of CORPUS) {
  const s = Date.now();
  const res = await client.call('remember', { facts: [text], namespace: NS }, { timeoutMs: 600_000 });
  perFact.push({ text, ms: Date.now() - s, counts: res.data?.totals ?? res.data });
}
const wall = Date.now() - t0;

// Document path: distinguish the latency the caller experiences from the time
// until facts are searchable and the later graph maintenance tail.
const docText = `# Benchmark document\n\nSigil benchmark ${process.pid} uses durable staged ingestion. It stores searchable facts before entity and relation enrichment.`;
const docStarted = Date.now();
const queued = await client.call('ingestDoc', {
  content: docText,
  title: 'Ingestion latency benchmark',
  sourcePath: `bench/${NS}/latency.md`,
  namespace: NS,
  background: true,
}, { timeoutMs: 30_000 });
const acceptedMs = Date.now() - docStarted;
const core = await waitJob(queued.data.jobUid);
const searchableMs = Date.now() - docStarted;
const entityUid = core.result?.entities?.jobUid || null;
const entity = entityUid ? await waitJob(entityUid) : null;
const enrichedMs = entity ? Date.now() - docStarted : null;
const relationUid = entity?.result?.maintenanceJobUid || null;
const relation = relationUid && !args.has('--no-relations') ? await waitJob(relationUid) : null;
const relatedMs = relation ? Date.now() - docStarted : null;

// Aggregate the engine/llm traces this run produced.
const { data } = await client.call('trace.list', { limit: 500 });
const mine = data.traces.filter((t) => t.ts >= startedAt);

const calls = new Map();
for (const t of mine) {
  const caller = t.detail?.caller;
  if (!caller || t.detail?.type !== 'result') continue;
  if (!calls.has(caller)) calls.set(caller, []);
  calls.get(caller).push(t.durationMs ?? 0);
}

console.log(`\nnamespace ${NS} · ${CORPUS.length} facts · wall ${ms(wall)}\n`);
console.log(`  document accepted ${ms(acceptedMs)} · searchable ${ms(searchableMs)}${enrichedMs != null ? ` · entities ${ms(enrichedMs)}` : ''}${relatedMs != null ? ` · relations ${ms(relatedMs)}` : ''}\n`);
for (const [i, f] of perFact.entries()) {
  console.log(`  ${String(i + 1).padStart(2)}. ${ms(f.ms).padStart(6)}  ${f.text.slice(0, 62)}…`);
}

const total = [...calls.values()].reduce((a, b) => a + b.length, 0);
console.log(`\n  LLM calls: ${total} (${(total / CORPUS.length).toFixed(1)} per fact)\n`);
const rows = [...calls.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));
for (const [caller, durs] of rows) {
  console.log(`    ${caller.padEnd(24)} ${String(durs.length).padStart(3)}×  ${ms(sum(durs)).padStart(7)}  (median ${ms(median(durs))})`);
}
if (!total) console.log('    none recorded — is the daemon logging traces?');

// No auto-cleanup: `deleteNamespace` is a direct DB call and the daemon holds
// PGlite's only connection, so the tidy-up has to happen with the daemon down.
if (!args.has('--keep')) {
  console.log(`\n  clean up:  sigil daemon stop && sigil namespace delete ${NS} --confirm`);
}
process.exit(0);

function sum(a) { return a.reduce((x, y) => x + y, 0); }
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

async function waitJob(uid, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data: job } = await client.call('ingestionJob.get', { uid });
    if (!job) throw new Error(`job disappeared: ${uid}`);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(`${uid} failed: ${job.error}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${uid} did not finish within ${timeoutMs}ms`);
}
