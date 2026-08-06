// Hermes ships a `memory:` block with no `provider:` key. The old boolean
// return collapsed "already correct" and "found nothing to edit" into the same
// `false`, so install reported "memory.provider already 'sigil'" while writing
// nothing — and doctor then failed forever on a config `sigil init` could never
// repair. Seen live: connect said skip/ok, doctor said "is '' (expected
// 'sigil')", on every run.

import { describe, it, expect } from 'vitest';

import { setMemoryProviderInYaml } from './hermes.js';

const WITH_PROVIDER = `agent:\n  name: x\n\nmemory:\n  memory_enabled: true\n  provider: 'none'\n  nudge_interval: 10\n\ndelegation:\n  provider: 'openai'\n`;
const NO_PROVIDER = `agent:\n  name: x\n\nmemory:\n  # Agent's personal notes\n  memory_enabled: true\n  nudge_interval: 10\n\ndelegation:\n  provider: 'openai'\n`;

describe('setMemoryProviderInYaml', () => {
  it('replaces an existing provider value', () => {
    const { content, outcome } = setMemoryProviderInYaml(WITH_PROVIDER, 'sigil');
    expect(outcome).toBe('replaced');
    expect(content).toContain("  provider: 'sigil'");
    // The identically-named key under delegation: must be untouched.
    expect(content).toContain("delegation:\n  provider: 'openai'");
  });

  it('reports unchanged when it already holds the value', () => {
    const already = WITH_PROVIDER.replace("provider: 'none'", "provider: 'sigil'");
    expect(setMemoryProviderInYaml(already, 'sigil').outcome).toBe('unchanged');
  });

  it('INSERTS the key when the memory: block has none (the bug)', () => {
    const { content, outcome } = setMemoryProviderInYaml(NO_PROVIDER, 'sigil');
    expect(outcome).toBe('inserted');
    expect(content).toContain("memory:\n  provider: 'sigil'");
    // Still exactly one provider under memory:, and delegation's is intact.
    expect(content).toContain("delegation:\n  provider: 'openai'");
    // Everything else in the block survives.
    expect(content).toContain('memory_enabled: true');
    expect(content).toContain('nudge_interval: 10');
  });

  it('is idempotent — a second pass over inserted output changes nothing', () => {
    const first = setMemoryProviderInYaml(NO_PROVIDER, 'sigil').content;
    expect(setMemoryProviderInYaml(first, 'sigil').outcome).toBe('unchanged');
  });

  it('reports no-block rather than pretending success', () => {
    expect(setMemoryProviderInYaml('agent:\n  name: x\n', 'sigil').outcome).toBe('no-block');
  });
});
