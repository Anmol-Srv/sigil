/**
 * Sigil preamble engine — the "run first" collection + sanity pass.
 *
 * Inspired by gstack's preamble pattern: before an agent reasons about a task,
 * a deterministic pass computes system truth and pulls fresh context, then
 * surfaces it as a compact, branch-on-able block. Sigil's edition does two
 * jobs in one call:
 *
 *   1. SANITY — turn Sigil's silent-failure modes into VISIBLE status:
 *      daemon reachable? DB reachable? setup complete? embedder configured?
 *      Optional LLM healthy when configured? Every one of these has, at some point, made memory
 *      silently return empty while the user kept working. The preamble
 *      reports them as `DB: ok` / `SIGIL: degraded` lines + remediation.
 *
 *   2. GUIDANCE — report that targeted `search` is the source of memory. Sigil
 *      no longer dumps a stale or generic top-N snapshot into every session.
 *
 * One engine, two faces: the `prime` MCP tool (Codex/Cursor call it natively)
 * and the `sigil preamble` CLI both call buildPreamble() and render the same
 * result.
 *
 * Contract: NEVER throws. A broken daemon/DB must produce a `degraded`
 * result with remediation, not an exception — the preamble's whole point is
 * to report failure legibly, so it can't itself fail loudly.
 */

import { connectOrStartDaemon } from '../clients/auto-spawn.js';
import { EMBEDDING_DIM } from '../lib/constants.js';

/**
 * @param {object}   opts
 * @param {(method:string, params:object)=>Promise<any>} [opts.call]
 *        RPC caller returning the handler's `data` directly. When omitted the
 *        engine opens (and closes) its own daemon connection. The MCP server
 *        passes its long-lived `daemonCall` so no extra socket is opened.
 * @returns {Promise<PreambleResult>}
 */
export async function buildPreamble({ call } = {}) {
  /** @type {PreambleResult} */
  const r = {
    state: 'ready',           // 'ready' | 'setup' | 'degraded'
    checks: {},               // { daemon, db, setup, llm, embedding, collection }
    config: {},               // { llmProvider, llmModel, embProvider, embModel, dim, name }
    totals: { facts: 0, documents: 0 },
    facts: [],                // retained for response compatibility; always empty
    issues: [],               // human-readable remediation lines
  };

  // ── Local config (no daemon needed — config.json is installation-local) ───
  r.config = await readConfigSummary();
  r.checks.llm = r.config.llmProvider
    ? { ok: true, detail: `${r.config.llmProvider}${r.config.llmModel ? `/${r.config.llmModel}` : ''}` }
    : { ok: true, detail: 'not configured (optional)' };
  r.checks.embedding = r.config.embProvider
    ? { ok: true, detail: `${r.config.embProvider}/${r.config.embModel} (dim=${r.config.dim})` }
    : { ok: false, detail: 'not configured' };
  if (!r.config.embProvider) r.issues.push('No embedding provider configured — semantic search is off. Run `sigil init`.');

  // ── Daemon connection (auto-spawns if down; self-healing by design) ────────
  let ownClient = null;
  let callFn = call;
  if (!callFn) {
    try {
      ownClient = await connectOrStartDaemon({ quiet: true });
      callFn = async (m, p) => (await ownClient.call(m, p ?? {})).data;
    } catch (err) {
      r.checks.daemon = { ok: false, detail: err.message };
      r.issues.push('Sigil daemon not reachable — run `sigil` (or `sigil daemon start`).');
      return finalize(r);
    }
  }
  r.checks.daemon = { ok: true };

  try {
    // SANITY: status carries a live `SELECT 1` DB probe + counts.
    let status = null;
    try {
      status = await callFn('status', {});
      r.totals = { facts: status.facts ?? 0, documents: status.documents ?? 0 };
      r.checks.db = status.db?.healthy
        ? { ok: true, detail: `${status.facts ?? 0} facts` }
        : { ok: false, detail: status.db?.error || 'unreachable' };
      if (!status.db?.healthy) {
        r.issues.push(`Database unreachable: ${status.db?.error || 'unknown'} — run \`sigil doctor\` for the storage-specific recovery step.`);
      }
      // Upgrade provider checks from "configured?" to the last explicit
      // diagnostic/setup probe, when one is available. Status never probes.
      const p = status.providers;
      if (p?.embedding) {
        r.checks.embedding = p.embedding.ok
          ? { ok: true, detail: `${p.embedding.provider}/${p.embedding.model} (dim=${p.embedding.dim})` }
          : { ok: false, detail: p.embedding.error || 'unreachable' };
        if (!p.embedding.ok) r.issues.push(`Embedding provider unreachable: ${p.embedding.error} — semantic search/ingest will fail.`);
      }
      if (p?.llm) {
        r.checks.llm = p.llm.ok
          ? { ok: true, detail: `${p.llm.provider}${p.llm.model ? `/${p.llm.model}` : ''}` }
          : { ok: false, detail: p.llm.error || 'unreachable' };
        if (!p.llm.ok) r.issues.push(`LLM provider unreachable: ${p.llm.error} — fact extraction will fail.`);
      }
    } catch (err) {
      r.checks.db = { ok: false, detail: err.message };
      r.issues.push(`Could not query Sigil status: ${err.message}`);
    }

    // SANITY: setup completion (older daemons may lack the RPC — non-fatal).
    try {
      const st = await callFn('setup.state', {});
      r.checks.setup = st.complete ? { ok: true } : { ok: false, detail: `next: ${st.currentStep}` };
      if (!st.complete) r.issues.push(`Setup incomplete — next step "${st.currentStep}". Run \`sigil init\` or open the GUI.`);
    } catch { /* pre-setup-store daemon — skip */ }

    r.checks.collection = {
      ok: true,
      detail: 'targeted search on demand; no generic session snapshot',
    };
  } finally {
    if (ownClient) { try { await ownClient.close(); } catch { /* */ } }
  }

  return finalize(r);
}

/**
 * Derive the single headline state. Distinguish NOT-configured (→ 'setup', the
 * user still has work to do) from configured-but-failing (→ 'degraded', a live
 * outage). A dead-but-configured provider is degraded, not "setup needed".
 */
function finalize(r) {
  const daemonDown = r.checks.daemon && !r.checks.daemon.ok;
  const dbDown = r.checks.db && !r.checks.db.ok;
  const coreConfigured = Boolean(r.config.embProvider);
  const providersWorking = r.checks.embedding?.ok
    && (!r.config.llmProvider || r.checks.llm?.ok);
  const setupIncomplete = (r.checks.setup && !r.checks.setup.ok) || !coreConfigured;

  if (daemonDown || dbDown || (coreConfigured && !providersWorking)) r.state = 'degraded';
  else if (setupIncomplete) r.state = 'setup';
  else r.state = 'ready';
  return r;
}

/** Installation-local provider/dim summary, read straight from config.json. */
async function readConfigSummary() {
  try {
    // getConfig() lazy-loads (cache || loadConfig()), so this works in a fresh
    // CLI/MCP process without any prior setup call.
    const { getConfig } = await import('../setup/config-store.js');
    const c = getConfig();
    return {
      llmProvider: c.llm?.provider || '',
      llmModel: c.llm?.model || '',
      embProvider: c.embedding?.provider || '',
      embModel: c.embedding?.model || '',
      dim: EMBEDDING_DIM,
    };
  } catch {
    return { llmProvider: '', llmModel: '', embProvider: '', embModel: '', dim: EMBEDDING_DIM, name: '' };
  }
}

/**
 * @typedef {object} PreambleResult
 * @property {'ready'|'setup'|'degraded'} state
 * @property {Record<string,{ok:boolean,detail?:string}>} checks
 * @property {{llmProvider:string,llmModel:string,embProvider:string,embModel:string,dim:number,name:string}} config
 * @property {{facts:number,documents:number}} totals
 * @property {{content:string,section:string}[]} facts
 * @property {string[]} issues
 */
