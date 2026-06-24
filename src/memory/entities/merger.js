import { groupBy, sumBy, sortBy } from 'lodash-es';

import cortexDb from '../../db/cortex.js';
import { findById, updateEntityTypes, safeParseEntityTypes } from './store.js';

async function mergeEntities(primaryId, duplicateId) {
  const [primary, duplicate] = await Promise.all([
    findById(primaryId),
    findById(duplicateId),
  ]);

  if (!primary || !duplicate) {
    throw new Error(`Entity ${primaryId} or ${duplicateId} not found`);
  }

  if (primaryId === duplicateId) return primary;

  const newMentionCount = (primary.mentionCount || 0) + (duplicate.mentionCount || 0);

  await cortexDb.transaction(async (trx) => {
    // 1. Redirect all relations from duplicate to primary
    await trx('relation')
      .where({ sourceId: duplicateId })
      .update({ sourceId: primaryId });

    await trx('relation')
      .where({ targetId: duplicateId })
      .update({ targetId: primaryId });

    // Remove self-referencing relations created by redirect
    await trx('relation').whereRaw('source_id = target_id').del();

    // 2. Merge fact_entity links via INSERT ON CONFLICT
    await trx.raw(`
      INSERT INTO fact_entity (fact_id, entity_id, mention_type, mention_count, created_at, updated_at)
      SELECT fact_id, ?, mention_type, mention_count, NOW(), NOW()
      FROM fact_entity
      WHERE entity_id = ?
      ON CONFLICT (fact_id, entity_id, mention_type)
      DO UPDATE SET mention_count = fact_entity.mention_count + EXCLUDED.mention_count
    `, [primaryId, duplicateId]);

    await trx('fact_entity').where({ entityId: duplicateId }).del();

    // 3. Sum mention counts
    await trx('entity')
      .where({ id: primaryId })
      .update({ mentionCount: newMentionCount });

    // 4. Reassign any pod that was attached to the duplicate entity. The
    // person/project pod's metadata (role, platforms, notes) follows the
    // canonical entity — otherwise an entity dedup would silently orphan
    // pod attrs.
    //
    // Edge case: if the primary entity *already* has a pod, the
    // duplicate's pod gets archived instead of reassigned, so we don't
    // end up with two active pods for the same canonical entity. The
    // duplicate's facts are already collapsed via fact_entity merging
    // above, so the surviving pod still surfaces them via its entity_id.
    const primaryHasPod = await trx('pod')
      .where({ entityId: primaryId, status: 'active' })
      .first();

    if (primaryHasPod) {
      await trx('pod')
        .where({ entityId: duplicateId })
        .update({ status: 'archived', updatedAt: trx.fn.now() });
    } else {
      await trx('pod')
        .where({ entityId: duplicateId })
        .update({ entityId: primaryId, updatedAt: trx.fn.now() });
    }

    // 5. Mark duplicate as merged (non-lossy)
    await trx('entity')
      .where({ id: duplicateId })
      .update({ mergedWith: primaryId });
  });

  // Deduplicate relations outside transaction (reads + deletes, safe to retry)
  await deduplicateRelations(primaryId);

  // Merge entity types (calls updateEntityTypes which does its own read-then-write)
  const duplicateTypes = safeParseEntityTypes(duplicate);
  for (const type of duplicateTypes) {
    await updateEntityTypes(primaryId, type);
  }

  console.log(`[entity-merge] Merged ${duplicateId} (${duplicate.name}) into ${primaryId} (${primary.name})`);

  return { ...primary, mentionCount: newMentionCount };
}

async function deduplicateRelations(entityId) {
  const relations = await cortexDb('relation')
    .where(function () {
      this.where({ sourceId: entityId }).orWhere({ targetId: entityId });
    })
    .whereNull('invalidAt');

  const groups = groupBy(relations, (r) => `${r.sourceId}-${r.targetId}-${r.relationType}`);

  for (const group of Object.values(groups)) {
    if (group.length <= 1) continue;

    const [keep, ...dupes] = sortBy(group, 'id');
    const totalMentions = sumBy(group, 'mentionCount');

    await cortexDb('relation').where({ id: keep.id }).update({ mentionCount: totalMentions });
    await cortexDb('relation').whereIn('id', dupes.map((d) => d.id)).del();
  }
}

async function followMergeChain(entityId) {
  let entity = await findById(entityId);
  const chain = [entity?.id];

  while (entity?.mergedWith) {
    entity = await findById(entity.mergedWith);
    if (entity) chain.push(entity.id);
  }

  return { canonical: entity, chain };
}

export { mergeEntities, followMergeChain };
