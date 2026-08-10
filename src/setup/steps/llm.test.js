// Model choice used to be impossible or invisible:
//   • claude-cli had `fields: []` — no way to pick a model at all, so every
//     install silently ran whatever `config.llm.cliModel` defaulted to (haiku).
//   • anthropic had no model field either.
//   • the rest were free-text boxes you typed an id into from memory.
// These pin the picker: every provider now says which model it will use, and
// the values offered are real ones.

import { describe, it, expect, vi, afterEach } from 'vitest';

import step from './llm.js';

const modelField = (providers, id) =>
  providers.find((p) => p.id === id)?.fields.find((f) => f.name === 'model');

afterEach(() => { vi.unstubAllGlobals(); });

describe('llm step — model choice', () => {
  it('offers claude-cli the CLI aliases, defaulting to haiku', async () => {
    const f = modelField(step.listProviders(), 'claude-cli');
    expect(f).toBeTruthy();
    expect(f.type).toBe('select');
    expect(f.options.map((o) => o.value)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(f.default).toBe('haiku');
  });

  it('offers ALIASES for claude-cli, never pinned ids', () => {
    // A pinned id rots on the next model release; the CLI resolves an alias to
    // whatever is current. This is the whole reason the list is safe to hardcode.
    const f = modelField(step.listProviders(), 'claude-cli');
    for (const o of f.options) expect(o.value).not.toMatch(/\d{8}|-\d+-\d+/);
  });

  it('gives anthropic a model field at all', () => {
    const f = modelField(step.listProviders(), 'anthropic');
    expect(f?.type).toBe('select');
    expect(f.options.length).toBeGreaterThan(1);
  });

  it('includes codex as a provider', () => {
    expect(step.listProviders().some((p) => p.id === 'codex')).toBe(true);
  });

  it('leaves codex model optional — its own config is the default', () => {
    const f = modelField(step.listProviders(), 'codex');
    expect(f.optional).toBe(true);
  });
});

describe('llm step — detect() fills lists from the live machine', () => {
  it('turns the Ollama field into a picker of INSTALLED models', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.2:3b' }] }),
    }));
    const { providers } = await step.detect();
    const f = modelField(providers, 'ollama');
    expect(f.type).toBe('select');
    expect(f.options.map((o) => o.value)).toEqual(['qwen2.5:7b', 'llama3.2:3b']);
    expect(f.default).toBe('qwen2.5:7b');
  });

  it('degrades to free text when Ollama is unreachable', async () => {
    // A select with zero options is a dead end — the user could not proceed.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { providers } = await step.detect();
    const f = modelField(providers, 'ollama');
    expect(f.type).toBe('text');
    expect(f.options).toBeUndefined();
  });

  it('does not mutate the shared PROVIDERS list between calls', async () => {
    // detect() returns copies; a live Ollama on one call must not leave stale
    // options behind for the next.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ models: [{ name: 'only-this:1b' }] }),
    }));
    await step.detect();
    expect(modelField(step.listProviders(), 'ollama').options).toEqual([]);
  });
});

describe('llm step — validate', () => {
  it('does not demand a model from the CLI providers', () => {
    // Each CLI carries its own default, so an explicit pick is optional.
    expect(step.validate({ provider: 'claude-cli' }).ok).toBe(true);
    expect(step.validate({ provider: 'codex' }).ok).toBe(true);
  });

  it('still demands a key where one is genuinely needed', () => {
    const r = step.validate({ provider: 'anthropic' });
    expect(r.ok).toBe(false);
    expect(r.errors.apiKey).toBeTruthy();
  });

  it('still demands a model where there is no sensible default', () => {
    expect(step.validate({ provider: 'openai', apiKey: 'sk-x' }).errors.model).toBeTruthy();
    expect(step.validate({ provider: 'openai', apiKey: 'sk-x', model: 'gpt-4o-mini' }).ok).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(step.validate({ provider: 'nope' }).ok).toBe(false);
  });
});
