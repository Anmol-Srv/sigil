/**
 * LocalClient — dispatches into the daemon's own RPC registry. This is
 * a thin shim so callers can write the same `client.call(method, params)`
 * code regardless of whether the daemon serves the call locally or
 * proxies it to a master.
 */
import { getRegistry } from '../daemon/registry-holder.js';

export function createLocalClient() {
  return {
    kind: 'local',
    async call(method, params) {
      const registry = getRegistry();
      const result = await registry.dispatch(method, params, { transport: 'memory-client' });
      if (!result.ok) {
        const err = new Error(result.error?.message || 'rpc error');
        err.code = result.error?.code || 'handler_error';
        throw err;
      }
      return result.data;
    },
    async close() { /* no-op */ },
  };
}
