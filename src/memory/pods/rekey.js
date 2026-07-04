/**
 * Re-key legacy PATH-keyed project pods to their stable remote identity.
 *
 * P1 (deriveProjectIdentity) changed how NEW project pods are keyed: their
 * externalId is now the normalized git remote (e.g. `github.com/owner/repo`)
 * instead of the local filesystem path. But P1 only affects pods created
 * AFTER the change — project pods that already exist keep their legacy path
 * externalId (`/Users/.../repo`). Those legacy pods never collide with the
 * new remote key, so the same repo silently splits into two pods: the old
 * path-keyed one (holding all the durable history) and a fresh remote-keyed
 * one. This module closes that gap: a one-shot, explicit maintenance pass
 * that re-derives each legacy pod's identity from its recorded git_root and
 * either re-keys it in place or merges it into the already-existing
 * remote-keyed pod for that identity.
 *
 * It is deliberately a manual command (not an automatic knex migration):
 * re-keying depends on the local filesystem still being present (we re-read
 * the repo's remote), and merging moves membership rows — both warrant an
 * explicit, inspectable, dry-runnable operation rather than a silent
 * schema migration that runs on every `sigil migrate`.
 */

import cortexDbDefault from '../../db/cortex.js';
import { deriveProjectIdentity } from './kinds/project.js';

// A project pod's externalId is "legacy / path-keyed" when it is an absolute
// filesystem path rather than a remote identity. Remote identities always
// contain a host + at least one slash and never start with `/` (or a Windows
// drive). Treat anything that looks like an absolute path as legacy.
export function isPathKeyed(externalId) {
  if (!externalId || typeof externalId !== 'string') return false;
  // POSIX absolute path, or Windows drive path (C:\ or C:/).
  return externalId.startsWith('/') || /^[A-Za-z]:[\\/]/.test(externalId);
}

function parseAttrs(attrs) {
  if (!attrs) return {};
  if (typeof attrs === 'object') return attrs;
  try { return JSON.parse(attrs); } catch { return {}; }
}

/**
 * Plan the re-key for a single legacy pod, WITHOUT touching the DB beyond the
 * read needed to find a collision target. Returns a decision object:
 *   { action: 'rekey'  , pod, newExternalId, target: null }
 *   { action: 'merge'  , pod, newExternalId, target }      // remote pod exists
 *   { action: 'skip'   , pod, reason }                     // can't / needn't
 */
export async function planPod(pod, { db = cortexDbDefault } = {}) {
  if (!isPathKeyed(pod.externalId)) {
    return { action: 'skip', pod, reason: 'already remote-keyed' };
  }

  const attrs = parseAttrs(pod.attrs);
  const gitRoot = attrs.git_root || attrs.root_path || pod.externalId;

  // Re-derive identity from the repo on disk. deriveProjectIdentity is pure /
  // synchronous / never throws; with the cwd at the repo root it reads the
  // remote (the P1 default). If the path is gone or has no remote it falls
  // back to the path again — i.e. nothing changed, so there's nothing to do.
  const identity = deriveProjectIdentity(gitRoot);
  if (isPathKeyed(identity)) {
    return { action: 'skip', pod, reason: 'no git remote (path gone or no origin)' };
  }
  if (identity === pod.externalId) {
    return { action: 'skip', pod, reason: 'identity unchanged' };
  }

  // Does a pod already hold this remote identity in the same namespace?
  const target = await db('pod')
    .where({ podType: 'project', externalId: identity, namespace: pod.namespace })
    .whereNot({ id: pod.id })
    .first();

  if (target) {
    return { action: 'merge', pod, newExternalId: identity, target };
  }
  return { action: 'rekey', pod, newExternalId: identity, target: null };
}

/**
 * Move every membership row from `fromPod` to `toPod`, deduping against rows
 * the target already has, then recount the target's cached counters and delete
 * the now-empty source pod. Runs in a single transaction. Returns the number of
 * membership rows moved.
 */
export async function mergePods(fromPod, toPod, { db = cortexDbDefault } = {}) {
  return db.transaction(async (trx) => {
    // Move memberships that the target doesn't already have (dedup on the
    // unique (pod_id, member_type, member_id)).
    const moved = await trx.raw(
      `UPDATE pod_membership AS m
          SET pod_id = ?
        WHERE m.pod_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM pod_membership AS e
             WHERE e.pod_id = ?
               AND e.member_type = m.member_type
               AND e.member_id = m.member_id
          )`,
      [toPod.id, fromPod.id, toPod.id],
    );

    // Drop any leftover (duplicate) memberships still pointing at the source.
    await trx('pod_membership').where({ podId: fromPod.id }).del();

    // Recount the target's cached counters from the source of truth.
    await trx.raw(
      `UPDATE pod p SET
         member_fact_count = (SELECT count(*) FROM pod_membership WHERE pod_id = p.id AND member_type = 'fact'),
         member_doc_count  = (SELECT count(*) FROM pod_membership WHERE pod_id = p.id AND member_type = 'document'),
         updated_at = NOW()
       WHERE p.id = ?`,
      [toPod.id],
    );

    // The source pod is now empty — remove it so the repo has exactly one pod.
    await trx('pod').where({ id: fromPod.id }).del();

    return moved.rowCount ?? 0;
  });
}

/**
 * Re-key a single pod in place (no collision): update externalId to the remote
 * identity. attrs.root_path / git_root are left untouched — they still hold the
 * (valid) local path for display.
 */
export async function rekeyPodInPlace(pod, newExternalId, { db = cortexDbDefault } = {}) {
  await db('pod')
    .where({ id: pod.id })
    .update({ externalId: newExternalId, updatedAt: db.fn.now() });
}

/**
 * Run the full re-key pass over every project pod.
 *   opts.dryRun  — compute and return the plan, perform ZERO writes.
 *   opts.db      — injectable db (tests).
 * Returns { planned, rekeyed, merged, skipped, actions } where `actions` is the
 * per-pod decision list (always populated, in dry-run and live alike).
 */
export async function rekeyLegacyProjectPods({ dryRun = true, db = cortexDbDefault } = {}) {
  const pods = await db('pod').where({ podType: 'project' }).orderBy('createdAt', 'asc');

  const actions = [];
  let rekeyed = 0;
  let merged = 0;
  let skipped = 0;

  for (const pod of pods) {
    const plan = await planPod(pod, { db });
    actions.push({
      uid: pod.uid,
      name: pod.name,
      from: pod.externalId,
      to: plan.newExternalId ?? null,
      action: plan.action,
      reason: plan.reason ?? null,
      targetUid: plan.target?.uid ?? null,
    });

    if (plan.action === 'skip') { skipped++; continue; }

    if (!dryRun) {
      if (plan.action === 'merge') {
        await mergePods(pod, plan.target, { db });
      } else if (plan.action === 'rekey') {
        await rekeyPodInPlace(pod, plan.newExternalId, { db });
      }
    }
    if (plan.action === 'merge') merged++;
    else if (plan.action === 'rekey') rekeyed++;
  }

  return { planned: actions.length, rekeyed, merged, skipped, actions, dryRun };
}
