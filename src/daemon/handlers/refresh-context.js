/**
 * refreshContext — rebuild the Active Context snapshot consumed by
 * ~/.sigil/CLAUDE.md ON THIS DEVICE. Always writes locally.
 *
 * On a lite-follower (no local DB), the read-side that needs the DB
 * is proxied to master via the MemoryClient as `refreshContext.fetch`
 * (and `refreshContext.explain` for the diagnostic mode), while the
 * file write — which targets *this* device's home — stays local.
 *
 * This split exists because a naive proxy of `refreshContext` would
 * write master's ~/.sigil/CLAUDE.md, leaving every lite-follower's
 * Claude Code session with stale Active Context. (PR review #2.)
 */
export function registerRefreshContext(registry) {
  // Proxiable read-side: pure DB → returns serializable data.
  registry.register('refreshContext.fetch', async (params) => {
    const { resolveNamespace } = await import('../../memory/namespace.js');
    const { getHotFacts } = await import('../../memory/facts/hot-context.js');
    // Usually called by the top-level refreshContext orchestrator with an
    // already-resolved namespace; resolve here too so direct calls honor the
    // per-project marker/env precedence.
    const namespace = resolveNamespace({ cwd: params.cwd || null, explicit: params.namespace });
    const limit = Number.isFinite(params.limit) ? params.limit : 20;
    const facts = await getHotFacts({ namespace, limit });
    return { namespace, facts };
  });

  registry.register('refreshContext.explain', async (params) => {
    const { resolveNamespace } = await import('../../memory/namespace.js');
    const namespace = resolveNamespace({ cwd: params.cwd || null, explicit: params.namespace });
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
  });

  // Top-level handler: orchestrates a local file write driven by data
  // sourced from either local DB (LocalClient) or master (RemoteClient).
  // Stays in LOCAL_ONLY so the lite-proxy never replaces it — the
  // delegation happens inside, via getMemoryClient().
  registry.register('refreshContext', async (params) => {
    const { resolveNamespace } = await import('../../memory/namespace.js');
    const { getMemoryClient } = await import('../../memory/client.js');
    // Resolve once here (we have params.cwd), then pass the concrete namespace
    // down to the proxiable read-side so master/lite-follower agree on scope.
    const namespace = resolveNamespace({ cwd: params.cwd || null, explicit: params.namespace });
    const limit = Number.isFinite(params.limit) ? params.limit : 20;
    const explain = Boolean(params.explain);

    const client = await getMemoryClient();

    if (explain) {
      // Read-only mode — just return the breakdown. No file write either way.
      return client.call('refreshContext.explain', { namespace, cwd: params.cwd });
    }

    const { facts } = await client.call('refreshContext.fetch', { namespace, limit });
    const { writeSnapshotToFile } = await import('../../memory/facts/hot-context.js');
    const { writeSharedInstructions } = await import('../../lib/clients/instructions.js');
    await writeSharedInstructions();
    const count = await writeSnapshotToFile({ facts, namespace });
    return { mode: 'write', namespace, count };
  });
}
