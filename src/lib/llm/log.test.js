// Tests for the llm_log routing decision (B6.8 / field-report Defect 6 follow-up):
// in embedded mode a CLI/hook process can't open the single-process engine, so
// its llm_log write must route through the daemon instead of failing.

import { describe, it, expect } from 'vitest';

import { shouldRouteLlmLog } from './log.js';

describe('shouldRouteLlmLog', () => {
  it('routes through the daemon for embedded + non-daemon (CLI/hook)', () => {
    expect(shouldRouteLlmLog('embedded', false)).toBe(true);
  });

  it('writes direct when this IS the daemon (it owns the engine)', () => {
    expect(shouldRouteLlmLog('embedded', true)).toBe(false);
  });

  it('writes direct for server Postgres (multi-connection — any process can)', () => {
    expect(shouldRouteLlmLog('local', false)).toBe(false);
    expect(shouldRouteLlmLog('url', false)).toBe(false);
    expect(shouldRouteLlmLog('docker', true)).toBe(false);
  });

  it('writes direct when the mode is unknown (fail open, never route blindly)', () => {
    expect(shouldRouteLlmLog(undefined, false)).toBe(false);
    expect(shouldRouteLlmLog(null, false)).toBe(false);
  });
});
