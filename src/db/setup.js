/**
 * Postgres database bootstrap. Assumes the user has Postgres running
 * (Docker container, brew service, RDS, whatever) and creates the
 * sigil database + sigil_app user + pgvector extension inside it.
 *
 * Called from `sigil init` (interactive prompt for admin creds) and as
 * a hint from `sigil migrate` when the target DB doesn't exist yet.
 *
 * Admin credentials are used once for CREATE DATABASE / CREATE USER /
 * CREATE EXTENSION and immediately dropped — the .env only stores the
 * least-privilege sigil_app creds.
 */

import pg from 'pg';

import { buildUrlConnection, classifyProvider } from './drivers/url.js';

const PG_ERR = {
  DB_DOES_NOT_EXIST: '3D000',
  CONNECTION_REFUSED: 'ECONNREFUSED',
  AUTH_FAILED: '28P01',
  EXTENSION_NOT_AVAILABLE: '0A000',
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
 * Shared by `sigil init` and the GUI's testDbConnection RPC so both
 * paths apply the same SSL heuristics and the same pgvector check.
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
      actions.push(`user "${sigilUser}" exists — password reset to match .env`);
    }

    await adminClient.query(
      `GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(sigilDb)} TO ${quoteIdent(sigilUser)}`,
    );
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

export function diagnoseConnectionError(err) {
  const code = err?.code;
  const msg = err?.message || String(err);

  if (code === PG_ERR.CONNECTION_REFUSED || /ECONNREFUSED/.test(msg)) {
    return {
      kind: 'unreachable',
      hint: 'Is Postgres running? Try `docker ps | grep postgres` or `pg_isready -h <host> -p <port>`.',
    };
  }
  if (code === PG_ERR.AUTH_FAILED || /password authentication failed/i.test(msg)) {
    return {
      kind: 'auth',
      hint: 'Wrong username or password. Re-run `sigil init` to reset, or edit ~/.sigil/.env.',
    };
  }
  if (code === PG_ERR.DB_DOES_NOT_EXIST || /database .* does not exist/i.test(msg)) {
    return {
      kind: 'missing-db',
      hint: 'The Sigil database does not exist yet. Run `sigil init` to create it.',
    };
  }
  return { kind: 'other', hint: msg.split('\n')[0] };
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
