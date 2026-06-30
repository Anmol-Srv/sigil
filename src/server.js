// MCP stdio entry. config.json is the single source of truth (loaded lazily by
// config.js → config-store); no .env is consulted.
import { startMcp } from './mcp/server.js';

await startMcp();
