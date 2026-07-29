/**
 * Postgres database bootstrap. Assumes the user has Postgres running
 * (Docker container, brew service, RDS, whatever) and creates the
 * sigil database + sigil_app user + pgvector extension inside it.
 *
 * Called from `sigil init` (interactive prompt for admin creds) and as
 * a hint from `sigil migrate` when the target DB doesn't exist yet.
 *
 * Admin credentials are used once for CREATE DATABASE / CREATE USER /
 * CREATE EXTENSION and immediately dropped — config.json only stores the
 * least-privilege sigil_app creds.
 */

import pg from 'pg';

import { buildUrlConnection, classifyProvider } from './drivers/url.js';
import { ensureInstallId } from '../setup/config-store.js';

/**
 * Signature Sigil stamps onto the database it provisions, as a COMMENT ON
 * DATABASE. Lets later detection PROVE that a Postgres answering on a given port
 * is Sigil's OWN database — not a stranger's that merely happens to share the
 * port (the exact mix-up that connected an install to an unrelated dev DB).
 * Readable from the maintenance ('postgres') db via
 * shobj_description(oid,'pg_database'), so detection needs neither the sigil_app
 * password nor a connection into the sigil db. Versioned; detection matches on
 * the stable prefix and is forward-compatible with later format bumps.
 */
export const SIGIL_SIGNATURE_PREFIX = 'sigil-instance:v1';
export function buildSigilSignature(installId) {
  return installId ? `${SIGIL_SIGNATURE_PREFIX}:${installId}` : SIGIL_SIGNATURE_PREFIX;
}
export function isSigilSignature(s) {
  return typeof s === 'string' && s.startsWith('sigil-instance:');
}

const PG_ERR = {
  DB_DOES_NOT_EXIST: '3D000',
  CONNECTION_REFUSED: 'ECONNREFUSED',
  AUTH_FAILED: '28P01',
  EXTENSION_NOT_AVAILABLE: '0A000',
  // Postgres raises XX000 (internal_error) for a grab-bag of conditions; we
  // only pattern-match its message, never branch on the bare code.
  INTERNAL_ERROR: 'XX000',
};

export async function probeSigilConnection({ host, port, database, user, password }) {
  const client = new pg.Client({ host, port, database, user, password });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      code: err.code,
      message: err.message,
    };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

/**
 * Probe an external connection URL (Neon, Supabase, RDS, Render, Railway,
 * CockroachDB, self-hosted). Returns:
 *   { ok: true,  provider, connectMs, database, serverVersion, pgvector }
 *   { ok: false, stage: 'parse'|'connect'|'query', error, code? }
 *
 * Used by `sigil init` so URL setup applies the same SSL heuristics and
 * pgvector check before persisting the connection.
 */
export async function probeUrlConnection(url) {
  let connection;
  let provider = 'unknown';
  try {
    connection = buildUrlConnection(url);
    provider = classifyProvider(url);
  } catch (err) {
    return { ok: false, stage: 'parse', error: err.message };
  }

  const client = new pg.Client(connection);
  const t0 = Date.now();
  try {
    await client.connect();
  } catch (err) {
    return { ok: false, stage: 'connect', provider, error: err.message, code: err.code };
  }
  try {
    const sel = await client.query('SELECT current_database() AS db, version() AS version');
    const ext = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    return {
      ok: true,
      provider,
      connectMs: Date.now() - t0,
      database: sel.rows[0].db,
      serverVersion: sel.rows[0].version,
      pgvector: ext.rowCount > 0,
    };
  } catch (err) {
    return { ok: false, stage: 'query', provider, error: err.message, code: err.code };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

export async function ensurePostgresDatabase({
  admin: { host, port, user: adminUser, password: adminPassword },
  sigil: { database: sigilDb, user: sigilUser, password: sigilPassword },
}) {
  const adminClient = new pg.Client({
    host,
    port,
    database: 'postgres',
    user: adminUser,
    password: adminPassword,
  });

  await adminClient.connect();
  const actions = [];

  try {
    const dbExists = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [sigilDb],
    );
    if (dbExists.rowCount === 0) {
      await adminClient.query(`CREATE DATABASE ${quoteIdent(sigilDb)}`);
      actions.push(`created database "${sigilDb}"`);
    } else {
      actions.push(`database "${sigilDb}" already exists — left as-is`);
    }

    const userExists = await adminClient.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [sigilUser],
    );
    if (userExists.rowCount === 0) {
      await adminClient.query(
        `CREATE USER ${quoteIdent(sigilUser)} WITH PASSWORD ${quoteLiteral(sigilPassword)}`,
      );
      actions.push(`created user "${sigilUser}"`);
    } else {
      await adminClient.query(
        `ALTER USER ${quoteIdent(sigilUser)} WITH PASSWORD ${quoteLiteral(sigilPassword)}`,
      );
      actions.push(`user "${sigilUser}" exists — password reset to match config.json`);
    }

    await adminClient.query(
      `GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(sigilDb)} TO ${quoteIdent(sigilUser)}`,
    );

    // Stamp the database so detection can later prove it's Sigil's own (not some
    // other Postgres sharing the port). Best-effort: COMMENT ON DATABASE needs
    // ownership; if these admin creds lack it, skip and let the db+role
    // heuristic stand. Runs for both the freshly-created and pre-existing paths.
    try {
      await adminClient.query(
        `COMMENT ON DATABASE ${quoteIdent(sigilDb)} IS ${quoteLiteral(buildSigilSignature(ensureInstallId()))}`,
      );
      actions.push('stamped Sigil signature');
    } catch { /* not owner — signature is best-effort */ }
  } finally {
    await adminClient.end();
  }

  const dbAdminClient = new pg.Client({
    host,
    port,
    database: sigilDb,
    user: adminUser,
    password: adminPassword,
  });
  await dbAdminClient.connect();
  try {
    await dbAdminClient.query(`GRANT ALL ON SCHEMA public TO ${quoteIdent(sigilUser)}`);
    await dbAdminClient.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${quoteIdent(sigilUser)}`,
    );
    await dbAdminClient.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${quoteIdent(sigilUser)}`,
    );

    try {
      await dbAdminClient.query('CREATE EXTENSION IF NOT EXISTS vector');
      actions.push('pgvector extension ready');
    } catch (err) {
      if (err.code === PG_ERR.EXTENSION_NOT_AVAILABLE) {
        throw new Error(
          'pgvector extension is not installed on this Postgres server.\n'
          + '  • Docker:   use the `pgvector/pgvector:pg15` image instead of stock `postgres`\n'
          + '  • Homebrew: brew install pgvector  (then restart postgres)\n'
          + '  • apt:      apt install postgresql-15-pgvector  (15 → your major version)\n'
          + '  • RDS:      enable the `vector` extension in the parameter group\n'
          + 'Re-run `sigil init` once pgvector is installed.',
        );
      }
      throw err;
    }
  } finally {
    await dbAdminClient.end();
  }

  return { actions };
}

/**
 * Single source of truth for turning any setup-time failure — Postgres,
 * knex pool, pgvector, the embedding provider — into a HONEST, actionable
 * message. Both `sigil init` (CLI) and the GUI onboarding/settings RPCs call
 * this, so the cause the user sees is the cause that actually happened.
 *
 * This exists because the old code hardcoded "ensure ollama serve is running"
 * on ANY embedder failure — so a dead knex pool or a vector-dimension mismatch
 * masqueraded as an Ollama problem and cost real debugging hours. Never guess
 * the cause from the call site; classify the error here.
 *
 * Returns { kind, humanMessage, fixHint }:
 *   kind        — stable machine tag (for the GUI to branch on / show a button)
 *   humanMessage — what actually went wrong, in plain language
 *   fixHint     — the concrete next step
 *
 * Ordering matters: the most specific patterns are tested first so a generic
 * code (e.g. XX000) doesn't swallow a recognizable message.
 */
export function diagnoseError(err) {
  const code = err?.code;
  const msg = err?.message || String(err);

  // ── Embedding-provider failures (no pg code; matched on message) ──────────
  // Vector dimension mismatch: the configured EMBEDDING_DIMENSIONS (or the
  // model's native output) doesn't match the DB's vector(N) columns. This is
  // the exact trap that looked like an Ollama error before.
  if (/expected \d+ dimensions, not \d+/i.test(msg) || /different vector dimensions/i.test(msg)) {
    return {
      kind: 'dim-mismatch',
      humanMessage: 'The embedding size does not match the database. '
        + 'Your existing data uses a different vector dimension than the embedder you picked.',
      fixHint: 'Pick an embedding provider whose dimension matches the database, '
        + 'or wipe the embedding data and start fresh at the new dimension (Settings → Embedding).',
    };
  }
  // Embedding auth: provider rejected the API key (OpenAI/Voyage/OpenRouter 401/403).
  if (/\b401\b|\b403\b|invalid[_ ]api[_ ]key|incorrect api key|unauthorized/i.test(msg)
      && /openai|voyage|openrouter|embed/i.test(msg)) {
    return {
      kind: 'bad-key',
      humanMessage: 'The embedding provider rejected the API key.',
      fixHint: 'Check the API key has embedding access and is pasted correctly (Settings → Embedding).',
    };
  }
  // Embedding model not found: wrong model name for the provider.
  if (/model .* (not found|does not exist)|unknown model|no such model/i.test(msg)) {
    return {
      kind: 'model-not-found',
      humanMessage: 'The embedding model name was not recognized by the provider.',
      fixHint: 'Use a valid embedding model for the provider (e.g. text-embedding-3-large for OpenAI, '
        + 'mxbai-embed-large for Ollama).',
    };
  }
  // Ollama unreachable: the local daemon isn't running. ONLY surfaced when the
  // error actually points at the ollama endpoint — never as a catch-all.
  if (/11434|ollama/i.test(msg) && /ECONNREFUSED|fetch failed|connect|unreachable/i.test(msg)) {
    return {
      kind: 'ollama-down',
      humanMessage: 'The local Ollama server is not reachable.',
      fixHint: 'Start it with `ollama serve`, then `ollama pull mxbai-embed-large`.',
    };
  }

  // ── Knex pool torn down mid-flow (the B1 bug class) ───────────────────────
  if (/Unable to acquire a connection/i.test(msg) || /pool is (destroyed|draining)/i.test(msg)) {
    return {
      kind: 'pool-dead',
      humanMessage: 'The database connection pool was closed before this step ran.',
      fixHint: 'This is an internal sequencing bug, not your configuration — restart the daemon (Settings → Apply).',
    };
  }

  // ── Connection pooler can't run migrations (the B5 / Neon -pooler bug) ─────
  // PgBouncer transaction pooling rejects advisory locks / prepared statements
  // that knex migrations need. Neon raises XX000 with a pooler-ish message.
  if (/pooler|pgbouncer|prepared statement|advisory lock|endpoint could not be found/i.test(msg)) {
    return {
      kind: 'pooler-lock',
      humanMessage: 'This looks like a connection-pooler URL. Pooled connections cannot run database migrations.',
      fixHint: 'Use your direct (non-pooled) connection string for setup. '
        + 'For Neon, remove "-pooler" from the host.',
    };
  }

  // ── pgvector extension missing ────────────────────────────────────────────
  if (code === PG_ERR.EXTENSION_NOT_AVAILABLE
      || /extension "?vector"?|type "?vector"? does not exist/i.test(msg)) {
    return {
      kind: 'no-pgvector',
      humanMessage: 'The pgvector extension is not enabled on this database.',
      fixHint: 'Click "Install pgvector" (most managed providers allow it), '
        + 'or use a pgvector-enabled Postgres image.',
    };
  }

  // ── Core Postgres connection failures ─────────────────────────────────────
  if (code === PG_ERR.CONNECTION_REFUSED || /ECONNREFUSED/.test(msg)) {
    return {
      kind: 'unreachable',
      humanMessage: 'Postgres is not reachable at that host/port.',
      fixHint: 'Confirm the server is running and the host/port are correct '
        + '(`pg_isready -h <host> -p <port>`).',
    };
  }
  if (code === PG_ERR.AUTH_FAILED || /password authentication failed/i.test(msg)) {
    return {
      kind: 'auth',
      humanMessage: 'Postgres rejected the username or password.',
      fixHint: 'Fix the credentials in the connection settings.',
    };
  }
  if (code === PG_ERR.DB_DOES_NOT_EXIST || /database .* does not exist/i.test(msg)) {
    return {
      kind: 'missing-db',
      humanMessage: 'That database does not exist on the server yet.',
      fixHint: 'Create the database, or point Sigil at one that exists.',
    };
  }

  return { kind: 'other', humanMessage: msg.split('\n')[0], fixHint: null };
}

/**
 * Back-compat alias. Older callers expect { kind, hint }; map the new
 * humanMessage/fixHint shape onto `hint` so they keep working unchanged.
 */
export function diagnoseConnectionError(err) {
  const d = diagnoseError(err);
  return { kind: d.kind, hint: d.fixHint || d.humanMessage };
}

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to quote invalid SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
