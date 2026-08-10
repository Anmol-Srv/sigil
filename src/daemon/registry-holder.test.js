/**
 * Provider-health cache invalidation.
 *
 * The bug this locks down: the boot probe ran once, and a config written after
 * boot (`sigil init` in a terminal, 58 seconds late) left the daemon reporting
 * "not configured" for three days while both providers worked fine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Override statSync only — paths.js resolves the install root via existsSync at
// import time, so a wholesale fs mock breaks the module graph before we start.
const statSync = vi.fn();
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  statSync: (...a) => statSync(...a),
}));

const probeProviders = vi.fn();
vi.mock('../lib/provider-probe.js', () => ({ probeProviders: (...a) => probeProviders(...a) }));

const BOOT = 1_000_000;
const CONFIGURED = {
  checkedAt: BOOT + 5_000,
  llm: { ok: true, provider: 'claude-cli', model: null, error: null },
  embedding: { ok: true, provider: 'ollama', model: 'mxbai-embed-large', dim: 1024, error: null },
};

let holder;
beforeEach(async () => {
  vi.resetModules();
  statSync.mockReset();
  probeProviders.mockReset();
  probeProviders.mockResolvedValue(CONFIGURED);
  holder = await import('./registry-holder.js');
});

// The refresh is fire-and-forget behind a dynamic import, so it lands several
// ticks later. Poll rather than guessing a delay — a fixed setTimeout let one
// test's probe resolve inside the next one.
const probed = (n) => vi.waitFor(() => expect(probeProviders).toHaveBeenCalledTimes(n));

describe('provider health staleness', () => {
  it('does not re-probe before the boot probe has reported', () => {
    statSync.mockReturnValue({ mtimeMs: BOOT + 60_000 });
    expect(holder.configWrittenSinceProbe()).toBe(false);
  });

  it('does not re-probe when config predates the probe', () => {
    holder.setProviderHealth({ checkedAt: BOOT });
    statSync.mockReturnValue({ mtimeMs: BOOT - 1 });
    expect(holder.configWrittenSinceProbe()).toBe(false);
  });

  it('re-probes when config was written after the probe', () => {
    holder.setProviderHealth({ checkedAt: BOOT });
    statSync.mockReturnValue({ mtimeMs: BOOT + 58_000 });
    expect(holder.configWrittenSinceProbe()).toBe(true);
  });

  it('treats an unreadable config as nothing to refresh', () => {
    holder.setProviderHealth({ checkedAt: BOOT });
    statSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(holder.configWrittenSinceProbe()).toBe(false);
  });
});

describe('getProviderHealth', () => {
  it('replaces a stale "not configured" verdict with a fresh probe', async () => {
    // Exactly the reported state: booted with no config, probed, then configured.
    holder.setProviderHealth({
      checkedAt: BOOT,
      llm: { ok: false, provider: null, error: 'not configured' },
      embedding: { ok: false, provider: null, error: 'not configured' },
    });
    statSync.mockReturnValue({ mtimeMs: BOOT + 58_000 });

    // The stale value is still returned to this caller — the refresh is async.
    expect(holder.getProviderHealth().llm.ok).toBe(false);
    await probed(1);

    const fresh = holder.getProviderHealth();
    expect(fresh.llm).toMatchObject({ ok: true, provider: 'claude-cli' });
    expect(fresh.embedding).toMatchObject({ ok: true, provider: 'ollama' });
  });

  it('stops re-probing once the refreshed snapshot post-dates the config', async () => {
    holder.setProviderHealth({ checkedAt: BOOT, llm: { ok: false, error: 'not configured' } });
    statSync.mockReturnValue({ mtimeMs: BOOT + 1_000 });

    holder.getProviderHealth();
    await probed(1);

    // checkedAt is now newer than the config write — a 5s status poll must not
    // spawn a live LLM call every time.
    for (let i = 0; i < 5; i++) holder.getProviderHealth();
    expect(probeProviders).toHaveBeenCalledTimes(1);
  });

  it('runs at most one probe while polling hammers a still-stale snapshot', async () => {
    holder.setProviderHealth({ checkedAt: BOOT });
    statSync.mockReturnValue({ mtimeMs: BOOT + 1_000 });
    let release;
    probeProviders.mockReturnValue(new Promise((r) => { release = () => r(CONFIGURED); }));

    for (let i = 0; i < 5; i++) holder.getProviderHealth();
    await probed(1);
    for (let i = 0; i < 5; i++) holder.getProviderHealth();
    expect(probeProviders).toHaveBeenCalledTimes(1);

    release();
  });

  it('keeps serving the previous verdict when the probe blows up', async () => {
    holder.setProviderHealth({ checkedAt: BOOT, llm: { ok: true, provider: 'claude-cli' } });
    statSync.mockReturnValue({ mtimeMs: BOOT + 1_000 });
    probeProviders.mockRejectedValue(new Error('provider module missing'));

    holder.getProviderHealth();
    await probed(1);

    expect(holder.getProviderHealth().llm).toMatchObject({ ok: true, provider: 'claude-cli' });
  });
});
