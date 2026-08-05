import { describe, expect, it } from 'vitest';

import { verifyPromptHookRoundTrip } from './roundtrip.js';

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

describe('prompt-hook round-trip verification', () => {
  it('accepts the marker emitted after a completed daemon search', async () => {
    const payload = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'sigil-hook-verify: daemon search completed',
      },
    });
    await expect(verifyPromptHookRoundTrip(nodeCommand(`process.stdout.write(${JSON.stringify(payload)})`)))
      .resolves.toEqual({ ok: true });
  });

  it('rejects an empty fail-safe response because it cannot prove recall works', async () => {
    await expect(verifyPromptHookRoundTrip(nodeCommand('')))
      .resolves.toEqual({ ok: false, reason: 'hook returned no verified daemon response' });
  });

  it('rejects ordinary hook JSON without the diagnostic marker', async () => {
    const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' } });
    await expect(verifyPromptHookRoundTrip(nodeCommand(`process.stdout.write(${JSON.stringify(payload)})`)))
      .resolves.toEqual({ ok: false, reason: 'hook did not confirm a completed daemon search' });
  });
});
