import { describe, it, expect } from 'vitest';
import TOML from '@iarna/toml';

import { upsertTomlTable, deleteTomlTable, removeTomlTable, hasTomlTable } from './toml-table.js';

const ENTRY = { command: '/h/.sigil/bin/sigil-mcp', args: [], env: { SIGIL_AGENT: 'codex-cli' } };

const USER_CONFIG = `# my codex settings
model = "gpt-5" # pinned

[mcp_servers.other]
command = "other-mcp"   # keep me

# notes about profiles
[profiles.work]
approval_policy = "never"
`;

describe('upsertTomlTable', () => {
  it('adds the table and keeps every existing line, comments included', () => {
    const { text, lossless } = upsertTomlTable(USER_CONFIG, 'mcp_servers.sigil', ENTRY);
    expect(lossless).toBe(true);
    expect(text.startsWith(USER_CONFIG.trimEnd())).toBe(true);
    expect(TOML.parse(text).mcp_servers.sigil).toEqual(ENTRY);
    expect(TOML.parse(text).mcp_servers.other.command).toBe('other-mcp');
  });

  it('is idempotent', () => {
    const once = upsertTomlTable(USER_CONFIG, 'mcp_servers.sigil', ENTRY).text;
    expect(upsertTomlTable(once, 'mcp_servers.sigil', ENTRY).text).toBe(once);
  });

  it('replaces an older entry and its sub-tables in place, keeping comments of the next table', () => {
    const old = `[mcp_servers.sigil]
command = "/old/path"
args = []

[mcp_servers.sigil.env]
OLD = "1"

# notes about profiles
[profiles.work]
approval_policy = "never"
`;
    const { text, lossless } = upsertTomlTable(old, 'mcp_servers.sigil', ENTRY);
    expect(lossless).toBe(true);
    expect(text).toContain('# notes about profiles\n[profiles.work]');
    expect(text).not.toContain('/old/path');
    expect(text).not.toContain('OLD');
    expect(TOML.parse(text).mcp_servers.sigil).toEqual(ENTRY);
  });

  it('falls back to a full rewrite for an inline definition it cannot splice', () => {
    const inline = `[mcp_servers]\nsigil = { command = "/old" }\n`;
    const { text, lossless } = upsertTomlTable(inline, 'mcp_servers.sigil', ENTRY);
    expect(lossless).toBe(false);
    expect(TOML.parse(text).mcp_servers.sigil).toEqual(ENTRY);
  });

  it('throws on invalid TOML so the caller can refuse to touch the file', () => {
    expect(() => upsertTomlTable('this is = = broken', 'mcp_servers.sigil', ENTRY)).toThrow();
  });
});

describe('deleteTomlTable', () => {
  it('removes only the table, leaving the file as it was before', () => {
    const added = upsertTomlTable(USER_CONFIG, 'mcp_servers.sigil', ENTRY).text;
    const { text, removed, lossless } = deleteTomlTable(added, 'mcp_servers.sigil');
    expect(removed).toBe(true);
    expect(lossless).toBe(true);
    expect(text.trimEnd()).toBe(USER_CONFIG.trimEnd());
  });

  it('reports nothing to remove', () => {
    expect(deleteTomlTable(USER_CONFIG, 'mcp_servers.sigil')).toMatchObject({ removed: false, text: USER_CONFIG });
  });
});

describe('header matching', () => {
  it('treats quoted names as the same table and leaves look-alike tables alone', () => {
    const text = `[mcp_servers."sigil"]\ncommand = "x"\n\n[mcp_servers.sigil2]\ncommand = "y"\n`;
    expect(hasTomlTable(text, 'mcp_servers.sigil')).toBe(true);
    const out = removeTomlTable(text, 'mcp_servers.sigil');
    expect(out).toContain('[mcp_servers.sigil2]');
    expect(out).not.toContain('"x"');
  });
});
