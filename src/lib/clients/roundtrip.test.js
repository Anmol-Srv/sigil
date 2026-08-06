// `sigil doctor --deep` is the only check that proves a registered hook can
// actually RUN. It used to split the command on spaces and spawn it directly,
// but mergeHooks writes the shim path single-quoted — so it looked for a file
// literally named "'/…/sigil-hook'" and reported ENOENT on every healthy
// install. Running through a shell (as the harness does) is the fix.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyClaudeHookRoundTrip } from './roundtrip.js';

let dir;
let hook;

beforeAll(() => {
  // A directory with a space in it — the reason the path is quoted at all.
  dir = join(mkdtempSync(join(tmpdir(), 'sigil-rt-')), 'my dir');
  hook = join(dir, 'sigil-hook');
  mkdirSync(dir, { recursive: true });
  writeFileSync(hook, '#!/bin/sh\ncat >/dev/null\nprintf \'{"hookSpecificOutput":{}}\'\n');
  chmodSync(hook, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('verifyClaudeHookRoundTrip', () => {
  it('runs the quoted shim command exactly as registered', async () => {
    expect(await verifyClaudeHookRoundTrip(`'${hook}' user-prompt-submit`)).toEqual({ ok: true });
  });

  it('still reports a genuinely broken hook', async () => {
    const r = await verifyClaudeHookRoundTrip(`'${hook}-does-not-exist' user-prompt-submit`);
    expect(r.ok).toBe(false);
  });
});
