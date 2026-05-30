// External-Postgres guard for the Docker tier. The subprocess-hook e2e needs a
// REAL connectable Postgres (PGlite is in-process only — a spawned hook can't
// reach it). When no test PG is reachable the suite skips, exactly like the
// Ollama guard, so local runs without Docker aren't blocked.
//
// Bring one up: `npm run db:test:up` (docker compose), or point
// SIGIL_TEST_PG_URL at any pgvector instance.

export const TEST_PG_URL =
  process.env.SIGIL_TEST_PG_URL || 'postgres://cortex_app:cortex_pass@127.0.0.1:5434/cortex-gen';

export async function pgReachable(url = TEST_PG_URL) {
  if (!url) return false;
  let client;
  try {
    const pg = await import('pg');
    const Client = pg.default?.Client || pg.Client;
    client = new Client({ connectionString: url, connectionTimeoutMillis: 1500 });
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    try { if (client) await client.end(); } catch { /* ignore */ }
  }
}

export const PG_SKIP_MSG =
  'No reachable test Postgres — skipping Docker-tier subprocess-hook e2e. '
  + 'Start one with `npm run db:test:up` (or set SIGIL_TEST_PG_URL).';
