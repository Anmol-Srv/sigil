import { describe, expect, it } from 'vitest';

import { buildCodexArgs } from './codex.js';

describe('Codex one-shot isolation', () => {
  it('skips user MCP/rules, stays ephemeral, and passes a response schema', () => {
    const args = buildCodexArgs({
      input: 'return json',
      model: 'gpt-5-mini',
      outPath: '/tmp/out.txt',
      schemaPath: '/tmp/schema.json',
    });

    expect(args).toEqual(expect.arrayContaining([
      '--ignore-user-config', '--ignore-rules', '--ephemeral',
      '--output-schema', '/tmp/schema.json',
      '--output-last-message', '/tmp/out.txt',
      '-m', 'gpt-5-mini',
    ]));
    expect(args.at(-1)).toBe('return json');
  });
});
