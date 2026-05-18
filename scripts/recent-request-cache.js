/**
 * Quartermaster — Recent Request Cache (LRU)
 *
 * In-memory bounded cache mapping requestId -> cached operation result.
 * Used by the Operation Coordinator at socket ingress for fast idempotency
 * checks before falling back to the durable transaction log lookup.
 *
 * Access (get / has-and-fetch) bumps an entry to the most-recent position.
 * When the cache exceeds maxSize, the least-recently-used entry is evicted.
 *
 * Implementation note: relies on JavaScript Map's insertion-order iteration
 * for LRU semantics. `set()` after `delete()` re-inserts to the back,
 * which is O(1) on modern engines.
 */

export class RecentRequestCache {
  constructor({ maxSize = 5000 } = {}) {
    this.maxSize = Math.max(1, maxSize);
    this.store = new Map();
  }

  /**
   * Cheap presence check. Does NOT bump LRU position.
   */
  has(requestId) {
    return this.store.has(requestId);
  }

  /**
   * Retrieve a cached result and bump it to MRU position.
   * Returns undefined if not present.
   */
  get(requestId) {
    if (!this.store.has(requestId)) return undefined;
    const value = this.store.get(requestId);
    this.store.delete(requestId);
    this.store.set(requestId, value);
    return value;
  }

  /**
   * Store a result. Evicts the oldest entry if the cache is full.
   */
  set(requestId, result) {
    if (this.store.has(requestId)) {
      this.store.delete(requestId);
    } else if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(requestId, result);
  }

  delete(requestId) {
    return this.store.delete(requestId);
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }
}
