import TOML from '@iarna/toml';

import { MCP_SHIM_PATH } from '../lib/clients/shim.js';

const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export function buildStdioMcpConfig({ agent = 'mcp' } = {}) {
  const normalizedAgent = normalizeAgentId(agent);
  return {
    mcpServers: {
      sigil: {
        command: MCP_SHIM_PATH,
        args: [],
        env: { SIGIL_AGENT: normalizedAgent },
      },
    },
  };
}

export function renderStdioMcpConfig({ format = 'json', agent = 'mcp' } = {}) {
  const config = buildStdioMcpConfig({ agent });
  if (format === 'json') return `${JSON.stringify(config, null, 2)}\n`;
  if (format === 'toml') {
    return TOML.stringify({
      mcp_servers: {
        sigil: config.mcpServers.sigil,
      },
    });
  }
  throw new Error('MCP config format must be json or toml');
}

export function normalizeAgentId(value) {
  const agent = String(value || '').trim();
  if (!AGENT_ID_PATTERN.test(agent)) {
    throw new Error('MCP agent id must start with a letter and contain only letters, numbers, _ or - (max 64 characters)');
  }
  return agent;
}
