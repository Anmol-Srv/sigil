/**
 * remember — save one or more facts to memory.
 *
 * Inputs are admitted and embedded as one atomic batch. Graph enrichment is a
 * durable follow-up job, so an explicit save returns once its facts are
 * searchable rather than serially resolving entities.
 */

// A fact is a short, self-contained statement. Agents reach for `remember` for
// everything because it is the tool they know, so whole markdown files and
// session histories were landing in the fact store — shredded into fact rows,
// with no way to get the original back. These thresholds separate "a sentence
// about the world" from "a document", generously enough that a long but
// genuine fact still passes.
const FACT_MAX_CHARS = 1500;
const FACT_MAX_LINES = 10;
const DOC_MARKUP = /^\s{0,3}(#{1,6}\s|```|---\s*$|\|.*\|)/m;

function documentShape(text) {
  const s = String(text);
  const lines = s.split('\n').length;
  if (s.length > FACT_MAX_CHARS) return `${(s.length / 1024).toFixed(1)} KB`;
  if (lines > FACT_MAX_LINES) return `${lines} lines`;
  // Markdown structure in a multi-line input is a document even when short.
  if (lines > 2 && DOC_MARKUP.test(s)) return 'markdown headings/code blocks';
  return null;
}

export function registerRemember(registry) {
  registry.register('remember', async (params) => {
    const facts = Array.isArray(params.facts) ? params.facts.filter(Boolean) : [];
    if (facts.length === 0) {
      const err = new Error('remember: params.facts must be a non-empty string[]');
      err.code = 'invalid_params';
      throw err;
    }

    // Refuse documents rather than shredding them into facts. Rejecting (over
    // silently rerouting) keeps `remember` meaning exactly one thing, and the
    // message names the tool that does the right job — the caller is an agent,
    // and an agent can act on a precise instruction.
    for (const text of facts) {
      const shape = documentShape(text);
      if (!shape) continue;
      const err = new Error(
        `remember: this is a document (${shape}), not a fact. Facts are short, self-contained `
        + 'statements that make sense in isolation. Store the whole thing with `sigil ingest '
        + '<file>` (or the `ingest` MCP tool) — it keeps the full text, attaches it to this '
        + 'project\'s pod, and stays readable via `get_document`.',
      );
      err.code = 'invalid_params';
      throw err;
    }

    // The ingestion pipeline now locks only its short SQL admission/commit
    // sections. Keeping a handler-wide lock here would reintroduce head-of-line
    // blocking across classifier, embedder and graph model calls.
    return saveFacts(facts, params);
  });
}

async function saveFacts(facts, params) {
    const { ingestAtomicFacts } = await import('../../ingestion/pipeline.js');
    const { default: config } = await import('../../config.js');
    const namespace = params.namespace || config.defaults.namespace;

    // Attach to the active pods, exactly like the Stop hook's ingestTurn does.
    // `remember` never passed podUids, so every explicit save an agent made —
    // and the instructions tell agents to use `remember` — landed with no
    // membership at all. Those facts then became invisible to pod-scoped recall
    // the moment any pod existed. An explicit save is the LAST thing that should
    // be unreachable. `pod` (or `about`) overrides the resolution entirely, for
    // when the agent knows the subject better than the cwd does.
    const podUids = await resolveRememberPods(params, namespace);

    const _t0 = Date.now();
    const batch = await ingestAtomicFacts({ facts, namespace, podUids });
    const added = batch.counts.added;
    const updated = batch.counts.updated + batch.counts.contradicted;
    const alreadyKnown = batch.counts.skipped;
    const inputs = facts.map((text, index) => {
      const result = batch.results[index];
      return {
        input: String(text).slice(0, 240),
        route: 'atomic',
        skipped: result?.action === 'SKIP' || result?.action === 'SKIP_DOCUMENT',
        verdicts: result ? [{
          action: result.action,
          factId: result.fact?.id ?? result.existing?.id ?? null,
          audm: result.audm || null,
        }] : [],
      };
    });

    if (added + updated > 0) {
      const { updateContextSnapshot } = await import('../../memory/facts/hot-context.js');
      await updateContextSnapshot({ namespace }).catch(() => {});
    }

    const { recordTrace } = await import('../trace-store.js');
    recordTrace({
      kind: 'ingest',
      summary: `remember ${facts.length} input${facts.length === 1 ? '' : 's'} → +${added} added, ~${updated} updated, ${alreadyKnown} known`,
      namespace,
      durationMs: Date.now() - _t0,
      detail: { op: 'remember', namespace, totals: { added, updated, alreadyKnown, inputCount: facts.length }, inputs },
    }).catch(() => {});

    return { added, updated, alreadyKnown, namespace };
}

/**
 * Pods an explicitly-remembered fact should join.
 *
 * Priority: an agent-declared `pod`/`about` wins outright — it knows the subject
 * better than the working directory does ("remember that srver uses Cloud
 * Hypervisor" typed while sitting in the sigil repo). Otherwise fall back to
 * provenance: the active session + project pods for this cwd.
 */
async function resolveRememberPods(params, namespace) {
  const declared = params.pod || params.about;
  if (declared) {
    const names = Array.isArray(declared) ? declared : [declared];
    const { default: cortexDb } = await import('../../db/cortex.js');
    const rows = await cortexDb('pod')
      .where({ namespace })
      .andWhere(function () { this.whereIn('uid', names).orWhereIn('name', names); })
      .select('uid');
    if (rows.length) return rows.map((r) => r.uid);
    // An unknown name is a caller mistake worth surfacing, not silently
    // downgrading to cwd — the agent asked for a specific scope.
    const err = new Error(`remember: no pod matches ${JSON.stringify(names)} — run \`sigil pod list\` to see them`);
    err.code = 'invalid_params';
    throw err;
  }

  if (!params.cwd && !params.sessionId) return [];
  try {
    const { ensureActivePodsForHook } = await import('../../memory/pods/hook-dispatcher.js');
    const { podUids } = await ensureActivePodsForHook({
      sessionId: params.sessionId || null,
      cwd: params.cwd || null,
      namespace,
    });
    return podUids || [];
  } catch (err) {
    // Never fail a save because pod resolution broke — an unpodded fact is
    // still reachable (see the unpodded rule in hybrid-sql.js).
    console.error(`[remember] pod resolution failed: ${err.message}`);
    return [];
  }
}
