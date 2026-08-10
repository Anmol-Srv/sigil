import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 10000,
    // Seven suites boot their own in-process PGlite (a WASM Postgres) in
    // beforeAll. Vitest runs files in parallel, so those boots compete for CPU
    // and blow the 10s default hookTimeout — the whole suite goes red with
    // "Hook timed out in 10000ms" while every assertion is actually fine, and
    // it only reproduces on a loaded machine. The tests themselves stay on the
    // 10s budget; only setup gets the room it genuinely needs.
    hookTimeout: 60000,
    include: ['src/**/*.test.js'],
  },
});
