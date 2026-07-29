/**
 * remember — save one or more facts to memory.
 *
 * Explicit remember stores exactly the atomic statements supplied by the user
 * or agent. It must not classify, re-extract, contextualize, graph-link, or
 * synthesize them.
 */
export function registerRemember(registry) {
  registry.register('remember', async (params = {}, ctx = {}) => {
    const {
      MAX_ATOMIC_FACT_CHARS, MAX_FACTS_PER_REQUEST, MAX_NAMESPACE_CHARS,
    } = await import('../../lib/constants.js');
    const facts = Array.isArray(params.facts) ? params.facts : [];
    if (
      facts.length === 0
      || facts.length > MAX_FACTS_PER_REQUEST
      || facts.some((fact) => typeof fact !== 'string' || !fact.trim() || fact.length > MAX_ATOMIC_FACT_CHARS)
    ) {
      const err = new Error(
        `remember: params.facts must contain 1-${MAX_FACTS_PER_REQUEST} non-empty strings, `
        + `each at most ${MAX_ATOMIC_FACT_CHARS} characters; ingest larger documents instead`,
      );
      err.code = 'invalid_params';
      throw err;
    }

    const { saveAtomicMemories } = await import('../../memory/facts/direct.js');
    const { resolveMemoryScope } = await import('../memory-scope.js');
    const namespace = resolveMemoryScope(params, ctx).writeNamespace;
    if (!namespace || namespace.length > MAX_NAMESPACE_CHARS) {
      const err = new Error(`remember: namespace must be 1-${MAX_NAMESPACE_CHARS} characters`);
      err.code = 'invalid_params';
      throw err;
    }

    const _t0 = Date.now();
    const result = await saveAtomicMemories(facts, { namespace });
    const added = result.counts.added;
    const alreadyKnown = result.counts.skipped;
    const inputs = result.results.map((item, index) => ({
      input: String(facts[index] || '').slice(0, 240),
      route: 'direct',
      skipped: item.action === 'SKIP',
      counts: {
        added: item.action === 'ADD' ? 1 : 0,
        skipped: item.action === 'SKIP' ? 1 : 0,
      },
      verdicts: [{
        action: item.action,
        factId: item.fact?.id ?? item.existing?.id ?? null,
        dedup: item.dedup || null,
      }],
    }));

    const { recordTrace } = await import('../trace-store.js');
    recordTrace({
      kind: 'remember',
      summary: `remember ${facts.length} input${facts.length === 1 ? '' : 's'} → +${added} added, ${alreadyKnown} known`,
      namespace,
      durationMs: Date.now() - _t0,
      detail: { op: 'remember', namespace, totals: { added, alreadyKnown, inputCount: facts.length }, inputs },
    }).catch(() => {});

    return { added, alreadyKnown, namespace };
  });
}
