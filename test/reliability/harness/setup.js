// Reliability-suite setup — runs (via vitest setupFiles) BEFORE any test
// module imports, so config is seeded before src/config.js is first read.
//
// config.json is the single source of truth (no env override anymore), so we
// seed the in-memory config via the test seam instead of process.env. Hermetic
// embedding config: force local Ollama mxbai-embed-large (1024-dim, matching
// Sigil's pinned EMBEDDING_DIM and the vector(1024) production schema) regardless
// of the developer's real config.json (which may point at a paid cloud model).
// Tests must be free, offline, and reproducible — no cloud calls, no API keys.
import { __setTestConfig } from '../../../src/setup/config-store.js';

const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
__setTestConfig({
  database: { mode: 'embedded', url: null },
  embedding: { provider: 'ollama', model: 'mxbai-embed-large', host: ollamaHost },
  // Generation is intentionally absent: this gate covers the retained memory
  // core, which depends on embeddings but never starts an LLM session.
  llm: { provider: '' },
});

// Embedded DB path redirect stays an env var — it's an allowlisted launch/test
// override read directly by the PGlite adapter (module-level, before imports),
// not a config value. Points the test DB away from the dev singleton.
process.env.SIGIL_PGLITE_PATH = process.env.SIGIL_PGLITE_PATH || '__reliability_inmemory__';
