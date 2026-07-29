import { describe, expect, it } from 'vitest';

import { buildSharedInstructions } from './instructions.js';

describe('agent instructions provider boundary', () => {
  it('does not let an optional generation-provider warning block Codex memory', () => {
    const instructions = buildSharedInstructions({ transport: 'mcp', automaticRecall: true });
    expect(instructions).toContain('optional LLM/generation provider');
    expect(instructions).toContain('does not block `search`,\n`remember`, or `correct`');
    expect(instructions).toContain('only a database or embedding failure can block normal recall/writes');
  });

  it('gives hook-based clients the same provider boundary', () => {
    const instructions = buildSharedInstructions({ sigilCmd: '/stable/sigil' });
    expect(instructions).toContain('Never call the daemon unresponsive merely because an optional provider is down');
  });
});
