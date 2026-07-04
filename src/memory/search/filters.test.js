import { describe, it, expect } from 'vitest';

import { buildFactFilters, normalizeDeviceId } from './filters.js';

describe('buildFactFilters — author provenance predicates', () => {
  it('no author args ⟹ no authorClause, params = [minRank] (back-compat)', () => {
    const { authorClause, filterParams } = buildFactFilters({ minConfidence: 'medium' });
    expect(authorClause).toBe('');
    expect(filterParams).toEqual([1]); // medium → rank 1
  });

  it('--agent adds a created_by_agent predicate + param', () => {
    const { authorClause, filterParams } = buildFactFilters({ agent: 'cursor' });
    expect(authorClause).toContain('created_by_agent = ?');
    expect(filterParams).toEqual([1, 'cursor']);
  });

  it('--device (numeric) adds a created_by_device_id predicate + param', () => {
    const { authorClause, filterParams } = buildFactFilters({ deviceId: 3 });
    expect(authorClause).toContain('created_by_device_id = ?');
    expect(filterParams).toEqual([1, 3]);
  });

  it('numeric-string device id is coerced to an integer param', () => {
    const { filterParams } = buildFactFilters({ deviceId: '3' });
    expect(filterParams).toEqual([1, 3]);
  });

  it('agent + device both apply, in clause order (after temporal/category)', () => {
    const { authorClause, filterParams } = buildFactFilters({
      categories: ['preference'],
      agent: 'cli',
      deviceId: 2,
    });
    // categories param comes first (built before author), then agent, then device.
    expect(filterParams).toEqual([1, ['preference'], 'cli', 2]);
    expect(authorClause.indexOf('created_by_agent')).toBeLessThan(authorClause.indexOf('created_by_device_id'));
  });

  it('non-numeric device value (an unresolved name) is ignored at this layer', () => {
    // Names must be resolved to ids by the caller; a bare name yields no predicate.
    const { authorClause, filterParams } = buildFactFilters({ deviceId: 'laptop-b' });
    expect(authorClause).toBe('');
    expect(filterParams).toEqual([1]);
  });
});

describe('normalizeDeviceId', () => {
  it('passes integers through', () => {
    expect(normalizeDeviceId(5)).toBe(5);
  });
  it('coerces numeric strings', () => {
    expect(normalizeDeviceId('5')).toBe(5);
  });
  it('returns null for null/undefined/non-numeric', () => {
    expect(normalizeDeviceId(null)).toBeNull();
    expect(normalizeDeviceId(undefined)).toBeNull();
    expect(normalizeDeviceId('laptop')).toBeNull();
  });
});
