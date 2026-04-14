// Support DOTENV_CONFIG_PATH for global installs where cwd is not the project root
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = process.env.DOTENV_CONFIG_PATH
  || (existsSync(resolve(process.cwd(), '.env')) ? resolve(process.cwd(), '.env') : null)
  || resolve(PKG_DIR, '.env');

dotenvConfig({ path: envPath, quiet: true });

import { startMcp } from './mcp/server.js';

await startMcp();
