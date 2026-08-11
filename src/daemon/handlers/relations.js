/**
 * relations.derive — the algorithmic half of edge building, exposed for
 * inspection before it is trusted to write anything.
 *
 * Read-only by design at this stage. Writing derived edges into `relation`
 * needs a provenance column first: the table records mention_count but nothing
 * separating "a model asserted this from prose" from "co-occurrence implies
 * this", and without that distinction derived edges can never be trust-weighted,
 * re-derived, or safely removed.
 */
export function registerRelations(registry) {
  registry.register('relations.derive', async (params = {}) => {
    const { deriveCandidates, nameCandidates } = await import('../../memory/entities/derive-relations.js');

    const { totalPairs, alreadyRelated, unresolved, candidates } = await deriveCandidates({
      namespace: params.namespace || null,
      minShared: Number.isFinite(params.minShared) ? params.minShared : 1,
      limit: Number.isFinite(params.limit) ? params.limit : 50,
    });

    // Candidate generation is pure SQL and effectively free (7ms on a real
    // store, against 9.8s for the LLM extractor it supplements). Naming costs a
    // model call per batch, so it stays opt-in.
    if (!params.name) {
      return { named: false, totalPairs, alreadyRelated, unresolved, candidates };
    }

    const { promptJson } = await import('../../lib/llm.js');
    const started = Date.now();
    const relations = await nameCandidates(candidates, {
      promptJson,
      batchSize: Number.isFinite(params.batchSize) ? params.batchSize : 8,
    });
    return {
      named: true,
      totalPairs,
      alreadyRelated,
      unresolved,
      judged: candidates.length,
      accepted: relations.length,
      rejected: candidates.length - relations.length,
      durationMs: Date.now() - started,
      relations,
    };
  });
}
