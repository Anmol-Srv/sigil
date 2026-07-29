import { describe, expect, it } from 'vitest';

import { resolveMemoryScope } from './memory-scope.js';

const projectNamespace = 'project:1234567890abcdef12345678';

describe('memory scope resolution', () => {
  it('uses shared memory by default', () => {
    expect(resolveMemoryScope()).toEqual({
      mode: 'shared',
      writeNamespace: 'default',
      namespaces: ['default'],
      namespaceTiers: [['default']],
    });
  });

  it('writes into the caller project and retrieves project-first with shared fallback', () => {
    expect(resolveMemoryScope({}, { scope: { projectNamespace } })).toEqual({
      mode: 'project',
      writeNamespace: projectNamespace,
      namespaces: [projectNamespace, 'default'],
      namespaceTiers: [[projectNamespace], ['default']],
    });
  });

  it('treats an explicit namespace as an intentional override', () => {
    expect(resolveMemoryScope({ namespace: 'team-notes' }, { scope: { projectNamespace } })).toEqual({
      mode: 'explicit',
      writeNamespace: 'team-notes',
      namespaces: ['team-notes'],
      namespaceTiers: [['team-notes']],
    });
  });
});
