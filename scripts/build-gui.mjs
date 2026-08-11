#!/usr/bin/env node
/**
 * Bundle the Graph React island into src/gui/web/vendor/.
 *
 * The dashboard is served straight from src/gui/web (resolveWebDir prefers
 * dist/gui, which we don't produce), so the bundle is a committed artifact
 * alongside the vendored force-graph UMD — same contract, one served directory,
 * no server change. `npm run build` regenerates it, so CI can never ship a
 * bundle that lags the JSX.
 */
import { build } from 'esbuild';

const OUT = 'src/gui/web/vendor/graph-island.js';

const result = await build({
  entryPoints: ['src/gui/web/graph/GraphIsland.jsx'],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  // React reads this to drop dev-only warnings and invariant strings.
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0].bytes;
console.log(`  ${OUT.padEnd(45)} ${(bytes / 1024).toFixed(1).padStart(7)} KB`);
