/**
 * In-process pub/sub for daemon events. Used by the WebSocket fan-out
 * to push live activity to the GUI.
 *
 * Event shape:  { type, ts, ...data }
 * Types so far: write.fact, write.document, read.search, error
 *
 * Subscribers register a callback. Returns an unsubscribe function.
 * Buffer keeps the last N events so a fresh GUI tab can replay recent
 * history without a server-side query.
 */

const BUFFER_SIZE = 200;

class EventBus {
  constructor() {
    this.buffer = [];
    this.subs = new Set();
  }

  emit(type, data = {}) {
    const evt = { type, ts: new Date().toISOString(), ...data };
    this.buffer.push(evt);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    for (const fn of this.subs) {
      try { fn(evt); } catch { /* never let a subscriber take down the daemon */ }
    }
    return evt;
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** Snapshot of recent events for a new subscriber. */
  recent(limit = 50) {
    if (limit >= this.buffer.length) return [...this.buffer];
    return this.buffer.slice(-limit);
  }

  subscriberCount() {
    return this.subs.size;
  }
}

const bus = new EventBus();
export default bus;
export { EventBus };
