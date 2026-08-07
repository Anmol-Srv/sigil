/**
 * pods.route — re-run subject routing across facts already in the store.
 *
 * Routing derives entirely from data already on disk (fact_entity +
 * pod.entity_id), so this needs no LLM and no re-embedding: it is the migration
 * path for every fact written before subject routing existed. Additive only —
 * it adds `contextual` memberships and never removes one.
 */
import { withWriteLock } from '../write-queue.js';

export function registerRoutePods(registry) {
  registry.register('pods.route', async () => {
    // Under the write lock: it writes membership rows, and the embedded engine
    // has a single connection to share with whatever else is saving.
    const { backfillSubjectRouting, backfillPodEntityBindings } = await import('../../memory/pods/subject-router.js');
    // Bind first: routing only sees pods that declare an entity, so on a store
    // predating this feature there is nothing to route to until they're bound.
    const bindings = await withWriteLock(() => backfillPodEntityBindings({}));
    const routed = await withWriteLock(() => backfillSubjectRouting({}));
    const result = { ...routed, bound: bindings.bound, bindCandidates: bindings.candidates };

    const { recordTrace } = await import('../trace-store.js');
    recordTrace({
      kind: 'ingest',
      summary: `pod routing backfill → ${result.bound} pod(s) bound, ${result.attached} membership(s) across ${result.pods.length} pod(s) (${result.scanned} facts scanned)`,
      detail: { op: 'pods.route', ...result },
    }).catch(() => {});

    return result;
  });
}
