import 'dotenv/config';

import { buildLocalConnection } from './src/db/drivers/local-postgres.js';
import { buildUrlConnection } from './src/db/drivers/url.js';

const env = (key, fallback) => process.env[key] ?? fallback;

const url = env('SIGIL_DATABASE_URL', env('DATABASE_URL', ''));

const connection = url
  ? buildUrlConnection(url)
  : buildLocalConnection({
      db: {
        host: env('SIGIL_DB_HOST', 'localhost'),
        port: Number(env('SIGIL_DB_PORT', 5432)),
        database: env('SIGIL_DB_NAME', 'sigil'),
        user: env('SIGIL_DB_USER', 'sigil_app'),
        password: env('SIGIL_DB_PASSWORD', ''),
      },
    });

export default {
  client: 'pg',
  connection,
  migrations: { directory: './src/db/migrations' },
};
