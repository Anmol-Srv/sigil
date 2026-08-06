import { chunk } from '../../collection.js';
import config from '../../../config.js';

const BATCH_SIZE = 50;
// Ollama unloads an idle model after 5 minutes by default. The read hook embeds
// one query per prompt and has a ~9s budget, so a mid-session unload makes the
// NEXT prompt pay a cold model load and silently miss its budget — the "recall
// works sometimes" failure. Hold the embedder resident across a work session.
// ponytail: fixed 30m; make it configurable if someone needs the VRAM back.
const KEEP_ALIVE = '30m';

async function embedBatch(texts, { model, ollamaHost }) {
  const batches = chunk(texts, BATCH_SIZE);
  const allEmbeddings = [];

  for (const batch of batches) {
    const res = await fetch(`${ollamaHost}/api/embed`, {
      method: 'POST',
      // Local embedding — use the longer CLI budget, not the network timeout.
      signal: AbortSignal.timeout(config.llm.cliTimeout),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch, keep_alive: KEEP_ALIVE }),
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
