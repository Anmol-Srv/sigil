import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PKG_ROOT } from './paths.js';

/**
 * The installed Sigil version from package.json, cached after first read.
 * Returns 'unknown' if package.json can't be read.
 */
let cached;
export function getSigilVersion() {
  if (cached) return cached;
  try {
    cached = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    cached = 'unknown';
  }
  return cached;
}
