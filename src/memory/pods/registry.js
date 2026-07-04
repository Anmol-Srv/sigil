/**
 * Pod kind registry — the central catalog of pod *kinds* (formerly types).
 *
 * A kind is a declarative contract that says how pods of one shape work:
 * what identifies them, what attrs they carry, how much room they get in
 * the hot-context blend, how facts in their pods decay, and how to figure
 * out which pods are "active right now" given a hook/CLI context.
 *
 * Built-ins (claude_session, project, person, playbook, vital) register at
 * import-time via src/memory/pods/kinds/index.js. Dynamic kinds (runtime
 * registration via SDK or CLI) land in 0.12.0; this 0.10.0 version is
 * code-only registration.
 *
 * Kind contract (all fields optional unless noted):
 *
 *   name             string  required, unique slug, snake_case
 *   description      string  human-readable one-liner
 *   identityField    string  attrs key used as external_id for upsert
 *                            idempotency (e.g., 'session_id' for
 *                            claude_session). Omit for virtual kinds
 *                            (vital) that don't back rows.
 *   attrsSchema      object  { fieldName: 'string'|'number'|'boolean'|'object'|'array' }
 *                            used by validateAttrs() — soft validation for
 *                            now (warns), strict in 0.12.0 when dynamic
 *                            kinds land.
 *   visibility       'private'|'shared'|'public'   default ACL for pods
 *                            of this kind. Enforced from 0.11.0 onward
 *                            (when identity layer lands); 0.10.0 stores
 *                            the value but doesn't filter on it.
 *   activeMode       'singleton-live'|'multi-active'|'rolling-window'|'always'
 *                            informational; documents how the kind expects
 *                            its active-scope to be computed.
 *   hotContextBudget number  slots reserved in hot-context blend (0..N).
 *                            Default 0 (kind contributes nothing).
 *   retrievalWeights { recency, relevance } numeric coefficients for the
 *                            kind's contribution to hot-context ranking.
 *                            Defaults to { recency: 1, relevance: 1 }.
 *   importanceDefault 1..5   numeric default for facts attached via this
 *                            kind's hooks. 5 = vital. Default 2.
 *   ttlDays          number  decay half-life. After ttlDays a fact's
 *                            importance-driven score has halved. null
 *                            means no decay (default for project/playbook).
 *   schemaDocPath    string  path relative to package root for the
 *                            authoring schema markdown (Karpathy's third
 *                            layer). Resolved at runtime by getSchemaDoc().
 *   writePolicy      'origin-only'|'shared-allowlist'|'open'
 *                            informational in 0.10.0; enforced from
 *                            0.11.0 when external-agent writes land.
 *   lifecycle        object  optional hook handlers — { open, close,
 *                            onPostToolUse, onSessionEnd }. In 0.10.0 the
 *                            shared hook dispatcher walks active kinds
 *                            and attaches facts; richer per-kind behavior
 *                            comes 0.11.0+.
 *   resolveActiveScope(ctx) -> Promise<string[]>   array of pod uids that
 *                            are "in scope" right now. Empty array means
 *                            this kind is dormant and skipped by
 *                            activeKinds(). Required for any kind that
 *                            wants to contribute to hot-context.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SIGIL_SCHEMAS_DIR } from '../../lib/paths.js';

const REQUIRED_FIELDS = ['name'];
const VALID_VISIBILITY = new Set(['private', 'shared', 'public']);
const VALID_ACTIVE_MODES = new Set([
  'singleton-live',
  'multi-active',
  'rolling-window',
  'always',
]);
const VALID_WRITE_POLICIES = new Set(['origin-only', 'shared-allowlist', 'open']);

const kinds = new Map();

export function register(kind) {
  for (const field of REQUIRED_FIELDS) {
    if (!kind[field]) {
      throw new Error(`Pod kind missing required field: ${field}`);
    }
  }
  if (kind.visibility && !VALID_VISIBILITY.has(kind.visibility)) {
    throw new Error(`Pod kind ${kind.name}: invalid visibility ${kind.visibility}`);
  }
  if (kind.activeMode && !VALID_ACTIVE_MODES.has(kind.activeMode)) {
    throw new Error(`Pod kind ${kind.name}: invalid activeMode ${kind.activeMode}`);
  }
  if (kind.writePolicy && !VALID_WRITE_POLICIES.has(kind.writePolicy)) {
    throw new Error(`Pod kind ${kind.name}: invalid writePolicy ${kind.writePolicy}`);
  }
  kinds.set(kind.name, withDefaults(kind));
}

function withDefaults(kind) {
  return {
    visibility: 'private',
    activeMode: 'multi-active',
    hotContextBudget: 0,
    retrievalWeights: { recency: 1, relevance: 1 },
    importanceDefault: 2,
    ttlDays: null,
    writePolicy: 'origin-only',
    lifecycle: {},
    ...kind,
  };
}

export function get(name) {
  return kinds.get(name) || null;
}

export function list() {
  return Array.from(kinds.values());
}

// Pod-kind names whose default visibility is 'private' (owner-scoped). Used by
// read-time enforcement (P2): facts belonging to a pod of one of these kinds
// are only returned to the device that created them. Built-ins: claude_session,
// person. Resolved from the live registry so dynamically-registered private
// kinds (0.12.0+) are covered automatically.
export function privateKindNames() {
  return Array.from(kinds.values())
    .filter((k) => k.visibility === 'private')
    .map((k) => k.name);
}

// Returns kinds whose resolveActiveScope yields a non-empty pod set for
// the given context. Each entry is { kind, scope: string[] } where scope
// holds pod uids the hot-context blend should pull from. Order matches
// kind registration order, but hot-context applies its own budget logic
// to merge — order here is informational.
export async function activeKinds(ctx = {}) {
  const out = [];
  for (const kind of kinds.values()) {
    if (typeof kind.resolveActiveScope !== 'function') continue;
    try {
      const scope = await kind.resolveActiveScope(ctx);
      if (Array.isArray(scope) && scope.length > 0) {
        out.push({ kind, scope });
      }
    } catch (err) {
      // A kind whose resolver throws is treated as dormant — never blocks
      // the rest of the registry. But it is NO LONGER silent: a failing
      // project-pod resolution silently dropped scope and collapsed search
      // to global (the cross-project leak). Surface it to stderr (daemon log
      // / hook stderr) and best-effort to the Activity log so a
      // silently-global session is diagnosable.
      process.stderr.write(`[sigil:pods] resolveActiveScope failed for kind "${kind.name}": ${err.message}\n`);
      recordResolveFailure(kind.name, err);
    }
  }
  return out;
}

// Best-effort surfacing of a pod-resolution failure into the durable trace /
// Activity log. Fire-and-forget, never throws, never blocks activeKinds. The
// dynamic import keeps the pods layer free of a load-time dependency on the
// daemon trace store (and works in CLI/hook contexts where it simply no-ops
// on any DB error inside recordTrace).
function recordResolveFailure(kindName, err) {
  import('../../daemon/trace-store.js')
    .then(({ recordTrace }) => recordTrace({
      kind: 'lifecycle',
      summary: `pod-resolution failed for kind "${kindName}"`,
      detail: { kind: kindName, error: err.message },
    }))
    .catch(() => { /* trace store unavailable — stderr already has it */ });
}

export function validateAttrs(kind, attrs = {}) {
  if (!kind || !kind.attrsSchema) return { valid: true };
  const errors = [];
  for (const [key, expected] of Object.entries(kind.attrsSchema)) {
    const value = attrs[key];
    if (value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (expected !== actual) {
      errors.push(`attr "${key}" expected ${expected}, got ${actual}`);
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

// Resolve the absolute path of a kind's schema doc. Override path
// ~/.sigil/schemas/<name>.md wins if it exists; otherwise the path
// declared on the kind (relative to the package root) is used.
export async function getSchemaDoc(kind) {
  if (!kind) return null;
  const override = join(SIGIL_SCHEMAS_DIR, `${kind.name}.md`);
  try {
    return await readFile(override, 'utf8');
  } catch {
    // fall through to built-in
  }
  if (!kind.schemaDocPath) return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const builtIn = join(here, kind.schemaDocPath);
  try {
    return await readFile(builtIn, 'utf8');
  } catch {
    return null;
  }
}

// Test/CLI helper — clear the registry. Production code never calls this.
export function _reset() {
  kinds.clear();
}
