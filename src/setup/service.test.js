import { describe, expect, it } from 'vitest';

import { deriveSetupState, listSteps } from './service.js';

function configWith(steps) {
  return { setup: { steps } };
}

describe('setup completion semantics', () => {
  it('requires only storage and semantic search for a working local memory core', () => {
    expect(listSteps().map(({ id, required }) => [id, required])).toEqual([
      ['database', true],
      ['embedding', true],
      ['connectors', false],
      ['llm', false],
    ]);
  });

  it('is complete without a connected agent or LLM when the core steps are done', () => {
    const state = deriveSetupState(configWith({
      database: 'done',
      embedding: 'done',
    }));

    expect(state.complete).toBe(true);
    expect(state.currentStep).toBeNull();
    expect(state.steps.find((step) => step.id === 'connectors')?.status).toBe('pending');
    expect(state.steps.find((step) => step.id === 'llm')?.status).toBe('pending');
  });

  it('advances through required steps and ignores optional step errors', () => {
    const state = deriveSetupState(configWith({
      database: 'done',
      llm: 'error',
    }));

    expect(state.complete).toBe(false);
    expect(state.currentStep).toBe('embedding');
  });
});
