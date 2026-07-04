/**
 * remember — save one or more facts to memory.
 *
 * Sequential ingest is deliberate (see runRemember comment in cli.js):
 * parallel ingests with shared entities race on entity create/rename and
 * break AUDM's pairwise dedup invariants.
 */
export function registerRemember(registry) {
  registry.register('remember', async (params) => {
    const facts = Array.isArray(params.facts) ? params.facts.filter(Boolean) : [];
    if (facts.length === 0) {
      const err = new Error('remember: params.facts must be a non-empty string[]');
      err.code = 'invalid_params';
      throw err;
    }

    const { ingestDocument } = await import('../../ingestion/pipeline.js');
    const { resolveNamespace } = await import('../../memory/namespace.js');
    // Explicit --namespace wins; else SIGIL_NAMESPACE env > committed
    // `.sigil/namespace` marker (via params.cwd) > install default.
    const namespace = resolveNamespace({ cwd: params.cwd || null, explicit: params.namespace });

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
