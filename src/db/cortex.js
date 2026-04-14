import knex from 'knex';

import config from '../config.js';
import { ClientPGlite, PGLITE_DB_PATH } from './pglite-adapter.js';

// Use PGlite (zero-install, embedded Postgres) by default.
// Set CORTEX_DB_TYPE=postgres to use an external Postgres instance instead.
const usePostgres = config.db.type === 'postgres';

const cortexDb = usePostgres
  ? knex({
      client: 'pg',
      connection: {
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
      },
      pool: { min: 2, max: 10 },
      postProcessResponse,
      wrapIdentifier,
    })
  : knex({
      client: ClientPGlite,
      connection: { pglitePath: PGLITE_DB_PATH },
      pool: { min: 1, max: 1 },
      postProcessResponse,
      wrapIdentifier,
    });

function postProcessResponse(result) {
  if (Array.isArray(result)) return result.map(toCamel);
  if (result && typeof result === 'object') return toCamel(result);
  return result;
}

function wrapIdentifier(value, origImpl) {
  return origImpl(toSnake(value));
}

function toCamel(obj) {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    // Only camelCase the top-level keys from DB columns.
    // Do NOT recurse into values — they may contain JSON data
    // with intentional snake_case keys (metadata, entityTypes, etc.).
    out[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = val;
  }
  return out;
}

function toSnake(str) {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export default cortexDb;
