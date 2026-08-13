/**
 * project kind — one pod per code project (git repo or working directory).
 *
 * Identity: the normalised git REMOTE when the repo has one, falling back to
 * the absolute project root. Remote first because a path is only meaningful on
 * the machine that holds it — the cloud agent's /workspace/sigil and this
 * laptop's /Users/anmol/Drive/Projects/sigil are one project, and keying on
 * path gives them two pods that cannot see each other. Path remains the
 * fallback for remote-less local repos, which really are per-machine.
 *
 * Multi-active — opening Claude Code in two different projects activates two
 * project pods simultaneously.
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

import cortexDb from '../../../db/cortex.js';
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
    git_remote: 'string',
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

    // Remote first: it resolves to the same pod on every machine, so a session
    // here sees what the cloud agent recorded for this repo. Path second, for
    // repos with no remote and for pods created before git_remote was stored.
    const byRemote = await findProjectPodByRemote(deriveGitRemote(cwd));
    if (byRemote) return [byRemote.uid];

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

  // A directory is not a project. deriveProjectRoot() falls back to the cwd when
  // there's no git root, so running an agent from /tmp or $HOME used to mint a
  // "project" pod named `tmp` — observed in a real store. Combined with the
  // project-owns-the-write rule in hook-dispatcher.js, that would file facts
  // under a junk pod instead of the session. Require a repo; without one, return
  // null and let the caller fall back to the session pod (or to no pod at all,
  // which scoped search now treats as globally visible).
  if (!gitRoot) return null;

  const projectName = basename(rootPath) || rootPath;
  const gitRemote = deriveGitRemote(cwd);

  // If another install already opened a pod for this repo, upsert against ITS
  // key instead of our local path — otherwise each machine mints its own pod
  // for the same project and neither can see the other's facts. The upsert key
  // is (pod_type, external_id, namespace), so both parts have to be adopted.
  const existing = await findProjectPodByRemote(gitRemote);

  const { pod } = await podStore.upsertPod({
    podType: POD_TYPE,
    externalId: existing?.externalId ?? rootPath,
    name: existing?.name ?? projectName,
    namespace: existing?.namespace ?? ns,
    attrs: {
      // root_path/git_root stay LOCAL truth — they describe this machine's
      // checkout and are wrong on any other. Only git_remote is shared
      // identity, which is why it is the only one matched on.
      root_path: rootPath,
      git_root: gitRoot || null,
      git_remote: gitRemote,
      display_name: existing?.name ?? (basename(rootPath) || rootPath),
      discovered_at: new Date().toISOString(),
    },
    startedAt: new Date(),
  });

  // Bind the pod to an entity named after the project, so a fact ABOUT this
  // project reaches it even when written from somewhere else. Identity stays
  // the git root (externalId); the entity is only a routing anchor. Best-effort
  // — an unbound pod still works, it just won't collect subject matches.
  try {
    const { bindPodToEntity } = await import('../subject-router.js');
    await bindPodToEntity({ podId: pod.id, name: projectName, namespace: ns });
  } catch { /* routing is an enhancement, never a reason to fail the pod */ }

  return pod;
}

// Derive the project root from a working directory: git toplevel if
// the cwd is inside a repo, otherwise the cwd itself. Pure / synchronous /
// safe to call from any code path.
export function deriveProjectRoot(cwd) {
  const gitRoot = detectGitRoot(cwd);
  return gitRoot || cwd;
}

/**
 * The one identity for a project that is the same on every machine.
 *
 * A project pod is keyed by absolute path, which is correct on one machine and
 * useless across several: the cloud agent's /workspace/sigil and the laptop's
 * /Users/anmol/Drive/Projects/sigil are the same repository and would
 * otherwise mint two unrelated pods. Scoped retrieval then hides each one's
 * work from the other — the fact IS podded, just to the wrong pod, so the
 * "unpodded stays visible" escape hatch doesn't save it either.
 *
 * The remote URL is the thing both machines agree on. Normalised so the
 * shapes git accepts for the SAME repo collapse together:
 *   git@github.com:Anmol-Srv/sigil.git  ┐
 *   https://github.com/Anmol-Srv/sigil  ├─→ github.com/anmol-srv/sigil
 *   ssh://git@github.com/anmol-srv/sigil.git ┘
 *
 * Returns null for a repo with no remote (a local-only scratch repo is
 * genuinely per-machine) and for anything unparseable.
 */
export function normalizeGitRemote(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  // scp-style (git@host:owner/repo) has no scheme and a colon separator.
  const scp = raw.match(/^[\w.-]+@([^:/]+):(.+)$/);
  let host;
  let path;
  if (scp) {
    [, host, path] = scp;
  } else {
    try {
      const u = new URL(raw);
      host = u.host;
      path = u.pathname;
    } catch {
      return null;
    }
  }

  host = host.toLowerCase().replace(/:\d+$/, '');       // drop an explicit port
  path = path.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !path) return null;
  // Case-insensitive: GitHub and GitLab both treat owner/repo that way, and a
  // clone URL typed with different casing is the same repository.
  return `${host}/${path}`.toLowerCase();
}

/** The current repo's normalised remote, or null. Synchronous, never throws. */
export function deriveGitRemote(cwd) {
  try {
    const out = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return normalizeGitRemote(out);
  } catch {
    return null;
  }
}

/**
 * Find an existing project pod for this remote, across EVERY namespace.
 *
 * Deliberately not namespace-scoped. Two installs sharing a database may write
 * under different namespaces, and if the lookup honoured namespace they would
 * each create their own pod for the same repo and never converge — which is
 * the exact failure this function exists to prevent. Namespace still scopes
 * what a search returns; it just doesn't get to fork a project's identity.
 */
export async function findProjectPodByRemote(remote) {
  if (!remote) return null;
  const row = await cortexDb('pod')
    .where({ podType: POD_TYPE, status: 'active' })
    .whereRaw("attrs->>'git_remote' = ?", [remote])
    .orderBy('id')       // oldest wins, so the answer is stable as devices join
    .first();
  return row || null;
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
