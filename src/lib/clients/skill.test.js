// The portable /sigil skill generator. Asserts the shared skill has standard
// frontmatter plus a bounded preamble and usable MCP/CLI workflow.

import { describe, it, expect } from 'vitest';

import { buildSigilSkill } from './skill.js';

const SHIM = '/Users/test/.sigil/bin/sigil';
const md = buildSigilSkill({ sigilCmd: SHIM });

describe('buildSigilSkill', () => {
  it('opens with portable YAML frontmatter naming the skill `sigil`', () => {
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toMatch(/^name: sigil$/m);
    expect(md).toMatch(/^description: .+/m);
    // Keep the shared source transport-neutral; individual runtimes decide
    // whether to use their MCP tool surface or the CLI fallback.
    expect(md).not.toContain('allowed-tools:');
  });

  it('carries a version marker for idempotent re-writes', () => {
    expect(md).toMatch(/<!-- sigil-skill:v\d+ -->/);
  });

  it('has a bounded, read-only "Preamble (run first)" block', () => {
    expect(md).toMatch(/## Preamble \(run first\)/);
    expect(md).toContain('MCP `status` tool');
    expect(md).toContain('status');
    expect(md).toContain('Do not run `doctor`, an LLM, ingestion, or a write');
    expect(md).toMatch(/optional LLM\/generation provider\*\* never proves that Sigil is\s+down/);
  });

  it('references the passed shim path, not a bare `sigil`', () => {
    expect(md).toContain(`SIGIL="${SHIM}"`);
    expect(md).toContain(`"${SHIM}" search`);
    expect(md).toContain(`"${SHIM}" remember`);
  });

  it('guides the user from each state to a safe next action', () => {
    expect(md).toMatch(/READY/);
    expect(md).toMatch(/EMPTY/);
    expect(md).toMatch(/UNAVAILABLE/);
    expect(md).toMatch(/sigil init/);
    expect(md).toMatch(/Database or embedding provider failure/);
  });

  it('includes the usage reflexes (injected recall, targeted search, explicit save)', () => {
    expect(md).toMatch(/injected memory first/);
    expect(md).toMatch(/Never repeat its exact search/);
    expect(md).toMatch(/Save a fact.*only when the user explicitly asks/s);
    expect(md).toMatch(/Never infer durable memory from routine chat/);
  });
});
