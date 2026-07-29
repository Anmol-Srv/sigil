/**
 * Allowlisted built-in adapter manifests.
 *
 * This is intentionally discovery metadata, not an executable plugin system.
 * Loading third-party code from a directory would let a new integration change
 * agent configuration or consume resources inside the trusted Sigil install.
 * A future adapter can be added here with an explicit review of its declared
 * capabilities and owned paths; custom MCP clients need no adapter at all.
 */
export const BUILTIN_ADAPTERS = [
  {
    id: 'claude-code',
    load: () => import('./claude-code.js'),
    manifest: {
      version: 1,
      capabilities: { mcp: true, automaticRecall: true, instructions: true, healthCheck: true },
      ownedPaths: ['~/.claude/CLAUDE.md', '~/.claude/settings.json', '~/.claude/skills/sigil/', '~/.sigil/CLAUDE.md'],
    },
  },
  {
    id: 'codex-cli',
    load: () => import('./codex-cli.js'),
    manifest: {
      version: 1,
      capabilities: { mcp: true, automaticRecall: true, instructions: true, healthCheck: true },
      ownedPaths: ['~/.codex/config.toml', '~/.codex/AGENTS.md', '~/.codex/hooks.json', '~/.codex/skills/sigil/'],
    },
  },
  {
    id: 'cursor',
    load: () => import('./cursor.js'),
    manifest: {
      version: 1,
      capabilities: { mcp: true, automaticRecall: false, instructions: true, healthCheck: true },
      ownedPaths: ['~/.cursor/mcp.json', '~/.cursor/rules/sigil.mdc'],
    },
  },
  {
    id: 'kiro',
    load: () => import('./kiro.js'),
    manifest: {
      version: 1,
      capabilities: { mcp: true, automaticRecall: false, instructions: true, healthCheck: true },
      ownedPaths: ['~/.kiro/settings/mcp.json', '~/.kiro/steering/sigil.md'],
    },
  },
  {
    id: 'hermes',
    load: () => import('./hermes.js'),
    manifest: {
      version: 1,
      capabilities: { mcp: false, automaticRecall: false, instructions: false, healthCheck: true },
      ownedPaths: ['~/.hermes/hermes-agent/plugins/memory/sigil/', '~/.hermes/config.yaml'],
    },
  },
];
