/**
 * External-connection service — point Sigil at a Postgres you already run
 * (managed: Neon/Supabase/RDS/…, or self-hosted via a connection string).
 *
 * Creates the target database if it doesn't exist (self-hosted case), enables
 * pgvector when the credentials allow it (managed providers usually pre-enable
 * it), runs migrations into that database, then persists + verifies.
 */
import pg from 'pg';

import { probeUrlConnection, buildSigilSignature } from '../../db/setup.js';
import { ensureInstallId } from '../config-store.js';
import { buildUrlConnection } from '../../db/drivers/index.js';
import { runMigrationsOn } from '../../db/migrate.js';
import { StepError, fromError, quoteIdent, quoteLiteral, persistDatabase } from './shared.js';
import { verifyConnection } from './test.js';

/**
 * @param {{url:string}} input
 * @param {(p:{pct:number,label:string})=>void} emit
 */
export async function provisionExternal(input, emit = () => {}) {
  const { url } = input;
  try {
    emit({ pct: 10, label: 'Validating connection string…' });
    let conn;
    try {
      conn = buildUrlConnection(url);
    } catch (e) {
      throw new StepError({ message: `That connection string is malformed: ${e.message}`, kind: 'other' });
    }

    // Probe. If the named database doesn't exist yet (self-hosted), create it
    // via the maintenance ('postgres') db on the same server.
    let probe = await probeUrlConnection(url);
    if (!probe.ok && probe.stage === 'connect' && probe.code === '3D000') {
      emit({ pct: 30, label: `Creating database "${conn.database}"…` });
      await createDatabaseIfMissing(conn);
      probe = await probeUrlConnection(url);
    }
    if (!probe.ok) {
      throw new StepError({
        message: probe.stage === 'parse'
          ? `That connection string is malformed: ${probe.error}`
          : `Could not reach that database (${probe.stage}): ${probe.error}`,
        hint: 'Double-check the host, port, credentials, and SSL settings.',
        kind: 'unreachable',
      });
    }

    // Ensure pgvector — enable it ourselves when the creds allow; otherwise
    // surface the managed-provider hint.
    if (!probe.pgvector) {
      emit({ pct: 45, label: 'Enabling pgvector…' });
      const en = await enablePgvector(conn);
      if (!en.ok) {
        throw new StepError({
          message: 'pgvector is not enabled, and these credentials cannot enable it.',
          hint: 'Enable the `vector` extension (managed providers expose this in their dashboard), then retry.',
          kind: 'no-pgvector',
        });
      }
    }

    emit({ pct: 65, label: 'Running migrations…' });
    const m = await runMigrationsOn({ url });

    emit({ pct: 90, label: 'Verifying connection…' });
    const verified = await verifyConnection({ url });

    // Best-effort signature so detection can recognize this as Sigil's db later.
    // Managed/self-hosted owners can comment their own db; if these creds can't,
    // skip silently — external mode connects by URL, so it never relies on this.
    try {
      const sigClient = new pg.Client(conn);
      await sigClient.connect();
      try {
        await sigClient.query(
          `COMMENT ON DATABASE ${quoteIdent(conn.database)} IS ${quoteLiteral(buildSigilSignature(ensureInstallId()))}`,
        );
      } finally { try { await sigClient.end(); } catch { /* */ } }
    } catch { /* signature is best-effort */ }

    persistDatabase({ mode: 'url', url, host: null, port: null, name: verified.database, user: null, password: null });
    emit({ pct: 100, label: 'Database ready.' });
    return { mode: 'url', database: verified.database, provider: verified.provider, migrationsRan: m.ran.length };
  } catch (err) {
    throw err instanceof StepError ? err : fromError(err);
  }
}

/** Create the URL's target database via the maintenance ('postgres') db. */
async function createDatabaseIfMissing(conn) {
  const maint = new pg.Client({ ...conn, database: 'postgres' });
  await maint.connect();
  try {
    const ex = await maint.query('SELECT 1 FROM pg_database WHERE datname = $1', [conn.database]);
    if (ex.rowCount === 0) await maint.query(`CREATE DATABASE ${quoteIdent(conn.database)}`);
  } finally {
    try { await maint.end(); } catch { /* */ }
  }
}

/** CREATE EXTENSION IF NOT EXISTS vector in the target db; reports failure. */
async function enablePgvector(conn) {
  const c = new pg.Client(conn);
  await c.connect();
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS vector');
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  } finally {
    try { await c.end(); } catch { /* */ }
  }
}
