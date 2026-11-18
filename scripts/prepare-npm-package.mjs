#!/usr/bin/env node
// Shape package.json for `npm publish` (CI only — never commit the result).
//
// The npm package's `sigil` bin is a dependency-free door into ~/.sigil/app
// (src/npm-entry.js); it never runs Sigil from node_modules. So the published
// package drops runtime dependencies: `npm i -g @anmol-srv/sigil` takes a
// second instead of downloading PGlite, pg, knex and the Iroh native binary
// twice. The git release branch keeps the full package.json — that's where
// `npm install --omit=dev` runs for real.
import { readFileSync, writeFileSync } from 'node:fs';

const url = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(url, 'utf8'));
for (const key of ['dependencies', 'optionalDependencies', 'devDependencies']) delete pkg[key];
if (pkg.bin?.sigil !== 'dist/npm-entry.js') {
  console.error(`refusing to publish: bin.sigil is ${pkg.bin?.sigil}, expected dist/npm-entry.js`);
  process.exit(1);
}
writeFileSync(url, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package.json ready for npm: ${pkg.name}@${pkg.version} (no runtime dependencies)`);
