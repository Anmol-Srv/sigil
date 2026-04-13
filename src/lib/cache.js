/**
 * Simple TTL cache backed by a Map.
 * Evicts oldest entry when maxSize is reached; entries expire after ttlMs.
 */
class TtlCache {
  #map = new Map();
  #maxSize;
  #ttlMs;

  constructor({ maxSize = 100, ttlMs = 5 * 60 * 1000 } = {}) {
    this.#maxSize = maxSize;
    this.#ttlMs = ttlMs;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.#ttlMs) {
      this.#map.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key, value) {
    if (this.#map.size >= this.#maxSize) {
      const oldestKey = this.#map.keys().next().value;
      this.#map.delete(oldestKey);
    }
    this.#map.set(key, { value, timestamp: Date.now() });
  }
}

export { TtlCache };
