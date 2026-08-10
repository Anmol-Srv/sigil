/**
 * The dashboard's two pieces of decision logic, tested without a DOM:
 * which failure gets the banner, and what the Home readout says.
 *
 * The case that matters most is `unavailable` — a store that can't be read
 * must never render as a store that is empty.
 */
import { describe, it, expect } from 'vitest';
import { systemAlert, systemCells, condenseProviderError } from './health.js';
import { fuzzy } from './cmdk.js';

const HEALTHY = {
  db: { healthy: true, error: null, schema: 'ready' },
  writeQueue: 0,
  providers: { llm: { ok: true, provider: 'anthropic', model: 'claude-opus-5' },
    embedding: { ok: true, provider: 'openai', model: 'text-embedding-3-small' } },
};
const cell = (status, k) => systemCells(status).find((c) => c.k === k);

describe('systemAlert', () => {
  it('stays silent when everything is up', () => {
    expect(systemAlert(HEALTHY)).toBeNull();
  });

  it('raises an error banner when the store is unreachable, carrying the reason', () => {
    const a = systemAlert({ ...HEALTHY, unavailable: true, db: { healthy: false, error: 'ECONNREFUSED 127.0.0.1:5432' } });
    expect(a.level).toBe('err');
    expect(a.body).toContain('ECONNREFUSED');
    expect(a.action.route).toBe('setup');
  });

  it('distinguishes a missing schema from an unreachable store', () => {
    const a = systemAlert({ db: { healthy: false, schema: 'missing' } });
    expect(a.title).toMatch(/schema/i);
    expect(a.action.label).toBe('Run migrations');
  });

  it('prefers the store failure over a simultaneous provider failure', () => {
    const a = systemAlert({ unavailable: true, db: { healthy: false, error: 'down' },
      providers: { embedding: { ok: false, provider: 'openai', error: '401' } } });
    expect(a.title).toMatch(/store/i);
  });

  it('prefers a dead embedder over a dead LLM', () => {
    const a = systemAlert({ ...HEALTHY, providers: {
      llm: { ok: false, provider: 'anthropic', error: 'timeout' },
      embedding: { ok: false, provider: 'openai', error: '401 bad key' } } });
    expect(a.level).toBe('warn');
    expect(a.body).toContain('401 bad key');
    expect(a.action.label).toBe('Change embedding');
  });

  it('says nothing while the boot probe has not reported yet', () => {
    expect(systemAlert({ db: { healthy: true }, providers: { llm: null, embedding: null } })).toBeNull();
  });
});

describe('systemCells', () => {
  it('reports an unreadable store as unreachable, never as healthy', () => {
    expect(cell({ unavailable: true, db: { healthy: false } }, 'Store')).toMatchObject({ s: 'err', v: 'unreachable' });
  });

  it('reports a queued write as a warning with its depth', () => {
    expect(cell({ ...HEALTHY, writeQueue: 3 }, 'Write queue')).toMatchObject({ s: 'warn', v: '3 waiting' });
  });

  it('leaves an unknown queue depth blank rather than calling it idle', () => {
    expect(cell({ ...HEALTHY, writeQueue: undefined }, 'Write queue')).toMatchObject({ s: '', v: '—' });
  });

  it('surfaces the provider error as the sub-line when a probe failed', () => {
    const c = cell({ ...HEALTHY, providers: { embedding: { ok: false, provider: 'openai', error: '401' } } }, 'Embedding');
    expect(c).toMatchObject({ s: 'err', v: 'openai failing', sub: '401' });
  });

  it('condenses a CLI transcript in the sub-line too, not just the banner', () => {
    // One row of a stat strip cannot carry 700 characters of JSON.
    const c = cell({ ...HEALTHY, providers: { llm: { ok: false, provider: 'claude-cli', error: 'claude CLI exited 1: {"is_error":true,"usage":{}}' } } }, 'LLM');
    expect(c.sub).toBe('claude CLI exited 1');
  });

  it('distinguishes "not configured" from "not probed"', () => {
    expect(cell({ ...HEALTHY, providers: { llm: { ok: false, provider: null, error: 'not configured' } } }, 'LLM').v).toBe('not configured');
    expect(cell({ ...HEALTHY, providers: {} }, 'LLM').v).toBe('not probed');
  });
});

describe('fuzzy', () => {
  it('matches a subsequence, case-insensitively', () => {
    expect(fuzzy('kb', 'Knowledge Base')).toBe(true);
    expect(fuzzy('ACT', 'Activity')).toBe(true);
    expect(fuzzy('dev', 'Devices')).toBe(true);
  });

  it('rejects characters that are out of order or absent', () => {
    expect(fuzzy('bk', 'Knowledge Base')).toBe(false);
    expect(fuzzy('zz', 'Activity')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(fuzzy('', 'Anything')).toBe(true);
  });
});

describe('condenseProviderError', () => {
  it('keeps the prose and drops the JSON payload', () => {
    const real = 'claude CLI exited 1: {"is_error":true,"duration_api_ms":0,'
      + '"num_turns":1,"stop_reason":"stop_sequence","session_id":"84613973-4885",'
      + '"usage":{"input_tokens":0,"cache_creation_input_tokens":0}}';
    expect(condenseProviderError(real)).toBe('claude CLI exited 1');
  });

  it('leaves an ordinary message alone', () => {
    const msg = 'ECONNREFUSED connecting to localhost:11434';
    expect(condenseProviderError(msg)).toBe(msg);
  });

  it('still says something when the error IS the payload', () => {
    // No prose to keep — showing the raw blob beats showing nothing at all.
    expect(condenseProviderError('{"is_error":true}')).toBe('{"is_error":true}');
  });

  it('caps a long single-line message', () => {
    const out = condenseProviderError('x'.repeat(400));
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });

  it('degrades to "unavailable" for empty/missing input', () => {
    expect(condenseProviderError('')).toBe('unavailable');
    expect(condenseProviderError(undefined)).toBe('unavailable');
    expect(condenseProviderError(null)).toBe('unavailable');
  });

  it('trims the trailing separator left behind by the cut', () => {
    expect(condenseProviderError('failed to start: {"a":1}')).toBe('failed to start');
  });
});
