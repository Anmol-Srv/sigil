import { afterEach, describe, expect, it } from 'vitest';

import { __resetTestConfig, __setTestConfig } from '../setup/config-store.js';
import { validateConfig } from './config-validator.js';

afterEach(() => __resetTestConfig());

function setCoreConfig(extra = {}) {
  __setTestConfig({
    database: { mode: 'embedded' },
    embedding: { provider: 'ollama', model: 'mxbai-embed-large' },
    llm: { provider: null },
    ...extra,
  });
}

describe('optional LLM validation', () => {
  it('accepts a working local memory core without an LLM', () => {
    setCoreConfig();

    expect(validateConfig().filter((issue) => issue.level === 'fail')).toEqual([]);
  });

  it('fails only when an enabled generation feature has no LLM', () => {
    setCoreConfig({ ingest: { eagerExtract: true } });

    expect(validateConfig()).toContainEqual(expect.objectContaining({
      level: 'fail',
      code: 'LLM_REQUIRED_FOR_ENABLED_FEATURE',
    }));
  });
});
