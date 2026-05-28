/**
 * sigil/rpc/1 — peer-to-peer RPC.
 *
 * Wire format: same NDJSON-shaped RPC the unix socket speaks, but each
 * request/response is one bi-stream (request payload then half-close,
 * single response, then full close). One connection can carry many
 * concurrent streams.
 *
 *   peer → master  {v:1, method, params, request_id}
 *   master → peer  {v:1, request_id, ok:true, data}
 *                | {v:1, request_id, ok:false, error:{code,message}}
 *
 * Auth: src/net/auth.js. NodeID is cryptographically pinned by Iroh.
 */
import bus from '../daemon/events.js';
import { authenticate, authorize } from './auth.js';

export const RPC_ALPN = 'sigil/rpc/1';
const MAX_REQ = 1024 * 1024; // 1 MB per request payload
const MAX_RESP = 8 * 1024 * 1024; // 8 MB per response payload (search results etc.)

// PR review #12: track live connections so a device.revoke or
// .activate event can terminate them rather than waiting for the next
// per-frame check (which the protocol doesn't do — auth is once per
// connection by design).
const liveConnections = new Map(); // nodeId → Set<{conn, deviceId}>

function trackConnection(nodeId, conn, deviceId) {
  if (!liveConnections.has(nodeId)) liveConnections.set(nodeId, new Set());
  const entry = { conn, deviceId };
  liveConnections.get(nodeId).add(entry);
  return () => {
    const set = liveConnections.get(nodeId);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) liveConnections.delete(nodeId);
  };
}

let busSubscribed = false;
function subscribeToBus(log) {
  if (busSubscribed) return;
  busSubscribed = true;
  bus.subscribe((evt) => {
    if (evt.type !== 'device.revoked') return;
    const set = liveConnections.get(evt.nodeId);
    if (!set) return;
    log(`rpc: closing ${set.size} live connection(s) from revoked device ${evt.deviceId}`);
    for (const { conn } of set) {
      try { conn.close?.(); } catch { /* best effort */ }
    }
    liveConnections.delete(evt.nodeId);
  });
}

export function createRpcAcceptor({ registry, log }) {
  subscribeToBus(log);
  return async function accept(err, conn) {
    if (err) {
      log(`rpc: accept err: ${err.message}`);
      return;
    }
    let remoteNodeId = '<unknown>';
    let device;
    try {
      remoteNodeId = conn.remoteNodeId().toString();
      const authResult = await authenticate(remoteNodeId);
      if (!authResult.ok) {
        log(`rpc: rejecting ${remoteNodeId.slice(0, 12)}…: ${authResult.code}`);
        // Send a single error response on the next stream so the client
        // gets a clean failure code, then drop the connection.
        try {
          const bi = await conn.acceptBi();
          await bi.send.writeAll(Buffer.from(JSON.stringify({
            v: 1,
            ok: false,
            error: { code: authResult.code, message: authResult.message },
          })));
          await bi.send.finish();
        } catch { /* connection may already be gone */ }
        return;
      }
      device = authResult.device;
      bus.emit('rpc.connected', { nodeId: remoteNodeId, deviceId: device.id, name: device.name });
      log(`rpc: ${device.name} (${remoteNodeId.slice(0, 12)}…) connected`);

      const untrack = trackConnection(remoteNodeId, conn, device.id);

      // Multiplex bi-streams. Each stream is one request/response.
      // Process serially per connection — Iroh's stream concurrency
      // already gives us parallelism across distinct connections.
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          let bi;
          try { bi = await conn.acceptBi(); }
          catch { break; /* connection closed */ }
          handleStream(bi, registry, device, log).catch((e) => log(`rpc: stream err: ${e.message}`));
        }
      } finally {
        untrack();
      }
    } catch (e) {
      log(`rpc: handler err from ${remoteNodeId.slice(0, 12)}…: ${e.message}`);
    } finally {
      if (device) {
        bus.emit('rpc.disconnected', { nodeId: remoteNodeId, deviceId: device.id });
      }
    }
  };
}

async function handleStream(bi, registry, device, log) {
  const raw = await bi.recv.readToEnd(MAX_REQ);
  let req;
  try { req = JSON.parse(raw.toString()); }
  catch (e) {
    return writeFrame(bi, { v: 1, ok: false, error: { code: 'invalid_json', message: e.message } });
  }

  const { request_id, method, params } = req || {};
  if (typeof method !== 'string') {
    return writeFrame(bi, { v: 1, request_id, ok: false, error: { code: 'invalid_request', message: 'missing method' } });
  }

  const allowed = authorize(device, method, params || {});
  if (!allowed.ok) {
    bus.emit('rpc.denied', { nodeId: device.nodeId, deviceId: device.id, method, code: allowed.code });
    return writeFrame(bi, { v: 1, request_id, ok: false, error: allowed });
  }

  const result = await registry.dispatch(method, params, {
    transport: 'iroh',
    device: { id: device.id, role: device.role, nodeId: device.nodeId, name: device.name },
  });

  // PR review #18: rough pre-stringify size guard. We can't know the
  // exact wire size without serializing, but a generous heuristic on
  // top-level array/string lengths catches the dominant case (huge
  // search/list result) before allocating an 8 MB+ string only to
  // reject it. Conservative pass-through for non-arrays.
  if (!isLikelySafeSize(result.data)) {
    log(`rpc: response from ${method} too large estimate, refusing pre-serialize`);
    return writeFrame(bi, { v: 1, request_id, ok: false, error: { code: 'response_too_large', message: 'response exceeds MAX_RESP' } });
  }

  const payload = JSON.stringify({ v: 1, request_id, ...result });
  if (Buffer.byteLength(payload) > MAX_RESP) {
    log(`rpc: response too large for ${method} from ${device.name}: ${Buffer.byteLength(payload)} bytes`);
    return writeFrame(bi, { v: 1, request_id, ok: false, error: { code: 'response_too_large', message: 'response exceeds MAX_RESP' } });
  }
  return writeFrame(bi, payload, /* isString */ true);
}

const ROUGH_LIMIT_BYTES = MAX_RESP * 1.2;
function isLikelySafeSize(data) {
  if (data == null) return true;
  if (typeof data === 'string') return data.length * 2 < ROUGH_LIMIT_BYTES; // upper-bound utf-8
  if (typeof data !== 'object') return true;
  // Walk top-level array contents to estimate; assume worst-case 200
  // bytes per typical record (fact content + metadata).
  if (Array.isArray(data)) return data.length * 200 < ROUGH_LIMIT_BYTES;
  let count = 0;
  for (const v of Object.values(data)) {
    if (Array.isArray(v)) count += v.length * 200;
    else if (typeof v === 'string') count += v.length * 2;
  }
  return count < ROUGH_LIMIT_BYTES;
}

async function writeFrame(bi, frame, isString = false) {
  const buf = isString ? Buffer.from(frame) : Buffer.from(JSON.stringify(frame));
  await bi.send.writeAll(buf);
  await bi.send.finish();
}
