/**
 * Active-namespace resolution (per-project).
 *
 * A single Sigil install historically resolves ONE namespace from
 * `config.defaults.namespace` (DEFAULT_NAMESPACE env, else 'default'). That
 * works for a solo install but can't let a team repo pin a shared namespace
 * while personal projects stay personal — without passing `--namespace`
 * everywhere.
 *
 * This resolver derives the active namespace per-project, highest precedence
 * first:
 *   1. Explicit value (CLI `--namespace=<ns>`) — always wins.
 *   2. `SIGIL_NAMESPACE` env — per-shell / per-CI override.
 *   3. Committed marker `.sigil/namespace` at the repo root — a file whose
 *      trimmed contents are the namespace. A team commits this so everyone on
 *      the repo shares a namespace automatically (the new capability).
 *   4. `config.defaults.namespace` (DEFAULT_NAMESPACE env, else 'default') —
 *      the existing fallback, unchanged.
 *
 * With no explicit value, no SIGIL_NAMESPACE, and no marker, this returns
 * exactly `config.defaults.namespace` — identical behavior to today for
 * single-namespace installs.
 *
 * Pure / synchronous / never throws: the marker read is best-effort (a missing
 * or unreadable file falls through to the next tier), so this is safe to call
 * from any code path, including hooks.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import config from '../config.js';
import { deriveProjectRoot } from './pods/kinds/project.js';

/**
 * Read the committed `.sigil/namespace` marker from a project root.
 * Returns the trimmed contents, or null when absent / empty / unreadable.
 * Never throws.
 */
export function readNamespaceMarker(projectRoot) {
  if (!projectRoot) return null;
  try {
    const raw = readFileSync(join(projectRoot, '.sigil', 'namespace'), 'utf8');
    const trimmed = raw.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the active namespace for an operation.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]      Working directory of the operation; used to
 *                                 locate the repo root (git toplevel via
 *                                 deriveProjectRoot) for the marker read.
 * @param {string} [opts.explicit] Explicit namespace (e.g. CLI --namespace);
 *                                 wins over everything when truthy.
 * @returns {string} the resolved namespace (never empty).
 */
export function resolveNamespace({ cwd, explicit } = {}) {
  // 1. Explicit CLI flag — always wins.
  if (explicit) return explicit;

  // 2. SIGIL_NAMESPACE env — per-shell / per-CI override.
  const envNs = process.env.SIGIL_NAMESPACE;
  if (envNs && envNs.trim()) return envNs.trim();

  // 3. Committed `.sigil/namespace` marker at the repo root.
  if (cwd) {
    let root = null;
    try {
      root = deriveProjectRoot(cwd);
    } catch {
      root = null;
    }
    const marker = readNamespaceMarker(root);
    if (marker) return marker;
  }

  // 4. Existing fallback — DEFAULT_NAMESPACE env, else 'default'. Unchanged.
  return config.defaults.namespace;
}

export default resolveNamespace;
