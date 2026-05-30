/**
 * Pod resolver — turns ingest-pipeline metadata into pod attachments.
 *
 * Two entry points:
 *
 *   fromSourceMetadata(metadata, namespace)
 *     Used by `ingestDocument({resolvePodsFrom: 'metadata'})` — the connector
 *     ingest path. Examines `metadata.slack` / `metadata.github` / etc. and
 *     returns the set of pods (workspace + person) that the incoming
 *     document should be attached to. Creates them if missing.
 *
 *   upsertPersonPod({entityId, externalIds, name, namespace, attrs})
 *     Used by the entity linker when a person-entity is created or
 *     matched from a document carrying a connector platform handle.
 *
 * In PR1 there is no real connector emitting platform metadata, so both
 * paths are wired but mostly dormant. Explicit person-pod creation goes
 * through CLI (`sigil pod create --type=person`), which calls
 * `upsertPersonPod` directly.
 */

import * as podStore from './store.js';
import * as personType from './kinds/person.js';
import config from '../../config.js';

// Find or create the person pod for a given entity. If a pod already
// exists (matched by entity_id), refresh its platforms with anything new
// in `attrs.platforms`. If not, create a new pod row.
async function upsertPersonPod({
  entityId,
  name,
  namespace,
  attrs = {},
}) {
  if (!entityId) throw new Error('upsertPersonPod requires entityId');

  const ns = namespace || config.defaults.namespace;
  const existing = await podStore.findByEntityId(entityId);

  if (existing) {
    // Merge platforms into the existing pod's attrs.
    const existingAttrs = typeof existing.attrs === 'object'
      ? existing.attrs
      : safeParse(existing.attrs);
    const mergedPlatforms = personType.mergePlatforms(
      existingAttrs.platforms || {},
      attrs.platforms || {},
    );

    const patch = { platforms: mergedPlatforms };
    if (attrs.role && !existingAttrs.role) patch.role = attrs.role;
    if (attrs.relationship && !existingAttrs.relationship) patch.relationship = attrs.relationship;
    if (attrs.notes && !existingAttrs.notes) patch.notes = attrs.notes;

    await podStore.patchAttrs(existing.id, patch);
    return { pod: existing, isNew: false };
  }

  const fullAttrs = personType.buildAttrs(attrs);
  const externalId = personType.primaryExternalId(fullAttrs.platforms);

  // If we have a platform handle, use the upsert path so we get
  // (pod_type, external_id, namespace) idempotency. Otherwise insert
  // plain — without external_id the partial-unique doesn't apply.
  if (externalId) {
    const result = await podStore.upsertPod({
      podType: personType.POD_TYPE,
      externalId,
      name,
      namespace: ns,
      attrs: fullAttrs,
      entityId,
    });
    return result;
  }

  const pod = await podStore.insertPod({
    podType: personType.POD_TYPE,
    name,
    namespace: ns,
    attrs: fullAttrs,
    entityId,
  });
  return { pod, isNew: true };
}

// Connector-derived pod resolution from a document's source_metadata.
// In PR1 this returns an empty array unless real connector metadata is
// present (which won't happen without a connector). The shape is here so
// PR2's first connector slots in without re-architecting the pipeline.
//
// metadata shape (connector-emitted):
//   {
//     connection_id: 42,
//     slack: { team_id: "T456", workspace_name: "...", channel: "C123",
//              ts: "...", user_id: "U123", display_name: "..." },
//     github: { org: "...", repo: "...", author: "...", commit: "..." },
//     ...
//   }
//
// Returns: [{ podId, role }] suitable for batch attach in pipeline.
async function fromSourceMetadata(metadata, namespace) {
  if (!metadata || typeof metadata !== 'object') return [];

  const attachments = [];
  const ns = namespace || config.defaults.namespace;

  // Workspace pods — one per Slack team, GitHub org, etc. They're created
  // by the connector at registration; resolver just looks them up.
  if (metadata.slack?.team_id && metadata.connection_id) {
    const ws = await podStore.findByExternalId({
      podType: 'connector_workspace',
      externalId: `slack:${metadata.slack.team_id}`,
      namespace: ns,
    });
    if (ws) attachments.push({ podId: ws.id, role: 'primary' });
  }

  if (metadata.github?.org && metadata.connection_id) {
    const ws = await podStore.findByExternalId({
      podType: 'connector_workspace',
      externalId: `github:${metadata.github.org}`,
      namespace: ns,
    });
    if (ws) attachments.push({ podId: ws.id, role: 'primary' });
  }

  // Project pod from an explicit source/project root. Lets a file or connector
  // ingest that knows which codebase it came from cluster its facts with that
  // project (the SCOPE boundary) instead of landing in the unscoped pool.
  // "Map a source to a space" == map it to the project pod (namespace stays
  // single). Follow-up: have sources/file.js derive project_root per file so
  // plain `sigil ingest <path>` auto-clusters without an explicit rule.
  const projectRoot = metadata.project_root || metadata.source_root;
  if (projectRoot) {
    try {
      const { ensureProjectPod } = await import('./kinds/project.js');
      const pod = await ensureProjectPod({ cwd: projectRoot, namespace: ns });
      if (pod) attachments.push({ podId: pod.id, role: 'primary' });
    } catch { /* best-effort — metadata-derived attach never blocks ingest */ }
  }

  // Person pods derived from sender — only when an entity is already
  // present (the linker will have created or matched it). This function
  // is metadata-only; the linker-driven path lives in
  // entities/linker.js so we don't duplicate entity creation here.

  return attachments;
}

function safeParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

export { upsertPersonPod, fromSourceMetadata };
