import { chunk } from '../../collection.js';
import config from '../../../config.js';

const BATCH_SIZE = 50;

// Build an Authorization header from a configured credential so the embedder
// can talk to an Ollama endpoint behind a reverse proxy (Traefik basicAuth, a
// bearer gateway, etc.). Accepts:
//   "user:pass"        -> Basic base64(user:pass)
//   "Basic …"/"Bearer …" -> sent verbatim
//   anything else       -> Bearer <token>
// Empty/undefined -> no header (plain local Ollama, unchanged behaviour).
function authHeader(auth) {
  if (!auth) return null;
  if (/^(Basic|Bearer)\s/i.test(auth)) return auth;
  if (auth.includes(':')) return 'Basic ' + Buffer.from(auth).toString('base64');
  return 'Bearer ' + auth;
}

async function embedBatch(texts, { model, ollamaHost, ollamaAuth }) {
  const batches = chunk(texts, BATCH_SIZE);
  const allEmbeddings = [];

  const headers = { 'Content-Type': 'application/json' };
  const auth = authHeader(ollamaAuth);
  if (auth) headers.Authorization = auth;

  for (const batch of batches) {
    const res = await fetch(`${ollamaHost}/api/embed`, {
      method: 'POST',
      // Local embedding — use the longer CLI budget, not the network timeout.
      signal: AbortSignal.timeout(config.llm.cliTimeout),
      headers,
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

export { embedBatch, authHeader };
