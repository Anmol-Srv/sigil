import 'dotenv/config';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ClientPGlite, PGLITE_DB_PATH } from './src/db/pglite-adapter.js';

const usePostgres = process.env.CORTEX_DB_TYPE === 'postgres';

export default usePostgres
  ? {
      client: 'pg',
      connection: {
        host: process.env.CORTEX_DB_HOST || 'localhost',
        port: Number(process.env.CORTEX_DB_PORT) || 5432,
        database: process.env.CORTEX_DB_NAME || 'cortex',
        user: process.env.CORTEX_DB_USER || 'cortex_app',
        password: process.env.CORTEX_DB_PASSWORD || '',
      },
      migrations: { directory: './src/db/migrations' },
    }
  : {
      client: ClientPGlite,
      connection: { pglitePath: PGLITE_DB_PATH },
      pool: { min: 1, max: 1 },
      migrations: { directory: './src/db/migrations' },
    };
