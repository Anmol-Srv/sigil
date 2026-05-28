/**
 * refreshContext — rebuild the Active Context snapshot consumed by
 * ~/.claude/CLAUDE.md. Returns {count, mode}. If mode === 'explain',
 * returns the per-kind breakdown without writing the snapshot.
 */
export function registerRefreshContext(registry) {
  registry.register('refreshContext', async (params) => {
    const { default: config } = await import('../../config.js');

    const namespace = params.namespace || config.defaults.namespace;
    const limit = Number.isFinite(params.limit) ? params.limit : 20;
    const explain = Boolean(params.explain);

    if (explain) {
      await import('../../memory/pods/kinds/index.js');
      const { activeKinds } = await import('../../memory/pods/registry.js');
      const { factsInPodsByRecency } = await import('../../memory/facts/hot-context.js');

      const ctx = { namespace, cwd: params.cwd || process.cwd() };
      const active = await activeKinds(ctx);
      const sections = [];

      for (const { kind, scope } of active) {
        let facts;
        let error = null;
        try {
          if (typeof kind.fetchFacts === 'function') {
            facts = await kind.fetchFacts(ctx, { slots: kind.hotContextBudget, namespace });
          } else {
            facts = await factsInPodsByRecency(scope, namespace, kind.hotContextBudget);
          }
        } catch (err) {
          facts = [];
          error = err.message;
        }
        sections.push({
          name: kind.name,
          budget: kind.hotContextBudget,
          visibility: kind.visibility,
          error,
          facts: (facts || []).slice(0, kind.hotContextBudget).map((f) => ({
            content: typeof f === 'string' ? f : (f.content || ''),
          })),
        });
      }
      return { mode: 'explain', namespace, sections };
    }

    const { updateContextSnapshot } = await import('../../memory/facts/hot-context.js');
    const { writeSharedInstructions } = await import('../../lib/clients/instructions.js');
    await writeSharedInstructions();
    const count = await updateContextSnapshot({ namespace, limit });
    return { mode: 'write', namespace, count };
  });
}
