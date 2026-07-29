/**
 * Direct atomic-memory writer.
 *
 * Callers must pass statements that are already atomic. This service performs
 * one batch embedding and deterministic exact-duplicate suppression. It
 * intentionally does not import the document ingestion,
 * classifier, LLM, graph, contextualizer, or hot-context modules.
 *
 *   atomic strings
 *        |
 *        v
 *   mask + batch embed        (outside transaction)
 *        |
 *        v
 *   deterministic save       (sequential inside one transaction)
 */
import cortexDb from '../../db/cortex.js';
import config from '../../config.js';
import { embedBatchOrThrow } from '../../ingestion/embedder.js';
import { maskSecrets } from '../../hooks/secret-mask.js';
import { findExactFact, saveFactDeterministic } from './store.js';

export async function saveAtomicMemories(memories, {
  namespace = config.defaults.namespace,
  category = 'key_insight',
  confidence = 'high',
  importance = 'supplementary',
} = {}) {
  const texts = (Array.isArray(memories) ? memories : [])
    .filter((value) => typeof value === 'string')
    .map((value) => maskSecrets(value.trim()))
    .filter(Boolean);

  if (!texts.length) {
    return {
      counts: { total: 0, added: 0, skipped: 0 },
      results: [],
    };
  }

  // Check exact duplicates before provider work. This avoids paying for an
  // embedding when the normalized statement is already stored and collapses
  // repeats within the same request to one embedding.
  const knownByKey = new Map();
  const uniqueNew = [];
  const newKeys = new Set();
  for (const text of texts) {
    const key = normalize(text);
    if (knownByKey.has(key) || newKeys.has(key)) continue;
    const existing = await findExactFact(text, namespace);
    if (existing) knownByKey.set(key, existing);
    else {
      newKeys.add(key);
      uniqueNew.push({ key, text });
    }
  }

  // Provider work must never hold a database transaction open.
  const uniqueEmbeddings = uniqueNew.length
    ? await embedBatchOrThrow(uniqueNew.map((item) => item.text))
    : [];
  const embeddingByKey = new Map(uniqueNew.map((item, index) => [item.key, uniqueEmbeddings[index]]));
  const results = [];
  const writtenByKey = new Map();
  await cortexDb.transaction(async (trx) => {
    for (let i = 0; i < texts.length; i++) {
      const key = normalize(texts[i]);
      const known = knownByKey.get(key) || writtenByKey.get(key);
      const result = known
        ? {
            action: 'SKIP',
            existing: known,
            dedup: { topSimilarity: null, matchCount: 1, decision: 'normalized-exact-duplicate' },
          }
        : await saveFactDeterministic({
            content: texts[i],
            category,
            confidence,
            importance,
            namespace,
            sourceSection: 'direct',
            embedding: embeddingByKey.get(key),
          }, trx);
      results.push(result);
      if (result.fact) writtenByKey.set(key, result.fact);
      else if (result.existing) writtenByKey.set(key, result.existing);

    }
  });

  return {
    counts: {
      total: results.length,
      added: results.filter((result) => result.action === 'ADD').length,
      skipped: results.filter((result) => result.action === 'SKIP').length,
    },
    results,
  };
}

function normalize(text) {
  return String(text).trim().toLowerCase();
}
