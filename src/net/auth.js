/**
 * Authorization for incoming Iroh RPC.
 *
 * Iroh's QUIC handshake already proved the caller controls the secret
 * key for the NodeID we see — that's authentication. Authorization is
 * one indexed lookup against the `device` table:
 *
 *   - device row exists AND active=true  → caller is recognised
 *   - device.role satisfies the method's role requirement
 *   - if method scopes by namespace, device.namespaces matches
 *
 * Method → required role mapping is local data (`METHOD_ROLES`) so the
 * authorization decision is in-process and constant-time.
 */
const ROLE_RANK = { reader: 0, writer: 1, admin: 2 };

export const METHOD_ROLES = {
  // Read-side
  ping:               'reader',
  status:             'reader',
  nodeInfo:           'reader',
  search:             'reader',
  searchEntity:       'reader',
  traverseGraph:      'reader',
  getFactContext:     'reader',
  getEntityContext:   'reader',
  getPod:             'reader',
  listPods:           'reader',
  listFacts:          'reader',
  refreshContext:     'reader',

  // Write-side
  remember:           'writer',
  ingestDoc:          'writer',
  forgetFact:         'writer',

  // Admin
  'pair.create':      'admin',
  'pair.list':        'admin',
  'pair.revoke':      'admin',
  runMigrations:      'admin',
  testDbConnection:   'admin',
  readEnv:            'admin',
  writeEnv:           'admin',
};

// PR review #11: throttle last_seen_at writes to once a minute per
// device so a chatty follower doesn't produce a write storm on `device`.
const LAST_SEEN_THROTTLE_MS = 60_000;

export async function authenticate(remoteNodeId) {
  const { default: cortexDb } = await import('../db/cortex.js');
  const device = await cortexDb('device').where({ node_id: remoteNodeId }).first();
  if (!device) return { ok: false, code: 'unknown_device', message: 'no device row for this NodeID' };
  if (!device.active) return { ok: false, code: 'revoked', message: 'device has been revoked' };

  const lastSeenMs = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  if (Date.now() - lastSeenMs > LAST_SEEN_THROTTLE_MS) {
    cortexDb('device').where({ id: device.id }).update({ last_seen_at: cortexDb.fn.now() }).catch(() => {});
  }
  return { ok: true, device };
}

export function authorize(device, method, params = {}) {
  const required = METHOD_ROLES[method];
  if (required === undefined) {
    return { ok: false, code: 'unknown_method', message: `method "${method}" is not exposed over Iroh` };
  }
  if (ROLE_RANK[device.role] < ROLE_RANK[required]) {
    return { ok: false, code: 'forbidden', message: `role "${device.role}" cannot call "${method}" (needs "${required}")` };
  }
  // Namespace scope: when the device has explicit namespaces, requests
  // that name a namespace must hit one of them. Empty array == all.
  if (device.namespaces?.length && params.namespace && !device.namespaces.includes(params.namespace)) {
    return { ok: false, code: 'namespace_denied', message: `device not scoped to namespace "${params.namespace}"` };
  }
  return { ok: true };
}
