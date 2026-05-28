/**
 * Wire-shape error serializer used by the RPC registry (socket + HTTP +
 * Iroh transports). Centralised per PR review #25 — same envelope for
 * every door into the daemon. Unwraps AggregateError thrown by
 * pg/undici under multi-address connect attempts.
 */
export const DEFAULT_RPC_ERROR_CODE = 'handler_error';

export function serializeError(err) {
  let code = err.code || DEFAULT_RPC_ERROR_CODE;
  let message = err.message || String(err);

  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length) {
    const first = err.errors[0];
    code = first.code || code;
    message = first.message || message;
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

export class AppError extends Error {
  static codes = {
    VALIDATION_ERROR: { message: 'Validation error', statusCode: 400 },
    NOT_FOUND: { message: 'Resource not found', statusCode: 404 },
    BAD_REQUEST: { message: 'Bad request', statusCode: 400 },
    CONFLICT: { message: 'Resource conflict', statusCode: 409 },
    INTERNAL: { message: 'Internal server error', statusCode: 500 },
    SERVICE_UNAVAILABLE: { message: 'Service unavailable', statusCode: 503 },
    LLM_ERROR: { message: 'LLM provider error', statusCode: 502 },
    DB_ERROR: { message: 'Database error', statusCode: 500 },
  };

  constructor({ errorCode, message, data } = {}) {
    const defaults = AppError.codes[errorCode] || AppError.codes.INTERNAL;

    super(message || defaults.message);

    this.name = 'AppError';
    this.statusCode = defaults.statusCode;
    this.errorCode = errorCode || 'INTERNAL';
    this.data = data;
  }
}
