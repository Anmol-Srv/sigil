// managed-session provider — routes to the warm SessionManager when one is
// registered, mapping its result into the standard provider chat() shape. The
// no-manager fallthrough to one-shot claude-cli is exercised by the manager's
// own fallback tests + the E2E; here we cover the routing + mapping.

import { describe, it, expect, afterEach, beforeAll } from 'vitest';

import { chat } from './managed-session.js';
import { setSessionManager } from '../session/index.js';
import { __setTestConfig } from '../../../setup/config-store.js';

// Short-circuit one-shot binary resolution so the fallthrough path fails fast
// (spawns /usr/bin/false, exits 1) instead of probing the login shell for claude.
// config.json is the source of truth — seed cliPath via the seam, not env.
beforeAll(() => { __setTestConfig({ llm: { cliPath: '/usr/bin/false' } }); });
afterEach(() => setSessionManager(null));

describe('managed-session provider', () => {
  it('routes to manager.submit and maps the result to the chat() contract', async () => {
    const calls = [];
    setSessionManager({
      hasWorkers: (t) => t === 'claude',
      submit: async (task) => { calls.push(task); return { text: '{"facts":[]}', inputTokens: 12, outputTokens: 3, model: 'haiku', cost: 0, workerId: 'claude-0', reqId: 'req-1', viaFallback: false }; },
    });

    const r = await chat('extract from "hi"', { model: 'haiku', schema: { type: 'object' }, caller: 'extractor' });

    // caller is forwarded so the warm path can be attributed in llm_log + traces.
    expect(calls[0]).toMatchObject({ sourceType: 'claude', prompt: 'extract from "hi"', model: 'haiku', caller: 'extractor' });
    // Correlation fields (workerId/reqId/viaFallback) flow back through to logCall.
    expect(r).toEqual({ text: '{"facts":[]}', inputTokens: 12, outputTokens: 3, model: 'haiku', cost: 0, workerId: 'claude-0', reqId: 'req-1', viaFallback: false });
  });

  it('gates on hasWorkers: a manager with no workers is not submitted to', async () => {
    // hasWorkers() is the guard before the dynamic one-shot import. A throwing
    // submit proves the provider never calls it when there are no workers — it
    // takes the fallthrough path instead (one-shot, integration-covered).
    let submitted = false;
    setSessionManager({
      hasWorkers: () => false,
      submit: async () => { submitted = true; throw new Error('must not be called'); },
    });
    // The fallthrough calls claude-cli (would spawn) — we only assert the guard
    // by stubbing it out: replace the manager mid-call is unnecessary because the
    // guard is synchronous. Run far enough to hit the guard, then bail.
    await chat('x', {}).catch(() => {}); // one-shot may fail (no claude in CI) — fine
    expect(submitted).toBe(false);
  });
});
