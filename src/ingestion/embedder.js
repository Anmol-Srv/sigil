import config from '../config.js';
import { getEmbedder, detectEmbeddingProvider } from '../lib/llm/registry.js';

const { dimensions } = config.embedding;

async function embed(text) {
  const [result] = await embedBatch([text]);
  return result;
}

async function embedBatch(texts) {
  const provider = await detectEmbeddingProvider();
  const batchFn = await getEmbedder(provider);
  return batchFn(texts, config.embedding);
}

export { embed, embedBatch, dimensions };
