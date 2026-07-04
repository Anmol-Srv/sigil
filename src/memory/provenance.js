/**
 * Ownership origin resolution (P7) — shared by the WRITE side (fact store
 * stamping `created_by_origin`) and the READ side (owner-scoped visibility in
 * search). Both MUST use the same identity or private facts would be stamped
 * with one id and filtered with another.
 *
 * Precedence (mirrors the prior P2 read-side resolution):
 *   1. the authenticated RPC caller's device id (request-context ALS) — set
 *      for paired remote devices, so a remote reader/writer uses its own id.
 *   2. ctx.device.id, if a caller threaded one explicitly.
 *   3. the local install id from config.json (`device.id`, a UUID) — the
 *      common local-CLI / hooks case; this is what makes each PERSON's writes
 *      distinguishable in a shared DB.
 * Returns the id as a string (the column is TEXT), or null when nothing
 * resolves (fail-open: writes leave it NULL → globally visible, never hidden).
 */
import { getConfig } from '../setup/config-store.js';
import { currentDeviceId as rpcDeviceId } from '../daemon/request-context.js';

export function currentOrigin(ctx = {}) {
  let id = null;
  try {
    id = rpcDeviceId();
  } catch {
    id = null;
  }
  if (id == null) id = ctx?.device?.id ?? null;
  if (id == null) {
    try {
      id = getConfig().device?.id ?? null;
    } catch {
      id = null; // config unreadable — fail open to global visibility
    }
  }
  return id == null ? null : String(id);
}
