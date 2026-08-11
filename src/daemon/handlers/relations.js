/**
 * relations.derive — the algorithmic half of edge building, exposed for
 * inspection before it is trusted to write anything.
 *
 * Three levels, each opt-in, because each costs more than the last:
 *   default        candidates only — pure SQL, ~7ms
 *   { name }       + predicates from a batched LLM pass, ~84s for 31 pairs
 *   { apply }      + writes them, tagged derived_by='co-occurrence'
 *
 * Nothing here belongs on the write path. Discovery is free enough to run
 * anywhere; naming is a maintenance job, which is the whole point of splitting
 * them — ingest stops paying for relation extraction it no longer needs to do.
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

    let applied = null;
    if (params.apply) {
      const { applyDerived } = await import('../../memory/entities/derive-relations.js');
      const { canonicalizeRelationType } = await import('../../memory/entities/graph-extractor.js');
      const { createRelation } = await import('../../memory/entities/relations.js');
      applied = await applyDerived(relations, {
        canonicalize: canonicalizeRelationType,
        createRelation,
        validAt: new Date(),
      });
    }

    return {
      named: true,
      applied,
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
