import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PKG_ROOT } from '../../lib/paths.js';

let cachedVersion;
function getVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export function registerPing(registry, { startedAt }) {
  registry.register('ping', () => ({
    ok: true,
    version: getVersion(),
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    node: process.version,
  }));
}
