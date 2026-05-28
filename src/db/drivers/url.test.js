import { describe, it, expect } from 'vitest';

import { buildUrlConnection, classifyProvider } from './url.js';

describe('url driver', () => {
  it('parses basic postgres:// URL', () => {
    const c = buildUrlConnection('postgres://user:pass@host.example.com:5432/db');
    expect(c.host).toBe('host.example.com');
    expect(c.port).toBe(5432);
    expect(c.database).toBe('db');
    expect(c.user).toBe('user');
    expect(c.password).toBe('pass');
  });

  it('decodes URI-encoded passwords (special chars)', () => {
    const c = buildUrlConnection('postgres://u:p%40ss%3Aword@h.example.com/db');
    expect(c.password).toBe('p@ss:word');
  });

  it('defaults port to 5432 when omitted', () => {
    const c = buildUrlConnection('postgresql://u:p@h.example.com/db');
    expect(c.port).toBe(5432);
  });

  it('accepts both postgres:// and postgresql:// schemes', () => {
    expect(buildUrlConnection('postgres://u:p@h.example.com/db').host).toBe('h.example.com');
    expect(buildUrlConnection('postgresql://u:p@h.example.com/db').host).toBe('h.example.com');
  });

  it('rejects non-postgres schemes', () => {
    expect(() => buildUrlConnection('mysql://u:p@h.example.com/db')).toThrow(/scheme/);
  });

  it('does not enable SSL for localhost', () => {
    expect(buildUrlConnection('postgres://u:p@localhost:5432/db').ssl).toBeUndefined();
    expect(buildUrlConnection('postgres://u:p@127.0.0.1/db').ssl).toBeUndefined();
  });

  it('enables strict SSL for Neon URLs', () => {
    const c = buildUrlConnection('postgres://u:p@ep-foo-123.us-east-2.aws.neon.tech/db');
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('enables strict SSL for Supabase pooler URLs', () => {
    const c = buildUrlConnection('postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/db');
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('enables strict SSL for AWS RDS URLs', () => {
    const c = buildUrlConnection('postgres://u:p@my-instance.abc123.us-east-1.rds.amazonaws.com/db');
    expect(c.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('explicit sslmode=disable wins over heuristics', () => {
    const c = buildUrlConnection('postgres://u:p@host.neon.tech/db?sslmode=disable');
    expect(c.ssl).toBe(false);
  });

  it('explicit sslmode=no-verify produces relaxed SSL', () => {
    const c = buildUrlConnection('postgres://u:p@host.example.com/db?sslmode=no-verify');
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('unknown remote host defaults to permissive SSL', () => {
    const c = buildUrlConnection('postgres://u:p@unknown-host.example.com/db');
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('sets application_name=sigil by default', () => {
    const c = buildUrlConnection('postgres://u:p@h.example.com/db');
    expect(c.application_name).toBe('sigil');
  });

  it('rejects empty input', () => {
    expect(() => buildUrlConnection('')).toThrow(/empty/);
  });

  it('rejects malformed URLs', () => {
    expect(() => buildUrlConnection('not a url')).toThrow(/invalid URL/);
  });
});

describe('classifyProvider', () => {
  it('identifies common providers', () => {
    expect(classifyProvider('postgres://u:p@ep-x.neon.tech/db')).toBe('neon');
    expect(classifyProvider('postgres://u:p@x.supabase.co/db')).toBe('supabase');
    expect(classifyProvider('postgres://u:p@x.pooler.supabase.com/db')).toBe('supabase-pooler');
    expect(classifyProvider('postgres://u:p@x.rds.amazonaws.com/db')).toBe('aws-rds');
    expect(classifyProvider('postgres://u:p@x.render.com/db')).toBe('render');
    expect(classifyProvider('postgres://u:p@x.railway.app/db')).toBe('railway');
    expect(classifyProvider('postgres://u:p@localhost/db')).toBe('local');
    expect(classifyProvider('postgres://u:p@some-host.example.com/db')).toBe('unknown');
  });
});
