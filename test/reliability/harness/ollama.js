// Ollama availability guard. The reliability suites run against REAL
// embeddings (nomic-embed-text); if Ollama isn't up with that model, the
// suites skip with a clear message rather than failing spuriously. CI runs
// with Ollama present so the gate is real there.

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

let cached = null;

export async function ollamaReady() {
  if (cached !== null) return cached;
  try {
    const res = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) { cached = false; return cached; }
    const json = await res.json();
    cached = (json.models || []).some((m) => /nomic-embed-text/.test(m.name || m.model || ''));
  } catch {
    cached = false;
  }
  return cached;
}

export const OLLAMA_SKIP_MSG =
  'Ollama + nomic-embed-text not available — skipping real-embedding reliability suite. '
  + 'Install: `ollama pull nomic-embed-text` and ensure `ollama serve` is running.';
