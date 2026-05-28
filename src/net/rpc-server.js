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

export function createRpcAcceptor({ registry, log }) {
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

      // Multiplex bi-streams. Each stream is one request/response.
      // Process serially per connection — Iroh's stream concurrency
      // already gives us parallelism across distinct connections.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        let bi;
        try { bi = await conn.acceptBi(); }
        catch { break; /* connection closed */ }
        handleStream(bi, registry, device, log).catch((e) => log(`rpc: stream err: ${e.message}`));
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

  const payload = JSON.stringify({ v: 1, request_id, ...result });
  if (Buffer.byteLength(payload) > MAX_RESP) {
    log(`rpc: response too large for ${method} from ${device.name}: ${Buffer.byteLength(payload)} bytes`);
    return writeFrame(bi, { v: 1, request_id, ok: false, error: { code: 'response_too_large', message: 'response exceeds MAX_RESP' } });
  }
  return writeFrame(bi, payload, /* isString */ true);
}

async function writeFrame(bi, frame, isString = false) {
  const buf = isString ? Buffer.from(frame) : Buffer.from(JSON.stringify(frame));
  await bi.send.writeAll(buf);
  await bi.send.finish();
}
