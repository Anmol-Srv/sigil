// Reliability-suite setup — runs (via vitest setupFiles) BEFORE any test
// module imports, so src/config.js reads these when it's first loaded.
//
// Hermetic embedding config: force local Ollama mxbai-embed-large (1024-dim,
// matching Sigil's pinned EMBEDDING_DIM and the vector(1024) production schema)
// regardless of the developer's real ~/.sigil/.env (which may point at a paid
// cloud model). Tests must be free, offline, and reproducible — no cloud calls,
// no API keys. nomic-embed-text (768) is deliberately NOT used: the product is
// hard-pinned to 1024, so a 768 harness tests a path that can't ship.
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.EMBEDDING_MODEL = 'mxbai-embed-large';
process.env.EMBEDDING_DIMENSIONS = '1024';
process.env.OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
// LLM paths (AUDM-decide, classify, router, synthesis) are stubbed/bypassed
// per-suite; set a provider so config import never throws.
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama';
// Point the test DB away from the dev singleton; harness injects in-memory.
process.env.SIGIL_PGLITE_PATH = process.env.SIGIL_PGLITE_PATH || '__reliability_inmemory__';
