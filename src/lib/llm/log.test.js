import { describe, expect, it } from 'vitest';

import { estimateTokens, isRetryable } from './log.js';

describe('LLM helper boundary', () => {
  it('keeps token estimation local and bounded', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('12345')).toBe(2);
  });

  it('retries only transient provider errors', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable(new Error('OpenAI error 404: unknown model'))).toBe(false);
  });
});
