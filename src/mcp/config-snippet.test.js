import TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import { buildStdioMcpConfig, normalizeAgentId, renderStdioMcpConfig } from './config-snippet.js';

describe('generic MCP configuration', () => {
  it('creates a portable stdio entry with explicit write provenance', () => {
    const config = buildStdioMcpConfig({ agent: 'my_tool' });
    expect(config.mcpServers.sigil).toMatchObject({
      command: expect.stringContaining('/.sigil/bin/sigil-mcp'),
      args: [],
      env: { SIGIL_AGENT: 'my_tool' },
    });
  });

  it('renders valid JSON and TOML without a client-specific adapter', () => {
    expect(JSON.parse(renderStdioMcpConfig())).toHaveProperty('mcpServers.sigil');
    expect(TOML.parse(renderStdioMcpConfig({ format: 'toml' }))).toHaveProperty('mcp_servers.sigil');
  });

  it('rejects unsafe or malformed agent identifiers', () => {
    expect(normalizeAgentId('codex')).toBe('codex');
    expect(() => normalizeAgentId('bad agent; rm -rf')).toThrow('MCP agent id');
  });
});
