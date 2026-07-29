/**
 * Sigil error model — one taxonomy, one wire shape.
 *
 * Two things used to live in parallel: an unused `AppError` with a tiny code
 * table, and `diagnoseError()` in db/setup.js (the real, battle-tested
 * classifier). This module unifies them:
 *
 *   - `ERROR_CODES`   — the canonical registry (SCREAMING_SNAKE → {message,
 *                       statusCode, hint?}). diagnoseError's `kind`s are
 *                       first-class codes here.
 *   - `AppError`      — the single throw type. Carries errorCode + hint + data.
 *   - `fromDiagnosis` — wrap a diagnoseError() result into an AppError.
 *   - `serializeError`— the wire-shape serializer used by the RPC registry
 *                       (socket + optional local HTTP). Emits {code, message, hint}.
 *                       Unwraps AggregateError (pg/undici multi-address) and
 *                       runs raw DB/embedding errors through diagnoseError so
 *                       even un-wrapped failures surface a clean code + hint.
 *
 * Centralised per PR review #25 — same envelope for every door into the daemon.
 */

import { diagnoseError } from '../db/setup.js';

export const DEFAULT_RPC_ERROR_CODE = 'handler_error';

/**
 * Canonical error-code registry. Codes are SCREAMING_SNAKE. `hint` is the
 * concrete next step shown under the message in the GUI/CLI.
 */
export const ERROR_CODES = {
  // ── generic ───────────────────────────────────────────────────────────────
  VALIDATION_ERROR: { message: 'Validation error', statusCode: 400 },
  INVALID_PARAMS: { message: 'Invalid parameters', statusCode: 400 },
  BAD_REQUEST: { message: 'Bad request', statusCode: 400 },
  NOT_FOUND: { message: 'Resource not found', statusCode: 404 },
  UNKNOWN_METHOD: { message: 'Unknown method', statusCode: 404 },
  CONFLICT: { message: 'Resource conflict', statusCode: 409 },
  INTERNAL: { message: 'Internal server error', statusCode: 500 },
  HANDLER_ERROR: { message: 'Handler error', statusCode: 500 },
  SERVICE_UNAVAILABLE: { message: 'Service unavailable', statusCode: 503 },
  LLM_ERROR: { message: 'LLM provider error', statusCode: 502 },

  // ── database (1:1 with diagnoseError kinds) ───────────────────────────────
  DB_ERROR: { message: 'Database error', statusCode: 500 },
  DB_UNREACHABLE: {
    message: 'Postgres is not reachable at that host/port.',
    statusCode: 503,
    hint: 'Confirm the server is running and the host/port are correct (`pg_isready -h <host> -p <port>`).',
  },
  DB_AUTH_FAILED: {
    message: 'Postgres rejected the username or password.',
    statusCode: 401,
    hint: 'Fix the credentials in the connection settings.',
  },
  DB_MISSING: {
    message: 'That database does not exist on the server yet.',
    statusCode: 404,
    hint: 'Create the database, or point Sigil at one that exists.',
  },
  DB_NO_PGVECTOR: {
    message: 'The pgvector extension is not enabled on this database.',
    statusCode: 400,
    hint: 'Click "Install pgvector", or use a pgvector-enabled Postgres image.',
  },
  DB_POOLER_LOCK: {
    message: 'This looks like a connection-pooler URL. Pooled connections cannot run migrations.',
    statusCode: 400,
    hint: 'Use the direct (non-pooled) connection string. For Neon, remove "-pooler" from the host.',
  },
  DB_POOL_DEAD: {
    message: 'The database connection pool was closed before this step ran.',
    statusCode: 503,
    hint: 'Internal sequencing issue, not your config — restart the daemon (Settings → Apply).',
  },

  // ── embeddings ────────────────────────────────────────────────────────────
  EMBED_DIM_MISMATCH: {
    message: 'The embedding size does not match the database.',
    statusCode: 409,
    hint: 'Pick an embedder whose dimension matches the DB, or wipe embedding data and start fresh.',
  },
  EMBED_BAD_KEY: {
    message: 'The embedding provider rejected the API key.',
    statusCode: 401,
    hint: 'Check the API key has embedding access and is pasted correctly (Settings → Embedding).',
  },
  EMBED_MODEL_NOT_FOUND: {
    message: 'The embedding model name was not recognized by the provider.',
    statusCode: 400,
    hint: 'Use a valid embedding model for the provider.',
  },
  OLLAMA_DOWN: {
    message: 'The local Ollama server is not reachable.',
    statusCode: 503,
    hint: 'Start it with `ollama serve`, then `ollama pull mxbai-embed-large`.',
  },

  // ── onboarding ────────────────────────────────────────────────────────────
  ONBOARDING_INVALID_TRANSITION: { message: 'Invalid onboarding step transition', statusCode: 409 },

  // ── docker / db auto-provision ────────────────────────────────────────────
  DOCKER_UNAVAILABLE: {
    message: 'Docker is not available on this machine.',
    statusCode: 503,
    hint: 'Install/start Docker Desktop, or use the connection-URL flow instead.',
  },
  DOCKER_PROVISION_FAILED: {
    message: 'Failed to provision the local Postgres container.',
    statusCode: 500,
    hint: 'Check `docker ps`/`docker logs sigil-postgres`, or use the connection-URL flow.',
  },

  // ── supervisor / always-up ────────────────────────────────────────────────
  SUPERVISOR_UNSUPPORTED_PLATFORM: { message: 'No supervisor backend for this platform', statusCode: 501 },
  SUPERVISOR_INSTALL_FAILED: {
    message: 'Failed to install the always-up service.',
    statusCode: 500,
    hint: 'Sigil still runs; you can retry with `sigil service install`.',
  },

  // ── connectors ────────────────────────────────────────────────────────────
  CONNECTOR_INSTALL_FAILED: { message: 'Failed to connect this client', statusCode: 500 },
  CONNECTOR_VERIFY_FAILED: {
    message: 'The client did not verify after connecting.',
    statusCode: 500,
    hint: 'Re-run connect; if it persists, check the client config file permissions.',
  },
};

/** diagnoseError() `kind` → canonical ERROR_CODES key. */
export const KIND_TO_CODE = {
  'dim-mismatch': 'EMBED_DIM_MISMATCH',
  'bad-key': 'EMBED_BAD_KEY',
  'model-not-found': 'EMBED_MODEL_NOT_FOUND',
  'ollama-down': 'OLLAMA_DOWN',
  'pool-dead': 'DB_POOL_DEAD',
  'pooler-lock': 'DB_POOLER_LOCK',
  'no-pgvector': 'DB_NO_PGVECTOR',
  unreachable: 'DB_UNREACHABLE',
  auth: 'DB_AUTH_FAILED',
  'missing-db': 'DB_MISSING',
  other: 'DB_ERROR',
};

export class AppError extends Error {
  /**
   * @param {{ errorCode?: string, message?: string, hint?: string, data?: any }} opts
   */
  constructor({ errorCode, message, hint, data } = {}) {
    const entry = ERROR_CODES[errorCode] || ERROR_CODES.INTERNAL;
    super(message || entry.message);
    this.name = 'AppError';
    this.errorCode = errorCode && ERROR_CODES[errorCode] ? errorCode : 'INTERNAL';
    this.statusCode = entry.statusCode;
    this.hint = hint ?? entry.hint ?? null;
    this.data = data;
  }

  /** Back-compat: older code referenced AppError.codes. */
  static get codes() {
    return ERROR_CODES;
  }
}

/**
 * Wrap a diagnoseError() result ({kind, humanMessage, fixHint}) into an AppError
 * with a canonical code. Use at DB/embedding catch sites:
 *   throw fromDiagnosis(diagnoseError(err));
 */
export function fromDiagnosis(diag, { data } = {}) {
  const code = KIND_TO_CODE[diag?.kind] || 'DB_ERROR';
  return new AppError({ errorCode: code, message: diag?.humanMessage, hint: diag?.fixHint, data });
}

function finish(obj, srcErr) {
  if (process.env.SIGIL_DEBUG && srcErr?.stack) obj.stack = srcErr.stack;
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

export function serializeError(err) {
  // 1. AppError — already structured.
  if (err instanceof AppError) {
    return finish(
      {
        code: err.errorCode,
        message: err.message,
        hint: err.hint ?? ERROR_CODES[err.errorCode]?.hint ?? undefined,
        data: err.data,
      },
      err,
    );
  }

  // 2. Unwrap AggregateError / cause (pg + undici raise these under
  //    multi-address connect attempts).
  let real = err;
  let message = err?.message || String(err);
  let extra = '';
  if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length) {
    real = err.errors[0] || err;
    message = real.message || message;
    const codes = [...new Set(err.errors.map((e) => e.code).filter(Boolean))];
    if (codes.length > 1) extra = ` (and ${err.errors.length - 1} more: ${codes.slice(1).join(', ')})`;
  } else if (err?.cause && (!message || message === 'AggregateError')) {
    real = err.cause;
    message = real.message || message;
  }

  // 3. Classify DB/embedding failures into a canonical code + hint.
  const diag = diagnoseError(real);
  if (diag && diag.kind !== 'other') {
    const code = KIND_TO_CODE[diag.kind] || 'DB_ERROR';
    return finish(
      { code, message: diag.humanMessage + extra, hint: diag.fixHint ?? ERROR_CODES[code]?.hint ?? undefined },
      err,
    );
  }

  // 4. Fall back: preserve an explicit (often lowercase) handler code, e.g.
  //    `err.code = 'invalid_params'`. Keeps existing handlers working.
  return finish(
    { code: real?.code || err?.code || DEFAULT_RPC_ERROR_CODE, message: message + extra, hint: undefined },
    err,
  );
}
