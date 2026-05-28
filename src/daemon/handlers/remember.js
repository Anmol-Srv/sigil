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
    const { default: config } = await import('../../config.js');
    const namespace = params.namespace || config.defaults.namespace;

    let added = 0;
    let updated = 0;
    let alreadyKnown = 0;

    for (const text of facts) {
      const result = await ingestDocument({ content: text, namespace, classify: true });
      if (result.skipped || result.route === 'noise') {
        alreadyKnown++;
        continue;
      }
      const a = result.facts?.added ?? 0;
      const u = result.facts?.updated ?? 0;
      added += a;
      updated += u;
      if (a + u === 0) alreadyKnown++;
    }

    if (added + updated > 0) {
      const { updateContextSnapshot } = await import('../../memory/facts/hot-context.js');
      await updateContextSnapshot({ namespace }).catch(() => {});
    }

    const { default: bus } = await import('../events.js');
    bus.emit('write.fact', { added, updated, alreadyKnown, namespace, count: facts.length });

    return { added, updated, alreadyKnown, namespace };
  });
}
