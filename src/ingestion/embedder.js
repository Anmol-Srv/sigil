import config from '../config.js';
import { getEmbedder, detectEmbeddingProvider } from '../lib/llm/registry.js';
import { embedBatchCached } from './embedding-cache.js';

const { dimensions } = config.embedding;

async function embed(text) {
  const [result] = await embedBatch([text]);
  return result;
}

async function embedBatch(texts) {
  if (!texts.length) return [];

  const provider = await detectEmbeddingProvider();
  const batchFn = await getEmbedder(provider);
  const model = config.embedding.model;

  // Re-embedding the same text is wasteful — check the cache first
  return embedBatchCached(texts, provider, model, batchFn, config.embedding);
}

export { embed, embedBatch, dimensions };
