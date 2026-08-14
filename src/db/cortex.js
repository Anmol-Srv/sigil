import knex from 'knex';

import config from '../config.js';
import { selectDriver } from './drivers/index.js';

// The knex pool is built LAZILY, on first use — never at module load. Many
// modules import this default export, and several are pulled into the daemon's
// boot chain transitively (a handler → embedder → embedding-cache/llm-log →
// here). Building eagerly would run selectDriver() at import time and, for a
// not-yet-configured install, THROW its "not set up" error before the daemon
// could even serve the setup GUI. Deferring keeps "importing cortex" always
// safe; the clear error surfaces only when something actually queries the DB.
let pool = null;
function getPool() {
  if (pool) return pool;
  // Throws a clear `not_configured` error when no DB has been set up — instead
  // of silently connecting to whatever Postgres owns localhost:5432.
  const driver = selectDriver(config);
  pool = knex({
    // 'pg' for server-backed Postgres (url/local/docker), or the ClientPGlite
    // dialect class for the in-process embedded engine.
    client: driver.client || 'pg',
    connection: driver.connection,
    pool: {
      // min:0 — hooks are short-lived processes (open pool, do one query, exit).
      // The old min:2 forced two eager connections on every hook invocation and
      // kept them alive, wasting Postgres backends for a 10ms task.
      min: 0,
      // Embedded PGlite is single-connection (one in-process engine): a larger
      // pool only multiplexes onto the same engine and serializes anyway, so cap
      // at 1 to avoid tarn handing out "extra" connections that all contend.
      max: driver.kind === 'embedded' ? 1 : 10,
      // Don't hang forever when Postgres is down or saturated — fail fast so the
      // caller (hook/daemon) surfaces a clear error instead of blocking. tarn's
      // defaults are 30s; 10s is plenty for a local/cloud Postgres.
      //
      // Embedded is different, and 10s there was actively wrong. Model work is
      // now outside transactions, but PGlite still has one physical connection
      // shared by commits, checkpoints, traces and status reads. A short burst
      // can legitimately queue behind a durable job commit; waiting is correct.
      // Server Postgres keeps the fast failure, where max:10 means a timeout
      // really does signal trouble.
      // ponytail: a longer wait, not a bigger pool — PGlite is one engine, so
      // extra connections would serialize anyway.
      acquireTimeoutMillis: driver.kind === 'embedded' ? 120_000 : 10_000,
      createTimeoutMillis: 10_000,
      // Reap idle connections so a long-lived daemon doesn't pin backends.
      idleTimeoutMillis: 30_000,
    },
    postProcessResponse,
    wrapIdentifier,
  });
  pool.__sigilDriver = driver;
  return pool;
}

/**
 * Tear down the live pool and force the NEXT access to rebuild from current
 * config. Required in the long-lived daemon: `cortexDb.destroy()` alone closes
 * the knex pool but leaves `pool` pointing at the dead instance, so the lazy
 * `if (pool) return pool` would keep handing back a closed handle. Nulling it
 * lets a post-reset / post-reconfigure access build a fresh pool.
 *
 * For embedded mode this also releases the process-wide PGlite engine: knex's
 * destroy() chains into ClientPGlite.destroy() → destroyPGlite(), closing the
 * WASM instance so its `~/.sigil/db` directory can be safely removed.
 */
export async function resetCortexPool() {
  if (!pool) return;
  const dead = pool;
  pool = null;
  try { await dead.destroy(); } catch { /* already torn down */ }
}

// Transparent lazy handle: callable like a knex instance (cortexDb('fact')) and
// exposes every knex method/property (cortexDb.raw, .transaction, .destroy,
// .schema, …). The pool is created on first access. Functions are bound to the
// real instance so knex's internal `this` is correct when called as cortexDb.x().
const cortexDb = new Proxy(function cortexDb() {}, {
  apply(_t, _thisArg, args) { return getPool()(...args); },
  get(_t, prop) {
    const inst = getPool();
    const val = inst[prop];
    return typeof val === 'function' ? val.bind(inst) : val;
  },
  set(_t, prop, val) { getPool()[prop] = val; return true; },
  has(_t, prop) { return prop in getPool(); },
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
