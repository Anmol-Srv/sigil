import { afterEach, describe, expect, it } from 'vitest';

import { __resetTestConfig, __setTestConfig } from './config-store.js';

afterEach(() => {
  __resetTestConfig();
});

describe('safe local-first defaults', () => {
  it('keeps generation-heavy enrichment and coding-agent fan-out disabled', () => {
    const config = __setTestConfig();

    expect(config.llm.maxRetries).toBe(1);
    expect(config.llm.maxClaudeProcs).toBe(1);
    expect(config.http.enabled).toBe(false);
    expect(config.ingest.eagerExtract).toBe(false);
    expect(config.identity).toBeUndefined();
  });
});
