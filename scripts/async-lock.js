/**
 * Quartermaster — Async Lock
 *
 * Per-key promise queue for serializing async operations that touch the same
 * resource. Operations naming the same key serialize FIFO; operations on
 * different keys parallelize.
 *
 * Used by the Operation Coordinator to ensure concurrent socket requests
 * mutating the same item/currency/resource don't interleave their reads and
 * writes (TOCTOU race prevention).
 *
 * Multi-key acquisition uses sorted keys to prevent ABBA deadlock between
 * operations needing multiple locks (e.g., a transfer that locks both an
 * item and a currency).
 *
 * Design notes:
 *   - Each key maps to a Promise representing the "tail" of the waiting
 *     queue. A new acquirer awaits the previous tail, then installs itself
 *     as the new tail.
 *   - The synchronous portion (read tail, install new tail) is atomic
 *     because JavaScript is single-threaded; nothing can interleave between
 *     `this.locks.get` and `this.locks.set`.
 *   - No timeout in v1.0. A pathologically stuck operation will block its
 *     queue indefinitely. v1.1+ can add timeout with proper recovery
 *     semantics.
 */

export class AsyncLock {
  constructor() {
    this.locks = new Map();  // key -> Promise (current tail of the chain)
  }

  /**
   * Acquire the lock for a single key, run fn, release.
   * Operations on the same key serialize FIFO.
   *
   * @param {string} key
   * @param {Function} fn  async () => result
   * @returns {Promise<*>} the value returned by fn
   */
  async acquire(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    this.locks.set(key, next);

    try {
      await prev;
      return await fn();
    } finally {
      release();
      // If no later acquirer has chained onto us, prune the map entry
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }

  /**
   * Acquire locks for multiple keys (in sorted order) before running fn.
   * Sorting is critical: prevents ABBA deadlock when two operations need
   * overlapping but differently-ordered key sets.
   *
   * @param {string[]} keys
   * @param {Function} fn
   * @returns {Promise<*>}
   */
  async acquireMulti(keys, fn) {
    const sorted = [...keys].sort();
    return this._recursiveAcquire(sorted, 0, fn);
  }

  async _recursiveAcquire(sortedKeys, index, fn) {
    if (index >= sortedKeys.length) {
      return await fn();
    }
    return this.acquire(
      sortedKeys[index],
      () => this._recursiveAcquire(sortedKeys, index + 1, fn)
    );
  }

  /**
   * Diagnostic: number of keys currently in the lock map.
   * Note: a key in the map may have already released its current holder
   * if no later acquirer chained onto it; the map is pruned lazily.
   */
  size() {
    return this.locks.size;
  }

  /**
   * Diagnostic: list of keys currently in the lock map.
   */
  keys() {
    return Array.from(this.locks.keys());
  }
}
