/**
 * project kind — one pod per code project (git repo or working directory).
 *
 * Identity: absolute path to the project root. For directories inside a
 * git repo we use `git rev-parse --show-toplevel`; otherwise we fall
 * back to the cwd itself. Multi-active — opening Claude Code in two
 * different projects activates two project pods simultaneously.
 *
 * Why a separate kind from claude_session?
 *   - Claude_session facts decay (90 days); project facts don't.
 *   - One project, many sessions over time — project pod accumulates
 *     the durable knowledge (architecture, conventions, decisions)
 *     across all of them.
 *   - When a CC session ends, its summary fact attaches to BOTH the
 *     session pod (ephemeral) AND the project pod (durable).
 */

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import * as podStore from '../store.js';
import * as membership from '../membership.js';
import { parseAttrs } from '../attrs.js';
import config from '../../../config.js';

export const POD_TYPE = 'project';

export const projectKind = {
  name: 'project',
  description: 'Code project rooted at a git repo or directory',
  identityField: 'root_path',
  attrsSchema: {
    root_path: 'string',
    git_root: 'string',
    display_name: 'string',
    discovered_at: 'string',
  },
  visibility: 'shared',
  activeMode: 'multi-active',
  hotContextBudget: 4,
  retrievalWeights: { recency: 0.6, relevance: 1.0 },
  importanceDefault: 3,
  ttlDays: null,
  schemaDocPath: 'kinds/project.schema.md',
  writePolicy: 'origin-only',
  resolveActiveScope: async (ctx = {}) => {
    // Hot-context callers usually don't carry cwd directly; the cursor
    // file does (active-session.json.cwd). Hooks pass cwd via ctx. If
    // neither is set we have nothing to scope to.
    const cwd = ctx.cwd || (await readCwdFromCursor());
    // No cwd is a legitimate dormant state (e.g. hot-context with no active
    // session) — return [] quietly. But do NOT swallow lookup errors: a
    // throwing findByExternalId used to silently return [], which collapsed
    // the search to global scope (the cross-project leak). Let real errors
    // propagate to registry.activeKinds, which surfaces them in the Activity
    // log and treats the kind as dormant for this call.
    if (!cwd) return [];
    const ns = ctx.namespace || config.defaults.namespace;
    const rootPath = deriveProjectRoot(cwd); // git toplevel, or cwd if no git
    const pod = await podStore.findByExternalId({
      podType: POD_TYPE,
      externalId: rootPath,
      namespace: ns,
    });
    return pod ? [pod.uid] : [];
  },
};

// Ensure a project pod exists for the given cwd, returning the pod row.
// Called by hooks on every fire (idempotent on the project root path).
export async function ensureProjectPod({ cwd, namespace = null }) {
  if (!cwd) return null;
  const rootPath = deriveProjectRoot(cwd);
  const ns = namespace || config.defaults.namespace;
  const isGitRoot = rootPath !== cwd ? false : detectGitRoot(cwd) === cwd;
  const gitRoot = isGitRoot ? rootPath : detectGitRoot(cwd);

  const { pod } = await podStore.upsertPod({
    podType: POD_TYPE,
    externalId: rootPath,
    name: basename(rootPath) || rootPath,
    namespace: ns,
    attrs: {
      root_path: rootPath,
      git_root: gitRoot || null,
      display_name: basename(rootPath) || rootPath,
      discovered_at: new Date().toISOString(),
    },
    startedAt: new Date(),
  });
  return pod;
}

// Derive the project root from a working directory: git toplevel if
// the cwd is inside a repo, otherwise the cwd itself. Pure / synchronous /
// safe to call from any code path.
export function deriveProjectRoot(cwd) {
  const gitRoot = detectGitRoot(cwd);
  return gitRoot || cwd;
}

function detectGitRoot(cwd) {
  try {
    const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

async function readCwdFromCursor() {
  try {
    const { getActiveCursor } = await import('../active-session.js');
    const cursor = await getActiveCursor();
    return cursor?.cwd || null;
  } catch {
    return null;
  }
}

export function formatForDisplay(pod) {
  const a = parseAttrs(pod.attrs);
  return {
    uid: pod.uid,
    name: pod.name,
    rootPath: a.root_path,
    gitRoot: a.git_root,
    displayName: a.display_name,
    discoveredAt: a.discovered_at,
    memberFactCount: pod.memberFactCount,
    memberDocCount: pod.memberDocCount,
  };
}

// Re-export for hooks that want both pod_uid and a fact attached.
export { membership };
