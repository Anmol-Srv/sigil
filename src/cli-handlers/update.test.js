import { describe, expect, it, vi } from 'vitest';

import { refreshInstalledAdapters } from './update.js';

describe('update generated-agent-content refresh', () => {
  it('refreshes only verified adapters and reports changed managed assets', async () => {
    const current = {
      id: 'codex-cli', label: 'Codex CLI',
      verify: vi.fn().mockResolvedValue({ installed: true }),
      refresh: vi.fn().mockResolvedValue({ actions: [{ action: 'modify', path: '/tmp/AGENTS.md' }] }),
    };
    const absent = {
      id: 'cursor', label: 'Cursor',
      verify: vi.fn().mockResolvedValue({ installed: false }),
      refresh: vi.fn(),
    };
    const logs = [];

    const result = await refreshInstalledAdapters({
      list: async () => [current, absent],
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ refreshed: ['codex-cli'], skipped: ['cursor'] });
    expect(current.refresh).toHaveBeenCalledWith({ dryRun: false });
    expect(absent.refresh).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('codex-cli');
  });

  it('keeps updating other integrations when one refresh fails', async () => {
    const failed = {
      id: 'broken', label: 'Broken',
      verify: async () => ({ installed: true }),
      refresh: async () => { throw new Error('read-only filesystem'); },
    };
    const healthy = {
      id: 'claude-code', label: 'Claude Code',
      verify: async () => ({ installed: true }),
      refresh: async () => ({ actions: [{ action: 'modify', path: '/tmp/SKILL.md' }] }),
    };
    const logs = [];

    const result = await refreshInstalledAdapters({
      list: async () => [failed, healthy],
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ refreshed: ['claude-code'], skipped: ['broken'] });
    expect(logs.join('\n')).toContain('could not refresh Sigil-owned content for Broken');
  });
});
