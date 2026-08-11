// The inference heuristic decides, without an LLM, whether a fact is addressed
// to one assistant or true of the user's world. Getting it wrong in the
// hiding direction is the expensive mistake: the fact stays in the store,
// searchable by nobody, with no signal that anything is missing. So the bias
// these pin is heavily toward 'shared', and the narrow 'agent' class has to
// earn it.

import { describe, it, expect } from 'vitest';

import {
  inferVisibility,
  normalizeVisibility,
  VISIBILITIES,
  DEFAULT_VISIBILITY,
} from './visibility.js';
import { buildVisibilityFilter } from './search/filters.js';

describe('normalizeVisibility', () => {
  it('accepts the three legal values', () => {
    for (const v of VISIBILITIES) expect(normalizeVisibility(v)).toBe(v);
  });

  it('fails OPEN on anything else — a bad label must not hide a fact', () => {
    // Under-retrieval is silent; over-sharing a style note is visible and
    // correctable. The asymmetry decides the direction.
    for (const bad of ['private', 'PUBLIC', '', null, undefined, 0, {}, 'agentt']) {
      expect(normalizeVisibility(bad)).toBe('shared');
    }
    expect(DEFAULT_VISIBILITY).toBe('shared');
  });
});

describe('inferVisibility — the assistant-directed class', () => {
  it('catches the reported case', () => {
    expect(inferVisibility('User wants to be called sir', { category: 'preference' })).toBe('agent');
    expect(inferVisibility('Call me sir', { category: 'preference' })).toBe('agent');
    expect(inferVisibility('Please call the user sir', { category: 'preference' })).toBe('agent');
  });

  it('catches instructions about how the assistant should speak', () => {
    expect(inferVisibility('You should always respond in bullet points', { category: 'preference' })).toBe('agent');
    expect(inferVisibility('Your tone should be terse', { category: 'preference' })).toBe('agent');
    expect(inferVisibility('Address me as Dr. Srivastava', { category: 'preference' })).toBe('agent');
  });
});

describe('inferVisibility — everything else stays shared', () => {
  it('keeps ordinary preferences shared, even though they are preferences', () => {
    // This is the line that matters. "Prefers tabs" is about the user's code
    // and every agent should honour it; "call me sir" is about one agent's
    // manner of address. Both are category=preference.
    expect(inferVisibility('User prefers tabs over spaces', { category: 'preference' })).toBe('shared');
    expect(inferVisibility('User prefers Fastify over Express', { category: 'preference' })).toBe('shared');
    expect(inferVisibility('Anmol likes dark mode', { category: 'preference' })).toBe('shared');
  });

  it('never narrows a fact about the work, whatever its phrasing', () => {
    // Second-person phrasing inside an engineering note must not silo it.
    expect(inferVisibility('You should call the search API before rendering', { category: 'architecture' })).toBe('shared');
    expect(inferVisibility('Call the webhook with a retry', { category: 'decision' })).toBe('shared');
    expect(inferVisibility('The GUI has a bug in the namespace filter', { category: 'issue' })).toBe('shared');
  });

  it('needs BOTH address and behaviour — one alone is not enough', () => {
    expect(inferVisibility('You are working on the sigil repo', { category: 'preference' })).toBe('shared');
    expect(inferVisibility('Always use tabs', { category: 'convention' })).toBe('shared');
  });

  it('is safe on degenerate input', () => {
    for (const empty of ['', '   ', null, undefined]) {
      expect(inferVisibility(empty, { category: 'preference' })).toBe('shared');
    }
    expect(inferVisibility('call me sir')).toBe('agent'); // no category supplied
  });

  it('never infers device scope — machine-local is a deliberate act', () => {
    const samples = [
      'The dev server runs on port 3000',
      'Checkout lives at /Users/anmol/sigil',
      'You should call me sir',
    ];
    for (const s of samples) expect(inferVisibility(s)).not.toBe('device');
  });
});

describe('buildVisibilityFilter — the read side', () => {
  it('emits nothing for a null viewer, so a human sees their whole store', () => {
    expect(buildVisibilityFilter(null)).toEqual({ clause: '', params: [] });
    expect(buildVisibilityFilter(undefined)).toEqual({ clause: '', params: [] });
  });

  it('binds agent and device in that order', () => {
    const { clause, params } = buildVisibilityFilter({ agent: 'claude-code', deviceId: 7 });
    expect(params).toEqual(['claude-code', 7]);
    expect(clause).toContain("visibility = 'shared'");
    expect(clause.indexOf('created_by_agent')).toBeLessThan(clause.indexOf('created_by_device_id'));
  });

  it('uses IS NOT DISTINCT FROM, not =, so NULL provenance still matches', () => {
    // `created_by_agent = NULL` is NULL, never true. With `=`, a fact written
    // before provenance stamping existed would be invisible to everyone
    // forever — including whoever wrote it.
    const { clause } = buildVisibilityFilter({ agent: null, deviceId: null });
    expect(clause).toContain('IS NOT DISTINCT FROM');
    expect(clause).not.toMatch(/created_by_agent\s*=\s*\?/);
  });

  it('always lets shared facts through regardless of viewer', () => {
    const { clause } = buildVisibilityFilter({ agent: 'codex', deviceId: 1 });
    expect(clause.startsWith("AND (visibility = 'shared'")).toBe(true);
  });
});
