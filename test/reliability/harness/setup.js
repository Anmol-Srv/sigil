// Reliability-suite setup — runs (via vitest setupFiles) BEFORE any test
// module imports, so src/config.js reads these when it's first loaded.
//
// Hermetic embedding config: force local Ollama nomic-embed-text (768-dim,
// matching the vector(768) column) regardless of the developer's real
// ~/.sigil/.env (which may point at a paid cloud model). Tests must be free,
// offline, and reproducible — no cloud calls, no API keys.
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.EMBEDDING_MODEL = 'nomic-embed-text';
process.env.EMBEDDING_DIMENSIONS = '768';
process.env.OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
// LLM paths (AUDM-decide, classify, router, synthesis) are stubbed/bypassed
// per-suite; set a provider so config import never throws.
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama';
// Point the test DB away from the dev singleton; harness injects in-memory.
process.env.SIGIL_PGLITE_PATH = process.env.SIGIL_PGLITE_PATH || '__reliability_inmemory__';
