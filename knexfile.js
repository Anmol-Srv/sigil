// Knex config for `npm run migrate` (server-Postgres installs only — embedded/
// PGlite migrates daemon-side via the migrateSafe RPC, never through knex).
//
// config.json is the single source of truth: read the DB connection from it via
// src/config.js (which owns the database.* → db.* field bridge). No .env, no env
// vars — `sigil init`/the GUI write config.json, and that's what migrations use.
import config from './src/config.js';
import { buildLocalConnection } from './src/db/drivers/local-postgres.js';
import { buildUrlConnection } from './src/db/drivers/url.js';

const connection = config.db.url
  ? buildUrlConnection(config.db.url)
  : buildLocalConnection({
      db: {
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
      },
    });

export default {
  client: 'pg',
  connection,
  migrations: { directory: './src/db/migrations' },
};
