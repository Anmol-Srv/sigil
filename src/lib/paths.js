/**
 * Resolve filesystem paths that are stable across both source and bundled distribution.
 *
 * In dev:    src/memory/cognitive/query-router.js → 3 levels up to package root
 * In dist:   dist/cli.js (everything bundled into one file) → 1 level up to package root
 *
 * Walking up from import.meta.url until we hit a package.json gives us the package
 * root regardless of where this file ends up after bundling.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

function findPackageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up to 10 levels max to avoid infinite loops on weird filesystems
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'prompts'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: use cwd (will fail loudly on prompt load, easier to debug)
  return process.cwd();
}

const PKG_ROOT = findPackageRoot();

export const PROMPTS_DIR = join(PKG_ROOT, 'prompts');
export const MIGRATIONS_DIR = join(PKG_ROOT, 'src', 'db', 'migrations');
export { PKG_ROOT };
