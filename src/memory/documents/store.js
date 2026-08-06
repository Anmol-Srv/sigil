import { nanoid } from 'nanoid';

import cortexDb from '../../db/cortex.js';

async function findBySourcePath(sourcePath) {
  const [doc] = await cortexDb('document').where({ sourcePath });
  return doc || null;
}

async function findByUid(uid) {
  const [doc] = await cortexDb('document').where({ uid });
  return doc || null;
}

async function upsert({ sourcePath, sourceType, title = null, contentHash, namespace, content = null }) {
  const uid = `doc-${nanoid(16)}`;

  // ON CONFLICT target matches the (source_path, namespace) composite unique
  // (migration 20260504120000). The same path can live in multiple namespaces;
  // the upsert only collapses dupes within one.
  const { rows: [doc] } = await cortexDb.raw(`
    INSERT INTO document (uid, source_path, source_type, title, content_hash, content, namespace, last_ingested_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
    ON CONFLICT (source_path, namespace) DO UPDATE SET
      title = EXCLUDED.title,
      content_hash = EXCLUDED.content_hash,
      content = EXCLUDED.content,
      last_ingested_at = NOW(),
      updated_at = NOW()
    RETURNING *, (xmax = 0) AS "isNew", content_hash != ? AS "contentChanged"
  `, [uid, sourcePath, sourceType, title, contentHash, content, namespace, contentHash]);

  const isNew = doc.isNew;
  const changed = isNew || doc.contentChanged;

  return { doc, changed };
}

async function updateCounts(documentId, { chunkCount, factCount }) {
  await cortexDb('document')
    .where({ id: documentId })
    .update({ chunkCount, factCount });
}

async function getStats(namespace) {
  const query = cortexDb('document');
  if (namespace) query.where({ namespace });

  const docs = await query;
  return {
    documentCount: docs.length,
    totalChunks: docs.reduce((sum, d) => sum + (d.chunkCount || 0), 0),
    totalFacts: docs.reduce((sum, d) => sum + (d.factCount || 0), 0),
  };
}

async function listDocuments({ namespace, sourceType, limit = 100, podIds = null } = {}) {
  const query = cortexDb('document')
    // Never select `content` in a LIST — a listing of 100 documents would drag
    // every byte of every one of them across the wire for a title.
    .select('id', 'uid', 'title', 'sourceType', 'sourcePath', 'namespace', 'chunkCount', 'factCount', 'lastIngestedAt', 'createdAt')
    .orderBy('lastIngestedAt', 'desc')
    .limit(limit);
  if (namespace) query.where({ namespace });
  if (sourceType) query.where({ sourceType });
  // Pod scope: [] means "scope requested but nothing active" → no documents,
  // which is precision-first and matches how fact search treats an empty scope.
  if (Array.isArray(podIds)) {
    if (podIds.length === 0) return [];
    query.whereIn('id', cortexDb('pod_membership')
      .select('memberId')
      .where({ memberType: 'document' })
      .whereIn('podId', podIds));
  }
  return query;
}

/**
 * Fetch one document WHOLE, by uid or id.
 *
 * Prefers the stored `content` column. Documents ingested before that column
 * existed fall back to reassembling their chunks in order — approximate at the
 * seams, because the chunker overlaps adjacent chunks by ~50 tokens, so we trim
 * the repeated boundary rather than emitting it twice. Re-ingest to get exact
 * bytes. Reported via `exact` so callers can say which one they got.
 */
async function getDocument({ uid, id, maxChars = null } = {}) {
  const doc = uid ? await findByUid(uid) : (await cortexDb('document').where({ id }))[0];
  if (!doc) return null;

  let content = doc.content ?? null;
  let exact = content != null;

  if (!exact) {
    const chunks = await cortexDb('chunk')
      .where({ documentId: doc.id })
      .orderBy('chunkIndex')
      .select('content');
    content = chunks.reduce((acc, c) => joinOverlapping(acc, c.content), '');
  }

  const truncated = maxChars != null && content.length > maxChars;
  return {
    uid: doc.uid,
    id: doc.id,
    title: doc.title,
    sourceType: doc.sourceType,
    sourcePath: doc.sourcePath,
    namespace: doc.namespace,
    chunkCount: doc.chunkCount ?? 0,
    factCount: doc.factCount ?? 0,
    lastIngestedAt: doc.lastIngestedAt ?? null,
    exact,
    truncated,
    totalChars: content.length,
    content: truncated ? content.slice(0, maxChars) : content,
  };
}

// Append `next` to `acc`, dropping the longest suffix of `acc` that `next`
// repeats. The chunker's overlap is bounded (~50 tokens), so scanning a bounded
// window is enough — no need to consider the whole accumulated string.
// ponytail: longest-boundary-match, not a diff. Only runs for pre-migration
// documents; anything ingested since has exact content stored.
const MAX_OVERLAP_SCAN = 1200;
function joinOverlapping(acc, next) {
  if (!acc) return next;
  const window = Math.min(acc.length, next.length, MAX_OVERLAP_SCAN);
  for (let n = window; n > 0; n--) {
    if (acc.endsWith(next.slice(0, n))) return acc + next.slice(n);
  }
  return `${acc}\n${next}`;
}

/** Pods a document belongs to — the "which project is this doc for" answer. */
async function podsForDocument(documentId) {
  return cortexDb('pod_membership')
    .join('pod', 'pod.id', 'pod_membership.pod_id')
    .where({ 'pod_membership.member_type': 'document', 'pod_membership.member_id': documentId })
    .select('pod.uid', 'pod.name', 'pod.pod_type', 'pod_membership.role');
}

async function deleteDocument(documentId) {
  await cortexDb('chunk').where({ documentId }).del();
  await cortexDb('document').where({ id: documentId }).del();
}

async function resetHash(documentId) {
  await cortexDb('document')
    .where({ id: documentId })
    .update({ contentHash: null });
}

// Persist the metadata payload that flows through the ingest pipeline.
// Previously dropped on the floor after `parse()` consumed its format hint;
// now lands on the document row so pod attachment can derive source-
// instance context from it (which Slack workspace, which sender, etc.).
// connectionId is optional and references the `connection` table when the
// document came in through a registered connector.
async function updateSourceMetadata(documentId, metadata, connectionId = null) {
  if (!metadata && !connectionId) return;
  const patch = {};
  if (metadata && Object.keys(metadata).length) patch.sourceMetadata = JSON.stringify(metadata);
  if (connectionId) patch.connectionId = connectionId;
  if (!Object.keys(patch).length) return;
  await cortexDb('document').where({ id: documentId }).update(patch);
}

export {
  findBySourcePath, findByUid, upsert, updateCounts, resetHash, updateSourceMetadata,
  getStats, listDocuments, deleteDocument, getDocument, podsForDocument, joinOverlapping,
};
