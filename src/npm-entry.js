#!/usr/bin/env node
/**
 * The `sigil` bin of the npm package (`npm i -g @anmol-srv/sigil`, `npx …`).
 *
 * Deliberately tiny and dependency-free: the published npm package carries no
 * runtime dependencies, because it never runs Sigil itself. From a package-
 * manager directory it is a door into the single install at ~/.sigil/app (see
 * lib/npm-door.js). Anywhere else (a source checkout, `npm link`) it just runs
 * the CLI that sits next to it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

import { isDoorRoot, runDoor } from './lib/npm-door.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = dirname(HERE);

if (process.env.SIGIL_NO_DOOR !== '1' && isDoorRoot(PKG_DIR, join(homedir(), '.sigil', 'app'))) {
  let version = '0.0.0';
  try { version = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version; } catch { /* keep 0.0.0 */ }
  runDoor({ pkgRoot: PKG_DIR, version, args: process.argv.slice(2) });
} else {
  // A computed specifier keeps the bundler from inlining the whole CLI here.
  const cli = join(HERE, 'cli.js');
  await import(pathToFileURL(cli).href);
}
