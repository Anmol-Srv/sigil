import { getSigilVersion } from '../../lib/version.js';

export function registerPing(registry, { startedAt }) {
  registry.register('ping', () => ({
    ok: true,
    version: getSigilVersion(),
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    node: process.version,
  }));
}
