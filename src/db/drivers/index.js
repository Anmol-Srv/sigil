/**
 * DB driver selection — driven entirely by config.json (config.db.*); no env.
 *
 *   - config.db.mode === 'embedded' → the in-process PGlite engine (a full
 *     Postgres 17 + pgvector compiled to WASM, no server, no Docker). Data at
 *     ~/.sigil/db.
 *   - Else if config.db.url is set → the URL driver (Neon, Supabase, RDS,
 *     Render, Railway, self-hosted, etc.).
 *   - Else if config.db.mode === 'local' → the local-postgres driver from the
 *     stored host/port/name/user/password.
 *   - Otherwise → throw notConfiguredError() (setup never finished).
 *
 * Returns a descriptor: { kind, provider, connection, client }. `connection` is
 * a pg-shape object for the URL/local drivers, or { pglitePath } for embedded.
 * `client` is 'pg' for server-backed Postgres or the ClientPGlite dialect class
 * for embedded — passed straight to knex({ client }). Pool config and
 * post-processing are applied by the caller (cortex.js).
 */
import { buildLocalConnection, buildLocalConnectionFromFields } from './local-postgres.js';
import { buildUrlConnection, classifyProvider } from './url.js';
// Cheap to import: the adapter only pulls knex's pg dialect at module load and
// defers the actual @electric-sql/pglite import to first connection.
import { ClientPGlite, PGLITE_DB_PATH } from '../pglite-adapter.js';

export function selectDriver(config) {
  const mode = config.db.mode;
  if (mode === 'embedded') {
    return {
      kind: 'embedded',
      provider: 'pglite',
      client: ClientPGlite,
      connection: { pglitePath: process.env.SIGIL_PGLITE_PATH || PGLITE_DB_PATH },
    };
  }
  const url = config.db.url;
  if (url) {
    return {
      kind: 'url',
      provider: classifyProvider(url),
      connection: normalizeConnection(buildUrlConnection(url)),
      client: 'pg',
    };
  }
  // Field-based local Postgres — ONLY when the user EXPLICITLY chose it (setup
  // persisted mode 'local'). A null/unknown mode with no URL means setup never
  // finished — and building a local driver here would silently point config.db's
  // defaults (localhost:5432, user sigil_app) at whatever foreign Postgres owns
  // that port, producing a baffling auth error against someone else's database
  // instead of an honest "Sigil isn't set up". Fail loud instead. (config.json
  // is the sole source of truth — the legacy SIGIL_DB_* env escape hatch is gone.)
  if (mode === 'local') {
    return {
      kind: 'local',
      provider: 'local',
      connection: normalizeConnection(buildLocalConnection(config)),
      client: 'pg',
    };
  }
  throw notConfiguredError();
}

function notConfiguredError() {
  const err = new Error(
    'Sigil has no database configured yet. Run `sigil` to set up (the built-in '
    + 'zero-prerequisite embedded engine) or `sigil init` in the terminal. Refusing to '
    + 'connect to a default localhost:5432 — that would hit whatever Postgres happens to '
    + 'own that port, not Sigil\'s.',
  );
  err.code = 'not_configured';
  return err;
}

// pg throws "SASL: client password must be a string" if password is null/
// undefined. Coerce credentials to strings so a missing value degrades to a
// clear auth error (or a no-password connect) instead of a cryptic SASL crash.
function normalizeConnection(conn) {
  if (conn.password == null) conn.password = '';
  if (conn.user == null) delete conn.user;
  return conn;
}

export { buildLocalConnection, buildLocalConnectionFromFields, buildUrlConnection, classifyProvider };
