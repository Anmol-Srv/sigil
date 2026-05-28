/**
 * Local-Postgres driver: builds a pg connection from the discrete
 * SIGIL_DB_HOST / PORT / NAME / USER / PASSWORD env vars. This is the
 * original Sigil behavior and remains the default when no URL is set.
 */
export function buildLocalConnection(config) {
  return {
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
  };
}
