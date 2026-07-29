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

async function upsert({ sourcePath, sourceType, title = null, contentHash, namespace }) {
  return cortexDb.transaction(async (trx) => {
    const existing = await trx('document').where({ sourcePath, namespace }).first();
    if (existing?.contentHash === contentHash) {
      return { doc: existing, changed: false };
    }

    if (existing) {
      const [doc] = await trx('document')
        .where({ id: existing.id })
        .update({
          sourceType,
          title,
          contentHash,
          lastIngestedAt: trx.fn.now(),
          updatedAt: trx.fn.now(),
        })
        .returning('*');
      return { doc, changed: true };
    }

    const [doc] = await trx('document')
      .insert({
        uid: `doc-${nanoid(16)}`,
        sourcePath,
        sourceType,
        title,
        contentHash,
        namespace,
        lastIngestedAt: trx.fn.now(),
      })
      .returning('*');
    return { doc, changed: true };
  });
}

async function updateCounts(documentId, { chunkCount, factCount }) {
  const patch = {};
  if (chunkCount !== undefined) patch.chunkCount = chunkCount;
  if (factCount !== undefined) patch.factCount = factCount;
  if (!Object.keys(patch).length) return;
  await cortexDb('document')
    .where({ id: documentId })
    .update(patch);
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

async function listDocuments({ namespace, sourceType, limit = 100 } = {}) {
  const query = cortexDb('document').orderBy('createdAt', 'desc').limit(limit);
  if (namespace) query.where({ namespace });
  if (sourceType) query.where({ sourceType });
  return query;
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

// Persist optional source metadata supplied by an explicit ingestion caller.
async function updateSourceMetadata(documentId, metadata) {
  if (!metadata) return;
  const patch = {};
  if (metadata && Object.keys(metadata).length) patch.sourceMetadata = JSON.stringify(metadata);
  if (!Object.keys(patch).length) return;
  await cortexDb('document').where({ id: documentId }).update(patch);
}

export { findBySourcePath, findByUid, upsert, updateCounts, resetHash, updateSourceMetadata, getStats, listDocuments, deleteDocument };
