/**
 * Single source of truth for daemon RPC methods.
 *
 * Each handler receives `(params, ctx)` and returns plain data. Transports
 * (unix socket today; HTTP and Iroh later) all share this table — there is
 * exactly one implementation of "remember", "search", etc.
 *
 * Handlers must NOT format output. They return structured data; the caller
 * (CLI thin client, MCP tool, GUI) is responsible for rendering.
 */

import { serializeError } from '../lib/errors.js';

export const RPC_ERRORS = {
  UNKNOWN_METHOD: 'unknown_method',
  INVALID_PARAMS: 'invalid_params',
  HANDLER_ERROR:  'handler_error',
};

export function createRegistry() {
  const handlers = new Map();

  function register(method, fn) {
    if (handlers.has(method)) {
      throw new Error(`rpc: duplicate handler for "${method}"`);
    }
    handlers.set(method, fn);
  }

  async function dispatch(method, params, ctx = {}) {
    const fn = handlers.get(method);
    if (!fn) {
      return {
        ok: false,
        error: { code: RPC_ERRORS.UNKNOWN_METHOD, message: `unknown method: ${method}` },
      };
    }
    // Bind caller identity into AsyncLocalStorage so leaf code (fact
    // store, etc.) can read provenance without parameter threading.
    // PR review #5.
    const { runWithRequestContext } = await import('./request-context.js');
    try {
      const data = await runWithRequestContext(
        { device: ctx.device || null, transport: ctx.transport || null, agent: ctx.agent || null },
        () => fn(params ?? {}, ctx),
      );
      return { ok: true, data };
    } catch (err) {
      // Poisoned embedded WASM (field-report Defect 3 / F4): the PGlite heap
      // aborted and every later query returns the same error. The query layer
      // disposed the singleton + tagged the error; drop the dead knex pool too so
      // the NEXT request acquires a fresh connection (rebuilt PGlite) instead of
      // staying wedged for the daemon's lifetime. Best-effort; never throws.
      if (err?.sigilPoisoned) {
        try {
          const { resetCortexPool } = await import('../db/cortex.js');
          await resetCortexPool();
        } catch { /* best-effort recycle */ }
      }
      return { ok: false, error: serializeError(err) };
    }
  }

  function list() {
    return [...handlers.keys()].sort();
  }

  /**
   * Replace an existing handler. Used by the lite-follower path to swap
   * a data-touching local handler for one that proxies to master.
   */
  function replace(method, fn) {
    if (!handlers.has(method)) return false;
    handlers.set(method, fn);
    return true;
  }

  return { register, replace, dispatch, list };
}

// serializeError moved to src/lib/errors.js (PR review #25).
