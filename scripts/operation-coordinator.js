/**
 * Quartermaster — Operation Coordinator
 *
 * Centralized executor for every mutation in the module. Single choke point
 * that owns:
 *
 *   1. Request age validation       (reject stale replays)
 *   2. LRU idempotency cache        (fast in-memory replay rejection)
 *   3. Transaction log idempotency  (durable cross-reload replay rejection)
 *   4. Per-resource mutex acquire   (TOCTOU prevention)
 *   5. fn execution with try/catch  (consistent error shape)
 *   6. Result caching               (later replays hit the cache)
 *   7. Transaction log write        (success and failure both recorded)
 *
 * Every write operation in Quartermaster routes through executeOperation().
 * No direct mutations should exist outside this function in v1.0.
 *
 * The coordinator runs on the active GM client. Player clients send their
 * intent via socket (build step 4) and receive results back.
 */

import { MODULE_ID, MODULE_TITLE, SETTINGS } from "./constants.js";
import { AsyncLock } from "./async-lock.js";
import { RecentRequestCache } from "./recent-request-cache.js";
import * as TransactionLog from "./transaction-log.js";

let _lock = null;
let _cache = null;
let _initialized = false;

/**
 * Initialize the coordinator's internal state. Called once during ready
 * after settings are registered and the backing actor is ensured.
 */
export function initializeCoordinator() {
  if (_initialized) return;

  const cacheSize = game.settings.get(MODULE_ID, SETTINGS.RECENT_REQUEST_CACHE_SIZE);

  _lock = new AsyncLock();
  _cache = new RecentRequestCache({ maxSize: cacheSize });
  _initialized = true;

  console.log(
    `${MODULE_TITLE} | Operation coordinator initialized ` +
    `(LRU cache size: ${cacheSize})`
  );
}

/**
 * Execute an operation with full coordination guarantees.
 *
 * @param {Object}    options
 * @param {string[]}  options.resourceKeys   keys to lock; e.g. ["item:abc", "currency:gp"]
 * @param {string}    options.requestId      unique identifier; used for idempotency
 * @param {string}    options.operationType  human-readable type tag for logging
 * @param {string}    options.requester      userId of the initiator (authoritative on GM side)
 * @param {number}    options.timestamp      epoch ms when the requester built the payload
 * @param {Function}  options.fn             async () => result, run under all locks
 *
 * @returns {Promise<Object>}  result envelope: { status, resultData?, error?, ... }
 */
export async function executeOperation({
  resourceKeys,
  requestId,
  operationType,
  requester,
  timestamp,
  fn
}) {
  if (!_initialized) {
    return { status: "failed", error: "coordinator-not-initialized" };
  }

  if (!Array.isArray(resourceKeys) || resourceKeys.length === 0) {
    return { status: "failed", error: "no-resource-keys" };
  }

  if (!requestId) {
    return { status: "failed", error: "missing-request-id" };
  }

  // 1. Request age check
  const maxAgeMs = game.settings.get(MODULE_ID, SETTINGS.REQUEST_AGE_MAX_SECONDS) * 1000;
  if (timestamp && maxAgeMs > 0) {
    const age = Date.now() - timestamp;
    if (age > maxAgeMs) {
      return {
        status: "failed",
        error: "request-too-old",
        ageMs: age,
        maxAgeMs
      };
    }
  }

  // 2. LRU idempotency check (fast)
  if (_cache.has(requestId)) {
    const cached = _cache.get(requestId);
    return { ...cached, fromCache: true };
  }

  // 3. Transaction log idempotency check (durable)
  const logHit = TransactionLog.findByRequestId(requestId);
  if (logHit) {
    const replayed = {
      status: logHit.status ?? "success",
      resultData: logHit.resultData ?? null,
      fromLog: true
    };
    _cache.set(requestId, replayed);
    return replayed;
  }

  // 4-7. Acquire mutexes, execute, cache, log
  return await _lock.acquireMulti(resourceKeys, async () => {
    let result;
    try {
      const fnReturn = await fn();
      // Normalize to a consistent envelope
      if (fnReturn && typeof fnReturn === "object" && "status" in fnReturn) {
        result = fnReturn;
      } else {
        result = { status: "success", resultData: fnReturn ?? null };
      }
    } catch (err) {
      console.error(
        `${MODULE_TITLE} | Operation failed`,
        { requestId, operationType, requester, err }
      );
      result = { status: "failed", error: err?.message ?? String(err) };
    }

    _cache.set(requestId, result);

    try {
      await TransactionLog.writeEntry({
        requestId,
        operationType,
        actorId: requester,
        status: result.status,
        resultData: result.resultData ?? null,
        error: result.error ?? null
      });
    } catch (logErr) {
      // Logging failure should not invalidate the operation result
      console.error(`${MODULE_TITLE} | Failed to write transaction log entry`, logErr);
    }

    return result;
  });
}

/**
 * Diagnostics for the step 3 verification harness and future debugging.
 */
export function diagnostics() {
  if (!_initialized) {
    return { initialized: false };
  }
  return {
    initialized: true,
    locksHeld: _lock.size(),
    lockedKeys: _lock.keys(),
    cacheSize: _cache.size()
  };
}

/**
 * Test-only: clear the in-memory LRU cache. Used by the step 3 verification
 * harness between tests. Does NOT clear the transaction log.
 */
export function _resetCacheForTesting() {
  if (_cache) _cache.clear();
}
