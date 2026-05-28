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
        { device: ctx.device || null, transport: ctx.transport || null },
        () => fn(params ?? {}, ctx),
      );
      return { ok: true, data };
    } catch (err) {
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

/**
 * Flatten a thrown error into a wire-safe shape. AggregateError (thrown by
 * pg/undici/node-fetch when every address candidate fails) loses its useful
 * detail when stringified — we surface the first sub-error's message and
 * code so the CLI can pattern-match (e.g. ECONNREFUSED → friendly hint).
 */
function serializeError(err) {
  let code = err.code || RPC_ERRORS.HANDLER_ERROR;
  let message = err.message || String(err);

  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length) {
    const first = err.errors[0];
    code = first.code || code;
    message = first.message || message;
    // Preserve sibling codes for richer diagnostics
    const codes = [...new Set(err.errors.map((e) => e.code).filter(Boolean))];
    if (codes.length > 1) message += ` (and ${err.errors.length - 1} more: ${codes.slice(1).join(', ')})`;
  } else if (err.cause && (!message || message === 'AggregateError')) {
    code = err.cause.code || code;
    message = err.cause.message || message;
  }

  return {
    code,
    message,
    stack: process.env.SIGIL_DEBUG ? err.stack : undefined,
  };
}
