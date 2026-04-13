import { chunk } from 'lodash-es';

const BATCH_SIZE = 50;

async function embedBatch(texts, { model, ollamaHost }) {
  const batches = chunk(texts, BATCH_SIZE);
  const allEmbeddings = [];

  for (const batch of batches) {
    const res = await fetch(`${ollamaHost}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    allEmbeddings.push(...data.embeddings);
  }

  return allEmbeddings;
}

export { embedBatch };
