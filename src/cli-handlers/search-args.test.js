import { describe, it, expect } from 'vitest';

import { parseSearchAuthorFlags } from './search-args.js';

describe('parseSearchAuthorFlags', () => {
  it('parses --agent=value form', () => {
    expect(parseSearchAuthorFlags(['--agent=cursor'])).toEqual({ agent: 'cursor', device: null });
  });

  it('parses --agent value (space-separated) form', () => {
    expect(parseSearchAuthorFlags(['--agent', 'claude-code'])).toEqual({ agent: 'claude-code', device: null });
  });

  it('parses --device=value form (numeric id)', () => {
    expect(parseSearchAuthorFlags(['--device=3'])).toEqual({ agent: null, device: '3' });
  });

  it('parses --device value (friendly name)', () => {
    expect(parseSearchAuthorFlags(['--device', 'laptop-b'])).toEqual({ agent: null, device: 'laptop-b' });
  });

  it('parses both flags together', () => {
    expect(parseSearchAuthorFlags(['--agent', 'cli', '--device=2']))
      .toEqual({ agent: 'cli', device: '2' });
  });

  it('returns nulls when flags absent (back-compat)', () => {
    expect(parseSearchAuthorFlags(['--limit=5', '--graph'])).toEqual({ agent: null, device: null });
  });

  it('treats an empty value as absent', () => {
    expect(parseSearchAuthorFlags(['--agent='])).toEqual({ agent: null, device: null });
  });

  it('does not consume the next flag as a value', () => {
    expect(parseSearchAuthorFlags(['--agent', '--device=2']))
      .toEqual({ agent: null, device: '2' });
  });
});
