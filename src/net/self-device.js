/**
 * Self-registration — this install's own row in the `device` table.
 *
 * Until now `device` rows were minted by exactly one path: the Iroh pairing
 * handshake. That left a hole precisely where multi-device matters most. Point
 * two installs at one shared Postgres (the supported external-database
 * deployment) and there is no handshake at all, so neither install has a
 * device row, `currentDeviceId()` returns null on both, and every fact in the
 * store is stamped `created_by_device_id = NULL`. Two machines, one
 * indistinguishable pile of facts — you cannot ask "did my laptop write this
 * or did the cloud agent?", which makes per-device visibility unimplementable.
 *
 * So every install registers itself on boot, keyed by the Ed25519 public key
 * derived from ~/.sigil/identity.key. Consequences worth stating:
 *
 *   - The key already exists and is already the Iroh NodeID, so a device that
 *     later pairs over Iroh maps onto the SAME row rather than a duplicate.
 *   - Registration is an idempotent upsert on node_id, so N daemon restarts
 *     produce one row, and two installs sharing a database produce two.
 *   - "Self" is not a stored flag. In a shared database every install sees
 *     every device row, and each one is self only from its own vantage point;
 *     a boolean column would be true for everybody. Self is decided by
 *     comparing node_id to our own public key, which is always locally
 *     answerable and can never disagree between readers.
 */
import { hostname, platform } from 'node:os';

import { getPublicKeyHex } from './identity.js';
import { getSigilVersion } from '../lib/version.js';

let cached = null;
let inflight = null;

/**
 * Upsert this install's device row and return it. Cached for the process
 * lifetime — the row's identity cannot change without a restart.
 *
 * @returns {Promise<{id:number,nodeId:string,name:string}|null>} null when the
 *   database is unreachable or unmigrated; callers must treat a null device as
 *   "provenance unknown" and carry on rather than failing the write.
 */
export async function ensureSelfDevice() {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = register()
    .then((row) => { cached = row; inflight = null; return row; })
    .catch(() => { inflight = null; return null; });
  return inflight;
}

async function register() {
  const nodeId = await getPublicKeyHex();
  const { default: cortexDb } = await import('../db/cortex.js');

  const meta = {
    self: true,
    hostname: hostname(),
    platform: platform(),
    sigilVersion: getSigilVersion(),
  };

  // role 'admin': this row describes the install that owns the daemon, so it
  // is not a delegation of authority to anyone. It never passes through the
  // Iroh authorize() path — that path only ever sees the REMOTE caller's row.
  const [row] = await cortexDb('device')
    .insert({
      node_id: nodeId,
      name: hostname(),
      role: 'admin',
      namespaces: [],
      active: true,
      last_seen_at: cortexDb.fn.now(),
      meta: JSON.stringify(meta),
    })
    .onConflict('node_id')
    // Deliberately NOT merging role/namespaces/active. If this device was
    // paired into someone else's cluster and then revoked, a local restart
    // must not silently restore its own access by overwriting the revocation.
    .merge({
      name: hostname(),
      last_seen_at: cortexDb.fn.now(),
      meta: JSON.stringify(meta),
    })
    .returning(['id', 'node_id', 'name']);

  if (!row) return null;
  return { id: row.id, nodeId: row.nodeId ?? nodeId, name: row.name };
}

/** The device id for THIS install, or null if registration hasn't succeeded. */
export function selfDeviceId() {
  return cached?.id ?? null;
}

/** Test seam. */
export function resetSelfDevice() {
  cached = null;
  inflight = null;
}
