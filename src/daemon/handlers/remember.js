/**
 * remember — save one or more facts to memory.
 *
 * Sequential ingest is deliberate (see runRemember comment in cli.js):
 * parallel ingests with shared entities race on entity create/rename and
 * break AUDM's pairwise dedup invariants.
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

    const { ingestDocument } = await import('../../ingestion/pipeline.js');
    const { default: config } = await import('../../config.js');
    const namespace = params.namespace || config.defaults.namespace;

    let added = 0;
    let updated = 0;
    let alreadyKnown = 0;
    const _t0 = Date.now();
    const inputs = []; // per-input causal trace

    for (const text of facts) {
      const result = await ingestDocument({ content: text, namespace, classify: true });
      if (result.skipped || result.route === 'noise') {
        alreadyKnown++;
        inputs.push({ input: String(text).slice(0, 240), route: result.route ?? null, skipped: true, verdicts: result.facts?.verdicts || [] });
        continue;
      }
      const a = result.facts?.added ?? 0;
      const u = result.facts?.updated ?? 0;
      added += a;
      updated += u;
      if (a + u === 0) alreadyKnown++;
      inputs.push({
        input: String(text).slice(0, 240),
        route: result.route ?? null,
        skipped: false,
        counts: { added: a, updated: u, skipped: result.facts?.skipped ?? 0, contradicted: result.facts?.contradicted ?? 0 },
        verdicts: result.facts?.verdicts || [],
        entities: result.entities ? { entityCount: result.entities.entityCount, relationCount: result.entities.relationCount, topics: result.entities.topics || [] } : null,
      });
    }

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
  });
}
