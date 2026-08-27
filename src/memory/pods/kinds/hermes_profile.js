/**
 * hermes_profile kind — one pod per Hermes agent profile.
 *
 * Hermes runs several independent agents out of one install: `igris`, `iron`,
 * `xero`, each with its own `~/.hermes/profiles/<name>/config.yaml`. Hermes'
 * own plugin contract makes isolation mandatory — "All storage paths MUST use
 * the hermes_home kwarg from initialize()" — so keying memory on the platform
 * (cli / telegram / imessage) is a contract violation: two profiles chatting on
 * the same platform would write into one another's space.
 *
 * The profile is the durable scope, the way a project is for Claude Code. It is
 * what you come back to; a conversation is not. So the profile pod OWNS the
 * write, and there is deliberately no pod-per-conversation — a chat gateway
 * opens far too many short conversations for that to stay legible.
 *
 * Isolation is ownership, NOT a wall. Every profile writes to the `default`
 * namespace and reads it unscoped, so xero can recall what igris learned and
 * both can recall what Claude Code wrote. The pod records who learned it; it
 * does not gate who may know it. (An earlier cut used per-platform namespaces,
 * which quietly made each agent blind to every other one.)
 */

import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';

import * as podStore from '../store.js';
import config from '../../../config.js';

export const POD_TYPE = 'hermes_profile';

export const hermesProfileKind = {
  name: 'hermes_profile',
  description: 'A Hermes agent profile (igris, xero, …) — one memory space per agent',
  identityField: 'profile',
  attrsSchema: {
    profile: 'string',
    hermesHome: 'string',
    platform: 'string',
  },
  visibility: 'shared',
  // multi-active: several profiles can be live at once (a gateway per profile).
  // resolveActiveScope still returns [] so this kind never enters Claude Code's
  // hot-context blend — Hermes does its own recall via the plugin's prefetch().
  activeMode: 'multi-active',
  hotContextBudget: 3,
  retrievalWeights: { recency: 0.4, relevance: 1.0 },
  importanceDefault: 3,
  ttlDays: null,
  writePolicy: 'origin-only',
  // Hermes does its own recall through `sigil search` in the plugin's
  // prefetch(), so this kind never contributes to the hot-context blend that
  // Claude Code's injection hook builds. Returning [] keeps it out.
  resolveActiveScope: async () => [],
};

/**
 * Derive the profile name from Hermes' `hermes_home`.
 *
 * Deliberately lives here in JS rather than in the Python plugin: it is fiddly
 * path logic with three cases and a filesystem fallback, and this side has a
 * test runner. The plugin just forwards the kwarg verbatim.
 *
 *   ~/.hermes/profiles/xero  → 'xero'      (an explicit profile)
 *   ~/.hermes                → active_profile file, else 'default'
 *   '' | null                → same as bare ~/.hermes
 */
export function deriveProfileName(hermesHome, { readActive = defaultReadActive } = {}) {
  const home = String(hermesHome || '').trim();
  if (home) {
    const abs = resolve(home.replace(/^~(?=$|\/)/, homedir()));
    // A profile dir is any directory whose PARENT is named `profiles` — this
    // holds for a relocated HERMES_HOME too, which hardcoding ~/.hermes would
    // miss.
    if (basename(dirname(abs)) === 'profiles') return basename(abs);
  }
  return readActive() || 'default';
}

function defaultReadActive() {
  try {
    const name = readFileSync(join(homedir(), '.hermes', 'active_profile'), 'utf8').trim();
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Ensure the pod for a Hermes profile exists, returning the row. Idempotent on
 * (pod_type, external_id, namespace) via upsertPod, so every turn can call it.
 */
export async function ensureHermesProfilePod({ profile, hermesHome = null, platform = null, namespace = null }) {
  const name = String(profile || '').trim();
  if (!name) return null;
  const ns = namespace || config.defaults.namespace;

  // upsertPod returns { pod, isNew } — NOT the row. Returning it unwrapped
  // gave callers a `.uid` of undefined, which resolvePodAttachments skipped in
  // silence, so every write reported a pod and attached to nothing.
  const { pod } = await podStore.upsertPod({
    podType: POD_TYPE,
    externalId: name,
    name: `hermes:${name}`,
    namespace: ns,
    attrs: {
      profile: name,
      // Local truth, like project.js keeps root_path: the path is this
      // machine's, and wrong on any other device that syncs this pod.
      hermesHome: hermesHome || null,
      // Last platform seen, for display only. A profile is reachable from
      // several platforms and must not fragment across them.
      platform: platform || null,
    },
  });
  return pod;
}
