/**
 * Resolve the memory scope for a local client process.
 *
 * Sigil already has indexed namespaces on facts and document chunks. A Git
 * project is therefore a namespace selection problem, not a reason to add a
 * second storage model, a second database, or a background synchronizer.
 *
 * Default behaviour:
 *   - Git repository with an origin remote: a stable namespace shared by its
 *     clones and worktrees.
 *   - Git repository without an origin: a stable namespace for that local
 *     checkout.
 *   - Outside a repository: the existing shared memory namespace only.
 *
 * SIGIL_SCOPE=shared opts out. SIGIL_SCOPE=worktree keeps memories isolated to
 * the current checkout. Neither is a security boundary: a same-user local
 * client can already select an explicit namespace through the public API.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const SHARED_SCOPE = 'default';
export const PROJECT_NAMESPACE_PREFIX = 'project:';
export const PROJECT_SCOPE_PATTERN = /^project:[a-f0-9]{24}$/;

const scopeCache = new Map();

export function resolveProjectScope({
  cwd = process.cwd(),
  env = process.env,
  runGit = defaultRunGit,
  resolvePath = safeRealpath,
} = {}) {
  // The daemon is the storage owner, never a project client. Avoid a Git
  // subprocess on every internally-created client or health check.
  if (env.SIGIL_DAEMON_PROCESS === '1') return sharedScope('daemon');

  const mode = String(env.SIGIL_SCOPE || '').trim().toLowerCase();
  if (mode === 'shared' || mode === 'default' || mode === 'off') {
    return sharedScope('explicit-shared');
  }

  const root = gitValue(runGit, cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return sharedScope('no-git');

  const canonicalRoot = resolvePath(root) || root;
  const cacheKey = `${mode || 'project'}:${canonicalRoot}`;
  const cached = scopeCache.get(cacheKey);
  if (cached) return cached;

  // Worktree isolation is opt-in. In the default mode, the canonical origin
  // produces an identical key for independent clones of the same repository.
  const remote = mode === 'worktree'
    ? null
    : gitValue(runGit, cwd, ['remote', 'get-url', 'origin']);
  const identity = remote ? `remote:${normalizeGitRemote(remote)}` : `path:${canonicalRoot}`;
  const scope = {
    kind: 'project',
    projectNamespace: `${PROJECT_NAMESPACE_PREFIX}${digest(identity)}`,
    sharedNamespace: SHARED_SCOPE,
    source: remote ? 'git-origin' : 'git-path',
  };
  scopeCache.set(cacheKey, scope);
  return scope;
}

export function normalizeGitRemote(remote) {
  let value = String(remote || '').trim();
  if (!value) return '';

  // Normalise common clone-url variants (git@host:owner/repo.git,
  // ssh://git@host/owner/repo.git, https://host/owner/repo.git) to a single
  // case-insensitive identity. This purposefully drops credentials, query
  // strings, and fragments before hashing.
  value = value.replace(/^git@([^:]+):/, 'ssh://$1/');
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return `${url.hostname.toLowerCase()}/${path}`.toLowerCase();
  } catch {
    return value.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
  }
}

export function isProjectNamespace(value) {
  return PROJECT_SCOPE_PATTERN.test(String(value || ''));
}

export function clearProjectScopeCache() {
  scopeCache.clear();
}

function sharedScope(source) {
  return {
    kind: 'shared',
    projectNamespace: null,
    sharedNamespace: SHARED_SCOPE,
    source,
  };
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function defaultRunGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 250,
    maxBuffer: 8_192,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout : '';
}

function gitValue(runGit, cwd, args) {
  try {
    return String(runGit(cwd, args) || '').trim();
  } catch {
    return '';
  }
}

function safeRealpath(path) {
  try { return realpathSync(path); } catch { return path; }
}
