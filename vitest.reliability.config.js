import { defineConfig } from 'vitest/config';

// Separate lane from the fast unit suite (vitest.config.js). These run the
// REAL retrieval stack against in-memory PGlite + real Ollama embeddings, so
// they're slower and serialized. `npm run test:reliability`.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/reliability/**/*.test.js'],
    setupFiles: ['./test/reliability/harness/setup.js'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // One PGlite + one Ollama at a time — deterministic, no cross-suite DB
    // contention. (Vitest 4: serialize files via fileParallelism.)
    fileParallelism: false,
  },
});
