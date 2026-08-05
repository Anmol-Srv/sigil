import { describe, expect, it } from 'vitest';

import { promptText } from './prompt-input.js';

describe('prompt hook input', () => {
  it('accepts a text prompt and removes blank padding', () => {
    expect(promptText({ prompt: '  recall the auth decision  ' })).toBe('recall the auth decision');
  });

  it('accepts a text-wrapped prompt without forwarding an object to search', () => {
    expect(promptText({ prompt: { text: 'use the shared filter service' } })).toBe('use the shared filter service');
  });

  it('skips empty and unsupported payloads', () => {
    expect(promptText({ prompt: '    ' })).toBe('');
    expect(promptText({ prompt: { content: 'not a text payload' } })).toBe('');
    expect(promptText(null)).toBe('');
  });
});
