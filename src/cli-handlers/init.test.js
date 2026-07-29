import { describe, expect, it } from 'vitest';

import { resolveLlmOnboardingMode } from './init.js';

describe('optional LLM onboarding mode', () => {
  it('asks with a default-off opt-in during normal interactive setup', () => {
    expect(resolveLlmOnboardingMode([])).toBe('ask');
  });

  it('supports explicit configure and skip modes for agents and scripts', () => {
    expect(resolveLlmOnboardingMode(['--with-llm'])).toBe('configure');
    expect(resolveLlmOnboardingMode(['--no-llm'])).toBe('skip');
  });

  it('rejects contradictory automation flags', () => {
    expect(() => resolveLlmOnboardingMode(['--with-llm', '--no-llm']))
      .toThrow('Use either --with-llm or --no-llm, not both.');
  });
});
