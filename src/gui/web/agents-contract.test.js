import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const web = (name) => readFileSync(join(process.cwd(), 'src', 'gui', 'web', name), 'utf8');

describe('Agents UI contract', () => {
  it('separates shared memory scope, recall readiness, and writer provenance', () => {
    const html = web('index.html');
    const app = web('app.js');

    expect(html).toContain('not a separate memory pod');
    expect(html).toContain('id="agents-recall"');
    expect(html).toContain('Results below are runtime-only');
    expect(app).toContain("rpc('recall.status'");
    expect(app).toContain("['written by', f.agent]");
    expect(app).toContain("['memory scope', f.namespace]");
    expect(app).toContain("if (initial !== 'health') refreshHealth();");
    expect(app).toContain("connector.attentionKind === 'outdated'");
    expect(app).toContain("'refresh needed'");
  });
});
