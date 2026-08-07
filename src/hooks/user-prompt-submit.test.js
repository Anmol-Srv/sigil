// The read hook embeds the prompt as ONE vector, so pasted material drowns the
// question. Measured against a live store: 400 chars of unrelated log noise
// collapsed the on-topic/off-topic cosine gap from 0.214 to 0.018, and 4000
// chars took it to 0.000 — the relevance floor then (correctly) dropped
// everything and recall silently returned nothing. distillQuery is what keeps
// the query discriminative; these pin its contract.

import { describe, it, expect } from 'vitest';

import { distillQuery } from './user-prompt-submit.js';

const QUESTION = 'what did we decide about the sync strategy?';

describe('distillQuery', () => {
  it('passes a normal prompt through untouched', () => {
    expect(distillQuery(QUESTION)).toBe(QUESTION);
  });

  it('leaves a long ALL-PROSE prompt intact (nothing to strip)', () => {
    const prose = `${'We should think about how the system behaves under load. '.repeat(20)}${QUESTION}`;
    expect(distillQuery(prose)).toContain(QUESTION);
    expect(distillQuery(prose)).toContain('behaves under load');
  });

  it('strips a pasted stack trace but keeps the trailing question', () => {
    const pasted = `${'    at Object.<anonymous> (/app/src/index.js:42:15)\n'.repeat(60)}\n${QUESTION}`;
    const out = distillQuery(pasted);
    expect(out).toContain(QUESTION);
    expect(out).not.toContain('at Object');
  });

  it('strips fenced code but keeps the question that leads it', () => {
    const fenced = `${QUESTION}\n\`\`\`js\n${'const x = foo(bar, baz);\n'.repeat(80)}\`\`\``;
    const out = distillQuery(fenced);
    expect(out).toContain(QUESTION);
    expect(out).not.toContain('const x');
  });

  it('strips log lines', () => {
    const logs = `${'ERROR failed to connect to upstream after 3 retries\n'.repeat(40)}${QUESTION}`;
    expect(distillQuery(logs)).toContain(QUESTION);
    expect(distillQuery(logs)).not.toContain('ERROR failed');
  });

  it('falls back to the tail when distillation strips everything', () => {
    // All pasted, no prose — we must still send SOMETHING rather than an empty
    // query the daemon would reject.
    const allCode = `${'    const x = y[0] + z(1);\n'.repeat(200)}    return TAIL_MARKER;\n`;
    const out = distillQuery(allCode);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('TAIL_MARKER');
  });

  it('bounds an oversized prompt, keeping both ends', () => {
    const huge = `HEAD_MARKER ${'sentences of ordinary prose here. '.repeat(3000)} TAIL_MARKER`;
    const out = distillQuery(huge);
    expect(out.length).toBeLessThanOrEqual(4010);
    expect(out).toContain('HEAD_MARKER');
    expect(out).toContain('TAIL_MARKER');
  });
});
