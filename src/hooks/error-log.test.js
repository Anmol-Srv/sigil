// Tests for the F6 hook-error collapse — the dedup that turns a burst of the
// same failure into one counted group, so doctor and the proactive warning show
// distinct issues rather than raw line volume.

import { describe, it, expect } from 'vitest';

import { collapseEntries, parseEntries } from './error-log.js';

describe('collapseEntries', () => {
  it('collapses repeated identical errors into one counted group', () => {
    const entries = [
      { ts: '2026-06-08T10:00:00Z', hook: 'stop', error: 'fetch failed' },
      { ts: '2026-06-08T10:00:01Z', hook: 'stop', error: 'fetch failed' },
      { ts: '2026-06-08T10:00:02Z', hook: 'stop', error: 'fetch failed' },
    ];
    const groups = collapseEntries(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      hook: 'stop', error: 'fetch failed', count: 3,
      ts: '2026-06-08T10:00:00Z',       // first occurrence
      lastTs: '2026-06-08T10:00:02Z',   // most recent occurrence
    });
  });

  it('keeps distinct hooks and distinct messages separate', () => {
    const groups = collapseEntries([
      { ts: '1', hook: 'stop', error: 'A' },
      { ts: '2', hook: 'user-prompt-submit', error: 'A' }, // same msg, different hook
      { ts: '3', hook: 'stop', error: 'B' },               // same hook, different msg
      { ts: '4', hook: 'stop', error: 'A' },               // dup of the first
    ]);
    expect(groups).toHaveLength(3);
    const stopA = groups.find((g) => g.hook === 'stop' && g.error === 'A');
    expect(stopA.count).toBe(2);
  });

  it('preserves first-seen order', () => {
    const groups = collapseEntries([
      { ts: '1', hook: 'h', error: 'first' },
      { ts: '2', hook: 'h', error: 'second' },
      { ts: '3', hook: 'h', error: 'first' },
    ]);
    expect(groups.map((g) => g.error)).toEqual(['first', 'second']);
  });

  it('handles an empty list', () => {
    expect(collapseEntries([])).toEqual([]);
  });
});

describe('parseEntries', () => {
  it('parses NDJSON and skips malformed lines', () => {
    const raw = [
      '{"ts":"1","hook":"stop","error":"x"}',
      'not json{',
      '',
      '{"ts":"2","hook":"stop","error":"y"}',
    ].join('\n');
    const entries = parseEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.error)).toEqual(['x', 'y']);
  });
});
