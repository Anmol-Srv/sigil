// Regression test for the P0 data-loss bug: a malformed ~/.claude/settings.json
// must NEVER be wiped.
//
// Before the fix, mergeHooks() caught JSON.parse errors and started fresh ({}),
// then wrote a file containing ONLY sigil's hooks — silently destroying every
// other hook/setting the user had (gstack hooks, permissions, statusline, ...).
// This locks the safe behavior (matching cursor.js / codex-cli.js): refuse to
// touch a file we can't parse, and report it.
//
// $HOME is sandboxed BEFORE importing claude-code.js so its module-level path
// constants resolve into the temp dir, never the real ~/.claude.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let SANDBOX;
let SETTINGS;
let claudeCode;

// Invalid strict JSON (a trailing comment + trailing comma) carrying settings a
// real user would have. If the bug regresses, these get wiped.
const MALFORMED = `{
  "permissions": { "allow": ["Bash", "Edit"] },
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "my-own-hook" }] }]
  },
  // a comment makes this invalid strict JSON
}
`;

beforeAll(async () => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'sigil-malformed-test-'));
  process.env.HOME = SANDBOX; // os.homedir() reads this on POSIX
  mkdirSync(join(SANDBOX, '.claude'), { recursive: true });
  SETTINGS = join(SANDBOX, '.claude', 'settings.json');
  writeFileSync(SETTINGS, MALFORMED, 'utf8');
  claudeCode = await import('./claude-code.js');
});

afterAll(() => {
  if (SANDBOX) rmSync(SANDBOX, { recursive: true, force: true });
});

describe('claude-code install: a malformed settings.json is never wiped', () => {
  it('leaves the file byte-identical and reports a skip', async () => {
    const { actions } = await claudeCode.install({});

    // The user's (malformed) file is untouched — no data loss.
    expect(readFileSync(SETTINGS, 'utf8')).toBe(MALFORMED);

    // ...and the install plan explains why it was skipped.
    const settingsAction = actions.find((a) => a.path === SETTINGS);
    expect(settingsAction).toBeTruthy();
    expect(settingsAction.action).toBe('skip');
    expect(settingsAction.detail).toMatch(/invalid JSON/i);
  });
});
