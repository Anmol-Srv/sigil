// PGlite is one connection. Before this queue, two writes arriving close
// together fought over it: the second got "Knex: Timeout acquiring a
// connection. The pool is probably full" after a 30s stall, and every
// unrelated subsystem (checkpoint, trace persist, pod resolution) failed for
// the duration. These pin the ordering guarantee that replaces that.

import { describe, it, expect } from 'vitest';

import { withWriteLock, writeQueueDepth } from './write-queue.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('withWriteLock', () => {
  it('never runs two writers at once', async () => {
    let active = 0;
    let maxActive = 0;
    const writer = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => withWriteLock(writer)));
    expect(maxActive).toBe(1);
  });

  it('preserves submission order', async () => {
    const order = [];
    await Promise.all([1, 2, 3, 4].map((n) => withWriteLock(async () => {
      // Longer work first — order must come from the queue, not from duration.
      await tick(n === 1 ? 20 : 1);
      order.push(n);
    })));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('returns the writer\'s value and propagates its error', async () => {
    await expect(withWriteLock(async () => 'ok')).resolves.toBe('ok');
    await expect(withWriteLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('a failed writer does not stall the queue behind it', async () => {
    // The failure mode this guards: chaining on a rejected promise would reject
    // every subsequent write, turning one bad save into a dead daemon.
    const failed = withWriteLock(async () => { throw new Error('boom'); });
    await expect(failed).rejects.toThrow('boom');
    await expect(withWriteLock(async () => 'still works')).resolves.toBe('still works');
  });

  it('reports depth while writers are queued, and drains to zero', async () => {
    expect(writeQueueDepth()).toBe(0);
    const running = [
      withWriteLock(() => tick(15)),
      withWriteLock(() => tick(15)),
      withWriteLock(() => tick(15)),
    ];
    expect(writeQueueDepth()).toBe(3);
    await Promise.all(running);
    expect(writeQueueDepth()).toBe(0);
  });
});
