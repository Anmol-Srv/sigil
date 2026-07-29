/**
 * correctFact — explicitly replace one active fact while preserving history.
 * Accepts a numeric id, full UID, or unambiguous UID prefix.
 */
export function registerCorrectFact(registry) {
  registry.register('correctFact', async (params = {}) => {
    const { MAX_ATOMIC_FACT_CHARS } = await import('../../lib/constants.js');
    const id = String(params.id ?? '').trim();
    const content = String(params.content ?? '').trim();
    if (!id || !content || content.length > MAX_ATOMIC_FACT_CHARS) {
      const err = new Error(
        `correctFact: params.id and content of at most ${MAX_ATOMIC_FACT_CHARS} characters are required`,
      );
      err.code = 'invalid_params';
      throw err;
    }

    const { correctFact } = await import('../../memory/facts/store.js');
    const startedAt = Date.now();
    const result = await correctFact(id, content);
    if (!result) return { notFound: true, query: id };
    if (!result.unchanged) {
      const { recordTrace } = await import('../trace-store.js');
      recordTrace({
        kind: 'correct',
        summary: `corrected ${result.previous.uid} → ${result.replacement.uid}`,
        namespace: result.replacement.namespace || null,
        durationMs: Date.now() - startedAt,
        detail: {
          op: 'correctFact',
          previousFactId: result.previous.id,
          replacementFactId: result.replacement.id,
        },
      }).catch(() => {});
    }
    return {
      unchanged: result.unchanged,
      previous: {
        uid: result.previous.uid,
        content: result.previous.content,
      },
      replacement: {
        uid: result.replacement.uid,
        content: result.replacement.content,
      },
    };
  });
}
