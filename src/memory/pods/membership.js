import cortexDb from '../../db/cortex.js';

import { incrementCounters } from './store.js';

// ── Attach ────────────────────────────────────────────────────────────

// Idempotent attach. The unique (pod_id, member_type, member_id)
// constraint makes double-attaches no-ops; we still bump counters only on
// the first attach by checking the row count.
async function attach(podId, memberType, memberId, role = 'primary', db = cortexDb) {
  const { rowCount } = await db.raw(
    `INSERT INTO pod_membership (pod_id, member_type, member_id, role)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (pod_id, member_type, member_id) DO NOTHING`,
    [podId, memberType, memberId, role],
  );

  // Only a PRIMARY membership counts. A 'mention' records that a fact passed
  // through this pod without claiming it, which is what lets a session pod keep
  // a record of its own work while the project pod stays the single owner — the
  // double-counting that made one fact read as "1 fact" in two different pods
  // is exactly what the role is for.
  if (rowCount > 0 && role === 'primary') {
    if (memberType === 'fact') await incrementCounters(podId, { facts: 1 }, db);
    else if (memberType === 'document') await incrementCounters(podId, { docs: 1 }, db);
  }

  return { attached: rowCount > 0 };
}

const attachFact = (podId, factId, role, db = cortexDb) => attach(podId, 'fact', factId, role, db);
const attachDocument = (podId, documentId, role, db = cortexDb) => attach(podId, 'document', documentId, role, db);
const attachEntity = (podId, entityId, role, db = cortexDb) => attach(podId, 'entity', entityId, role, db);

// ── Detach ────────────────────────────────────────────────────────────

async function detach(podId, memberType, memberId) {
  const removed = await cortexDb('pod_membership')
    .where({ podId, memberType, memberId })
    .del();

  if (removed > 0) {
    if (memberType === 'fact') await incrementCounters(podId, { facts: -1 });
    else if (memberType === 'document') await incrementCounters(podId, { docs: -1 });
  }

  return { detached: removed > 0 };
}

// ── List ──────────────────────────────────────────────────────────────

// Members of a pod, joined to the underlying table per memberType.
// Returns the member rows (fact/document/entity) directly, not the
// junction rows, since callers want the content.
async function listMembers(podId, { memberType, limit = 20 } = {}) {
  if (!memberType) {
    throw new Error('listMembers requires a memberType filter');
  }

  const table = memberType; // 'fact' | 'document' | 'entity' — matches table names

  return cortexDb(`${table} as t`)
    .join('pod_membership as pm', function () {
      this.on('pm.member_id', '=', 't.id')
          .andOnVal('pm.member_type', '=', memberType);
    })
    .where('pm.pod_id', podId)
    .orderBy('pm.createdAt', 'desc')
    .limit(limit)
    .select('t.*', 'pm.role as podRole', 'pm.createdAt as attachedAt');
}

// Reverse lookup: what pods is this fact/document/entity in?
async function listPodsForMember(memberType, memberId) {
  return cortexDb('pod as p')
    .join('pod_membership as pm', 'pm.pod_id', 'p.id')
    .where('pm.memberType', memberType)
    .where('pm.memberId', memberId)
    .select('p.*', 'pm.role as podRole');
}

// Fact membership IDs only — used by search to constrain candidates
// when a podIds filter is passed.
async function factIdsInPod(podId) {
  const rows = await cortexDb('pod_membership')
    .where({ podId, memberType: 'fact' })
    .pluck('memberId');
  return rows;
}

export {
  attach,
  attachFact,
  attachDocument,
  attachEntity,
  detach,
  listMembers,
  listPodsForMember,
  factIdsInPod,
};
