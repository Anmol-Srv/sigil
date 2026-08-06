/**
 * Subject routing — put a fact in the pod it is ABOUT, not just the one it was
 * learned in.
 *
 * A fact has two independent locations, and only one was ever computed:
 *
 *   provenance — which session / which directory. Cheap, deterministic, and
 *                what ingestTurn + remember attach on.
 *   subject    — which project / person / topic the fact is actually about.
 *
 * Conflating them is a real failure, not a theoretical one: standing in the
 * `sigil` repo and saying "remember that srver's F0 uses Cloud Hypervisor"
 * files the fact under `sigil`. Come back to srver later and recall misses it.
 *
 * The signal needed to fix this was already being computed and thrown away.
 * The ingest pipeline links every fact to entities (`fact_entity`, with
 * mention_type/mention_count), and `pod.entity_id` has existed since the pod
 * tables landed — used only by person pods, and only when created by hand. So:
 * bind a pod to its canonical entity, and any fact mentioning that entity joins
 * the pod as `contextual`, whatever directory it was typed in.
 *
 * Deliberately NOT an LLM pass. Writes are already the slow path (a save runs
 * classify -> extract -> AUDM -> link), and this project keeps generation off
 * hot paths. Entities are already extracted; routing on them costs one indexed
 * lookup per ingest.
 *
 * Roles carry the distinction the schema already anticipated:
 *   primary    — provenance: this pod is where the fact was produced
 *   contextual — subject: this pod is what the fact is about
 */

import cortexDb from '../../db/cortex.js';

import * as membership from './membership.js';

// A fact that merely name-drops an entity should not join its pod. Only route
// on mentions the extractor treated as substantive. `content` is the default
// mention_type written by the linker; anything weaker is noise.
const ROUTABLE_MENTION_TYPES = ['content'];
// Cap fan-out: a fact touching a dozen entities would otherwise land in a dozen
// pods and pollute every one of them. Rank by mention_count and keep the top
// few — a fact is genuinely "about" one or two things.
const MAX_SUBJECT_PODS = 3;

/**
 * Attach freshly-written facts to pods bound to the entities they mention.
 *
 * @param {number[]} factIds  facts written by this ingest
 * @param {number[]} skipPodIds  pods already attached as provenance — re-adding
 *   would downgrade a `primary` membership to `contextual` (attach is
 *   ON CONFLICT DO NOTHING, so it wouldn't actually change, but skipping keeps
 *   the counters honest and saves the round-trip).
 * @returns {Promise<{attached: number, pods: number[]}>}
 */
export async function routeFactsToSubjectPods(factIds, { skipPodIds = [], db = cortexDb } = {}) {
  const ids = (factIds || []).filter(Number.isFinite);
  if (!ids.length) return { attached: 0, pods: [] };

  // fact -> entity -> pod, in one hop. Only pods that declare an entity binding
  // participate; there is no fuzzy name matching, because entity names collide
  // ("core", "api") and a wrong pod is worse than no pod.
  const rows = await db('fact_entity as fe')
    .join('pod', 'pod.entity_id', 'fe.entity_id')
    .whereIn('fe.fact_id', ids)
    .whereIn('fe.mention_type', ROUTABLE_MENTION_TYPES)
    .andWhere('pod.status', 'active')
    .select('fe.fact_id as factId', 'pod.id as podId', 'fe.mention_count as mentionCount');

  if (!rows.length) return { attached: 0, pods: [] };

  const skip = new Set(skipPodIds);
  const byFact = new Map();
  for (const r of rows) {
    if (skip.has(r.podId)) continue;
    const list = byFact.get(r.factId) || [];
    list.push(r);
    byFact.set(r.factId, list);
  }

  let attached = 0;
  const pods = new Set();
  for (const [factId, candidates] of byFact) {
    candidates.sort((a, b) => (b.mentionCount || 0) - (a.mentionCount || 0));
    for (const c of candidates.slice(0, MAX_SUBJECT_PODS)) {
      const res = await membership.attachFact(c.podId, factId, 'contextual', db);
      if (res.attached) { attached += 1; pods.add(c.podId); }
    }
  }
  return { attached, pods: [...pods] };
}

/**
 * Bind a pod to a canonical entity so subject routing can find it.
 *
 * Idempotent, and never steals an existing binding. Creates the entity when it
 * doesn't exist yet so a brand-new project is routable from its first ingest
 * rather than only after something happens to mention it.
 */
export async function bindPodToEntity({ podId, name, namespace, entityType = 'topic', db = cortexDb }) {
  if (!podId || !name) return null;

  const [pod] = await db('pod').where({ id: podId }).select('entity_id as entityId');
  if (pod?.entityId) return pod.entityId; // already bound — leave it alone

  const { findByName, insertEntity } = await import('../entities/store.js');
  let entity = await findByName(name, namespace);
  if (!entity) {
    // No embedding: this entity exists to be a routing anchor. The linker fills
    // in description/embedding if it later encounters the name in real content.
    entity = await insertEntity({ name, entityType, description: null, namespace, externalId: null, embedding: null })
      .catch(async (err) => {
        // Say WHY. A silent null here means the pod is quietly unroutable
        // forever, which is indistinguishable from "nothing mentioned it yet".
        const raced = await findByName(name, namespace);
        if (!raced) console.error(`[pods] could not bind "${name}" to an entity: ${err.message}`);
        return raced;
      });
  }
  if (!entity) return null;

  await db('pod').where({ id: podId }).update({ entityId: entity.id });
  return entity.id;
}
