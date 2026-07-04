/**
 * project kind — one pod per code project (git repo or working directory).
 *
 * Identity (externalId) is decoupled from the local path so two clones of
 * the same repo at different paths share one project pod. Precedence
 * (deriveProjectIdentity): SIGIL_PROJECT_ID env → normalized git remote
 * (default) → committed `.sigil/project.json` { id } → absolute root path
 * (legacy fallback). Strategy is configurable via `project.identity`
 * (remote | path | explicit). The root_path / git_root / display_name attrs
 * still hold the LOCAL path info for display. Multi-active — opening Claude
 * Code in two different projects activates two project pods simultaneously.
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
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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
    const identity = deriveProjectIdentity(cwd); // remote / marker / path
    const pod = await podStore.findByExternalId({
      podType: POD_TYPE,
      externalId: identity,
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
  const identity = deriveProjectIdentity(cwd); // remote / marker / path
  const ns = namespace || config.defaults.namespace;
  const isGitRoot = rootPath !== cwd ? false : detectGitRoot(cwd) === cwd;
  const gitRoot = isGitRoot ? rootPath : detectGitRoot(cwd);

  const { pod } = await podStore.upsertPod({
    podType: POD_TYPE,
    externalId: identity,
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

// Derive the project IDENTITY (pod externalId) from a working directory,
// decoupled from the local path so clones at different paths share one pod.
// Precedence, gated by `project.identity` strategy:
//   1. SIGIL_PROJECT_ID env  — explicit escape hatch (always wins).
//   2. normalized git remote — the default (skipped when strategy='path').
//   3. .sigil/project.json { id } — committed marker fallback.
//   4. absolute project root path — legacy fallback (skipped under 'explicit'
//      unless nothing above resolved). Pure / synchronous / never throws.
export function deriveProjectIdentity(cwd) {
  const strategy = config.project.identity; // 'remote' | 'path' | 'explicit'

  const envId = (process.env.SIGIL_PROJECT_ID || '').trim();
  if (envId) return envId;

  // 'path' strategy short-circuits straight to the legacy path identity.
  if (strategy === 'path') return deriveProjectRoot(cwd);

  const remote = normalizeGitRemote(detectGitRemote(cwd));
  if (remote) return remote;

  const marker = readProjectMarker(deriveProjectRoot(cwd));
  if (marker) return marker;

  // 'explicit' resolved nothing usable above; fall back to path only as a
  // last resort (an unkeyed pod is worse than a path-keyed one).
  return deriveProjectRoot(cwd);
}

// Normalize a git remote URL to a stable, path-independent identity, e.g.
// `https://user:pass@GitHub.com/Owner/Repo.git` → `github.com/owner/repo`.
// Handles https/ssh/scp/git protocols, credentials, and trailing `.git`.
// Returns null for empty / unparseable input. Pure / synchronous.
export function normalizeGitRemote(url) {
  if (!url || typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;

  // Strip scheme (https://, http://, ssh://, git://) if present.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Strip a leading user@ / user:pass@ credential block.
  s = s.replace(/^[^@/]+@/, '');
  // SCP-like form `host:path` → `host/path` (only the first colon, and not a
  // `:port` which is all digits up to the next slash).
  s = s.replace(/^([^/:]+):(?!\/)(?!\d+\/)/, '$1/');
  // Drop any leftover `:port` segment after the host.
  s = s.replace(/^([^/:]+):\d+\//, '$1/');
  // Strip a trailing .git and any surrounding slashes.
  s = s.replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!s || !s.includes('/')) return null;
  return s.toLowerCase();
}

// Read remote.origin.url from a working directory. Mirrors detectGitRoot:
// synchronous, bounded, never throws. Returns null when there's no remote.
function detectGitRemote(cwd) {
  try {
    const result = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

// Read a committed `.sigil/project.json` { id } marker from the repo root.
// Pure / synchronous / never throws. Returns the trimmed id or null.
function readProjectMarker(root) {
  if (!root) return null;
  try {
    const raw = readFileSync(join(root, '.sigil', 'project.json'), 'utf8');
    const id = JSON.parse(raw)?.id;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
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
