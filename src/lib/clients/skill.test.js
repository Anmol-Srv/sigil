// The /sigil skill content generator. Asserts the SKILL.md is a well-formed
// Claude Code skill (frontmatter, name, preamble) and that its self-test +
// guidance reference the real CLI surface via the stable shim path.

import { describe, it, expect } from 'vitest';

import { buildSigilSkill } from './skill.js';

const SHIM = '/Users/test/.sigil/bin/sigil';
const md = buildSigilSkill({ sigilCmd: SHIM });

describe('buildSigilSkill', () => {
  it('opens with YAML frontmatter naming the skill `sigil`', () => {
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toMatch(/^name: sigil$/m);
    expect(md).toMatch(/^description: .+/m);
    // allowed-tools must include Bash — the preamble shells out.
    expect(md).toMatch(/allowed-tools:[\s\S]*- Bash/);
  });

  it('carries a version marker for idempotent re-writes', () => {
    expect(md).toMatch(/<!-- sigil-skill:v\d+ -->/);
  });

  it('has a "Preamble (run first)" block that self-tests the connection', () => {
    expect(md).toMatch(/## Preamble \(run first\)/);
    // The three probes: shim presence, daemon ping, deep doctor, status.
    expect(md).toContain('"$SIGIL" ping');
    expect(md).toContain('doctor');
    expect(md).toContain('status');
  });

  it('references the passed shim path, not a bare `sigil`', () => {
    expect(md).toContain(`SIGIL="${SHIM}"`);
    expect(md).toContain(`${SHIM} search`);
    expect(md).toContain(`${SHIM} remember --bg`);
  });

  it('guides the user from each failure state to a fix', () => {
    expect(md).toMatch(/SHIM: MISSING/);
    expect(md).toMatch(/DAEMON: down/);
    expect(md).toMatch(/sigil init/);
    expect(md).toMatch(/DB unreachable|schema missing/);
  });

  it('includes the usage reflexes (auto recall + explicit save)', () => {
    expect(md).toMatch(/Recall is automatic/);
    expect(md).toMatch(/Saving is automatic/);
  });
});
