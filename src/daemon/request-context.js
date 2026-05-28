/**
 * Per-RPC AsyncLocalStorage carrying authenticated caller info to
 * downstream code without threading parameters through every layer.
 *
 * Set by rpc-registry.dispatch around each handler invocation:
 *   { device: { id, role, nodeId, name } }   when call came from Iroh
 *   { device: null }                          when call came from socket/HTTP
 *
 * Read by leaf code that needs provenance (e.g. fact store stamping
 * created_by_device_id on inserts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export function runWithRequestContext(ctx, fn) {
  return als.run(ctx, fn);
}

export function currentRequestContext() {
  return als.getStore() || null;
}

export function currentDeviceId() {
  return als.getStore()?.device?.id ?? null;
}
