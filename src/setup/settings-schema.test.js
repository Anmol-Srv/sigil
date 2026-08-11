/**
 * The settings surface, checked for the two things that would hurt silently:
 * a value that should never be editable becoming editable, and a path in the
 * schema that no longer exists in the config it claims to describe.
 */
import { describe, it, expect } from 'vitest';
import {
  SETTINGS_SECTIONS, SETTINGS_BY_PATH, coerce, readPath,
} from './settings-schema.js';

describe('the editable surface', () => {
  it('never exposes a secret', () => {
    // A generic text box that writes an unverified key is worse than no box —
    // credentials go through the provider flow, which live-tests them.
    const secretish = /apiKey|password|secretKey|accessKey|token$/i;
    const leaked = [...SETTINGS_BY_PATH.keys()].filter((p) => secretish.test(p));
    expect(leaked).toEqual([]);
  });

  it('never exposes identity the user cannot meaningfully choose', () => {
    const internal = ['device.id', 'schemaVersion', 'setup.complete', 'setup.steps', 'network.masterNodeId'];
    for (const p of internal) expect(SETTINGS_BY_PATH.has(p)).toBe(false);
  });

  it('describes only paths that exist in the real default config', async () => {
    // Guards the drift this schema exists to prevent: a renamed config key
    // would otherwise leave a control that reads blank and writes nowhere.
    const { getConfig } = await import('./config-store.js');
    const cfg = getConfig();
    const missing = [...SETTINGS_BY_PATH.keys()].filter((p) => readPath(cfg, p) === undefined);
    expect(missing).toEqual([]);
  });

  it('gives every setting a label and a unique path', () => {
    const paths = SETTINGS_SECTIONS.flatMap((s) => s.settings.map((d) => d.path));
    expect(new Set(paths).size).toBe(paths.length);
    for (const [, d] of SETTINGS_BY_PATH) expect(d.label).toBeTruthy();
  });
});

describe('coerce', () => {
  const num = SETTINGS_BY_PATH.get('memory.skipThreshold');
  const bool = SETTINGS_BY_PATH.get('ingest.extractRelations');
  const list = SETTINGS_BY_PATH.get('output.storage');

  it('holds numeric bounds', () => {
    expect(coerce(num, 0.9)).toEqual({ ok: true, value: 0.9 });
    expect(coerce(num, 1.5).ok).toBe(false);
    expect(coerce(num, -1).ok).toBe(false);
    expect(coerce(num, 'abc').ok).toBe(false);
  });

  it('accepts a numeric string from a form field', () => {
    expect(coerce(num, '0.75')).toEqual({ ok: true, value: 0.75 });
  });

  it('treats an unchecked box as false rather than missing', () => {
    expect(coerce(bool, undefined)).toEqual({ ok: true, value: false });
    expect(coerce(bool, 'on')).toEqual({ ok: true, value: true });
  });

  it('restricts an enum to its options', () => {
    expect(coerce(list, 's3')).toEqual({ ok: true, value: 's3' });
    expect(coerce(list, 'ftp').ok).toBe(false);
  });

  it('rejects a path that is not in the schema at all', () => {
    expect(coerce(SETTINGS_BY_PATH.get('llm.apiKey'), 'sk-leak'))
      .toEqual({ ok: false, error: 'unknown setting' });
  });
});
