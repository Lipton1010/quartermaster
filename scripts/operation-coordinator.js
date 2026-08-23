/**
 * Quartermaster — Operation Coordinator
 *
 * Centralized executor for authenticated mutations. Requests are bound to the
 * authoritative requester, operation type, and a canonical representation of
 * their data. A request ID may only replay the exact request which first used
 * it; collisions fail without returning the original result.
 */

import {
  MODULE_ID,
  MODULE_TITLE,
  REQUEST_FUTURE_SKEW_MS,
  SETTINGS
} from "./constants.js";
import { AsyncLock } from "./async-lock.js";
import { RecentRequestCache } from "./recent-request-cache.js";
import {
  claimOperationTombstone,
  finalizeOperationTombstone,
  inspectOperationTombstone
} from "./operation-tombstones.js";
import { isActiveStorageGM } from "./storage-ledger.js";
import * as TransactionLog from "./transaction-log.js";

const OPERATION_CLAIM_TYPE = "operation.claim";
const OPERATION_COMMIT_TYPE = "operation.commit";
const OPERATION_FAILED_TYPE = "operation.failed";
const DEFAULT_REQUEST_AGE_MS = 30_000;

let _lock = null;
let _cache = null;
let _initialized = false;

/** Initialize the coordinator after settings and private storage are ready. */
export function initializeCoordinator() {
  if (_initialized) return;

  const cacheSize = game.settings.get(MODULE_ID, SETTINGS.RECENT_REQUEST_CACHE_SIZE);
  _lock = new AsyncLock();
  _cache = new RecentRequestCache({ maxSize: cacheSize });
  _initialized = true;

  console.log(
    `${MODULE_TITLE} | Operation coordinator initialized `
    + `(LRU cache size: ${cacheSize})`
  );
}

/**
 * Execute an operation with replay protection and per-resource serialization.
 *
 * `requestData` must be a JSON-serializable object containing the authenticated,
 * mutation-relevant request shape (payload type/action/data). The timestamp is
 * part of that binding, so a caller must retry the original envelope rather
 * than minting a fresh timestamp for an old request ID.
 *
 * @param {Object} options
 * @param {string[]} options.resourceKeys
 * @param {string} options.requestId
 * @param {string} options.operationType
 * @param {string} options.requester authoritative Foundry user ID
 * @param {number} options.timestamp
 * @param {Object} options.requestData canonical mutation-relevant request data
 * @param {Function} options.fn
 * @returns {Promise<Object>}
 */
export async function executeOperation(options = {}) {
  const {
    resourceKeys,
    requestId,
    operationType,
    requester,
    timestamp,
    requestData,
    fn
  } = options;

  if (!_initialized) {
    return { status: "failed", error: "coordinator-not-initialized" };
  }
  if (!isActiveStorageGM()) {
    return { status: "failed", error: "active-gm-required" };
  }
  if (!Array.isArray(resourceKeys) || resourceKeys.length === 0) {
    return { status: "failed", error: "no-resource-keys" };
  }
  if (typeof requestId !== "string" || !requestId.trim()) {
    return { status: "failed", error: "missing-request-id" };
  }
  if (typeof operationType !== "string" || !operationType.trim()) {
    return { status: "failed", error: "missing-operation-type" };
  }
  if (typeof requester !== "string" || !requester.trim()) {
    return { status: "failed", error: "missing-requester" };
  }
  if (typeof fn !== "function") {
    return { status: "failed", error: "missing-operation-function" };
  }
  if (!Object.prototype.hasOwnProperty.call(options, "requestData")
      || !requestData
      || typeof requestData !== "object"
      || Array.isArray(requestData)) {
    return { status: "failed", error: "invalid-request-data" };
  }

  const now = Date.now();
  const maxAgeMs = getRequestAgeMaxMs();
  const timestampError = validateTimestamp(timestamp, { now, maxAgeMs });
  if (timestampError) return timestampError;

  let binding;
  try {
    binding = createRequestBinding({
      requester,
      operationType,
      timestamp,
      requestData
    });
  } catch (error) {
    return {
      status: "failed",
      error: "invalid-request-data",
      details: errorMessage(error)
    };
  }

  const tombstone = safelyInspectTombstone(requestId, binding);
  if (tombstone.state !== "none" && tombstone.state !== "pending") {
    return replayDecision(tombstone, "tombstone");
  }

  const cached = inspectCachedRequest(requestId, binding);
  if (cached.state !== "none") return replayDecision(cached, "cache");

  const durable = inspectDurableRequest(requestId, binding);
  if (durable.state !== "none" && durable.state !== "pending") {
    return replayDecision(durable, "log");
  }

  // A request-ID lock is required in addition to resource locks. Otherwise a
  // colliding request using different resources can race the original.
  const lockKeys = [...new Set([
    ...resourceKeys.map(key => String(key)),
    `request:${requestId}`
  ])];

  return await _lock.acquireMulti(lockKeys, async () => {
    // Recheck after acquiring locks. A matching request may have completed
    // while this call was queued.
    const tombstoneAfterLock = safelyInspectTombstone(requestId, binding);
    if (tombstoneAfterLock.state !== "none") {
      if (tombstoneAfterLock.state === "pending") {
        return { status: "failed", error: "request-recovery-required" };
      }
      return replayDecision(tombstoneAfterLock, "tombstone");
    }

    const cachedAfterLock = inspectCachedRequest(requestId, binding);
    if (cachedAfterLock.state !== "none") {
      return replayDecision(cachedAfterLock, "cache");
    }

    const durableAfterLock = inspectDurableRequest(requestId, binding);
    if (durableAfterLock.state !== "none") {
      if (durableAfterLock.state === "pending") {
        return { status: "failed", error: "request-recovery-required" };
      }
      return replayDecision(durableAfterLock, "log");
    }

    // The uncapped private tombstone is the security authority. Claim it and
    // verify the storage read-back before writing presentation logs or
    // entering any mutation code.
    let tombstoneClaim;
    try {
      tombstoneClaim = await claimOperationTombstone({
        requestId,
        requestFingerprint: binding.fingerprint,
        requester,
        operationType,
        timestamp,
        maxAgeMs,
        now
      });
    } catch (claimError) {
      console.error(`${MODULE_TITLE} | Failed to persist operation tombstone claim`, claimError);
      return { status: "failed", error: "claim-tombstone-failed" };
    }
    if (tombstoneClaim.state !== "claimed") {
      return replayDecision(tombstoneClaim, "tombstone");
    }

    // Retain coordinator entries in the transaction log for presentation and
    // recovery context, but never rely on its capped history for replay safety.
    let claimEntry = null;
    try {
      claimEntry = await TransactionLog.writeEntry({
        type: OPERATION_CLAIM_TYPE,
        visibility: "gm",
        requestId,
        operationType,
        actorId: requester,
        requester,
        requestFingerprint: binding.fingerprint
      });
    } catch (claimError) {
      console.error(`${MODULE_TITLE} | Failed to write operation claim`, claimError);
      return await finalizePreMutationFailure({
        requestId,
        binding,
        maxAgeMs,
        error: "claim-log-failed"
      });
    }
    if (!claimEntry) {
      return await finalizePreMutationFailure({
        requestId,
        binding,
        maxAgeMs,
        error: "claim-log-unavailable"
      });
    }

    // Foundry can elect another active GM while this request is waiting on
    // storage or presentation-log writes. Recheck at the last possible point
    // before invoking caller mutation code; the pending tombstone deliberately
    // remains as reconciliation evidence if authority changed.
    if (!isActiveStorageGM()) {
      return { status: "failed", error: "active-gm-required" };
    }

    let result;
    try {
      const fnReturn = await fn();
      if (fnReturn && typeof fnReturn === "object" && "status" in fnReturn) {
        result = fnReturn;
      } else {
        result = { status: "success", resultData: fnReturn ?? null };
      }
    } catch (error) {
      console.error(
        `${MODULE_TITLE} | Operation failed`,
        { requestId, operationType, requester, error }
      );
      result = { status: "failed", error: error?.message ?? String(error) };
    }

    let terminalResult;
    try {
      terminalResult = normalizeTerminalResult(result);
    } catch (serializationError) {
      // The mutation may already have committed. Never invent a terminal
      // failure or return a non-transport-safe value; retain the pending
      // tombstone so every retry fails closed for manual reconciliation.
      console.error(
        `${MODULE_TITLE} | Operation result was not JSON-serializable`,
        { requestId, operationType, serializationError }
      );
      return { status: "failed", error: "operation-reconciliation-required" };
    }

    try {
      const terminal = await finalizeOperationTombstone({
        requestId,
        requestFingerprint: binding.fingerprint,
        result: terminalResult,
        maxAgeMs
      });
      if (terminal.state !== "terminal" && terminal.state !== "replay") {
        console.error(`${MODULE_TITLE} | Operation terminal tombstone was not persisted`, {
          requestId,
          state: terminal.state
        });
        return { status: "failed", error: "operation-reconciliation-required" };
      }
    } catch (tombstoneError) {
      console.error(`${MODULE_TITLE} | Failed to persist operation terminal tombstone`, tombstoneError);
      return { status: "failed", error: "operation-reconciliation-required" };
    }

    cacheResult(requestId, binding, terminalResult);

    try {
      const terminalEntry = await TransactionLog.writeEntry({
        type: terminalResult.status === "success" ? OPERATION_COMMIT_TYPE : OPERATION_FAILED_TYPE,
        visibility: "gm",
        requestId,
        operationType,
        actorId: requester,
        requester,
        requestFingerprint: binding.fingerprint,
        status: terminalResult.status,
        resultData: terminalResult.resultData ?? null,
        error: terminalResult.error ?? null
      });
      if (!terminalEntry) {
        console.error(`${MODULE_TITLE} | Operation terminal log was unavailable`, { requestId });
      }
    } catch (logError) {
      // The mutation outcome remains valid in this session via the cache. On a
      // reload, the durable claim and any operation-specific commit/failure
      // record drive a conservative recovery decision.
      console.error(`${MODULE_TITLE} | Failed to write operation terminal entry`, logError);
    }

    return terminalResult;
  });
}

/**
 * Convert every terminal envelope to the same plain JSON value Foundry can
 * persist in a flag and return through CONFIG.queries. Document instances use
 * their toJSON implementation; cycles, BigInt values, and other unsupported
 * results fail before a terminal tombstone is written.
 */
function normalizeTerminalResult(result) {
  const serialized = JSON.stringify(result);
  if (typeof serialized !== "string") throw new TypeError("operation-result-not-serializable");
  const normalized = JSON.parse(serialized);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError("operation-result-envelope-invalid");
  }
  if (typeof normalized.status !== "string" || !normalized.status) {
    throw new TypeError("operation-result-status-invalid");
  }
  return normalized;
}

function createRequestBinding({ requester, operationType, timestamp, requestData }) {
  const payloadFingerprint = canonicalJson(requestData);
  return {
    requester,
    operationType,
    timestamp,
    fingerprint: canonicalJson({
      requester,
      operationType,
      timestamp,
      payloadFingerprint
    })
  };
}

function safelyInspectTombstone(requestId, binding) {
  try {
    return inspectOperationTombstone(requestId, binding.fingerprint);
  } catch (error) {
    console.error(`${MODULE_TITLE} | Failed to inspect operation tombstones`, error);
    return { state: "unverifiable" };
  }
}

/** Public for durable callers which persist a request timestamp between UI attempts. */
export function getRequestAgeMaxMs() {
  const seconds = Number(game.settings.get(MODULE_ID, SETTINGS.REQUEST_AGE_MAX_SECONDS));
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : DEFAULT_REQUEST_AGE_MS;
}

/**
 * Inspect a request's private replay authority without executing it.
 * Durable callers use this before replacing an expired persisted request ID.
 */
export function inspectRequestReplay({
  requestId,
  requester,
  operationType,
  timestamp,
  requestData
} = {}) {
  if (typeof requestId !== "string" || !requestId.trim()) return { state: "unverifiable" };
  try {
    const binding = createRequestBinding({ requester, operationType, timestamp, requestData });
    const tombstone = safelyInspectTombstone(requestId, binding);
    if (tombstone.state !== "none") return tombstone;
    const cached = inspectCachedRequest(requestId, binding);
    if (cached.state !== "none") return cached;
    return inspectDurableRequest(requestId, binding);
  } catch {
    return { state: "unverifiable" };
  }
}

function validateTimestamp(timestamp, { now, maxAgeMs }) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return { status: "failed", error: "invalid-request-timestamp" };
  }

  const ageMs = now - timestamp;
  if (maxAgeMs > 0 && ageMs > maxAgeMs) {
    return {
      status: "failed",
      error: "request-too-old",
      ageMs,
      maxAgeMs
    };
  }

  const futureSkewMs = timestamp - now;
  if (futureSkewMs > REQUEST_FUTURE_SKEW_MS) {
    return {
      status: "failed",
      error: "request-too-far-in-future",
      futureSkewMs,
      maxFutureSkewMs: REQUEST_FUTURE_SKEW_MS
    };
  }

  return null;
}

async function finalizePreMutationFailure({ requestId, binding, maxAgeMs, error }) {
  const result = { status: "failed", error };
  try {
    const terminal = await finalizeOperationTombstone({
      requestId,
      requestFingerprint: binding.fingerprint,
      result,
      maxAgeMs
    });
    if (terminal.state === "terminal" || terminal.state === "replay") return result;
  } catch (tombstoneError) {
    console.error(
      `${MODULE_TITLE} | Failed to finalize pre-mutation tombstone`,
      { requestId, tombstoneError }
    );
  }
  return { status: "failed", error: "operation-reconciliation-required" };
}

function inspectCachedRequest(requestId, binding) {
  if (!_cache.has(requestId)) return { state: "none" };
  const record = _cache.get(requestId);
  if (!record || typeof record !== "object" || !("result" in record)) {
    return { state: "unverifiable" };
  }
  if (!binding.fingerprint || !record.requestFingerprint) {
    return { state: "unverifiable" };
  }
  if (record.requestFingerprint !== binding.fingerprint) {
    return { state: "collision" };
  }
  return { state: "replay", result: record.result };
}

function inspectDurableRequest(requestId, binding) {
  let entries;
  try {
    entries = TransactionLog.readAll()
      .filter(entry => entry?.requestId === requestId);
  } catch (error) {
    console.error(`${MODULE_TITLE} | Failed to inspect durable request state`, error);
    return { state: "unverifiable" };
  }
  if (entries.length === 0) return { state: "none" };

  const boundEntries = entries.filter(entry =>
    isCoordinatorEntry(entry)
    && typeof entry.requestFingerprint === "string"
    && entry.requestFingerprint
  );

  if (boundEntries.length === 0) {
    // Legacy or operation-specific rows cannot prove the authenticated payload
    // binding. Never replay their resultData and never execute over them.
    return entries.some(entry => isExplicitTerminalEntry(entry))
      ? { state: "unverifiable" }
      : { state: "pending" };
  }
  if (!binding.fingerprint) return { state: "unverifiable" };
  if (boundEntries.some(entry => entry.requestFingerprint !== binding.fingerprint)) {
    return { state: "collision" };
  }

  const coordinatorTerminal = findLast(entries, entry =>
    (entry.type === OPERATION_COMMIT_TYPE || entry.type === OPERATION_FAILED_TYPE)
    && entry.requestFingerprint === binding.fingerprint
  );
  if (coordinatorTerminal) {
    return {
      state: "replay",
      result: {
        status: coordinatorTerminal.status
          ?? (coordinatorTerminal.type === OPERATION_COMMIT_TYPE ? "success" : "failed"),
        resultData: coordinatorTerminal.resultData ?? null,
        ...(coordinatorTerminal.error ? { error: coordinatorTerminal.error } : {})
      }
    };
  }

  const claimIndex = findLastIndex(entries, entry => entry.type === OPERATION_CLAIM_TYPE);
  const operationSpecificTerminal = findLast(
    claimIndex >= 0 ? entries.slice(claimIndex + 1) : [],
    entry => isExplicitTerminalEntry(entry) && !isCoordinatorEntry(entry)
  );
  if (operationSpecificTerminal) {
    const type = String(operationSpecificTerminal.type ?? "");
    const committed = type.endsWith(".commit");
    return {
      state: "replay",
      result: {
        status: committed ? "success" : (type.endsWith(".denied") ? "denied" : "failed"),
        resultData: null,
        ...(operationSpecificTerminal.error ? { error: operationSpecificTerminal.error } : {}),
        recoveredFromOperationLog: true
      }
    };
  }

  return { state: "pending" };
}

function isCoordinatorEntry(entry) {
  return entry?.type === OPERATION_CLAIM_TYPE
    || entry?.type === OPERATION_COMMIT_TYPE
    || entry?.type === OPERATION_FAILED_TYPE;
}

function isExplicitTerminalEntry(entry) {
  const type = String(entry?.type ?? "");
  return type === OPERATION_COMMIT_TYPE
    || type === OPERATION_FAILED_TYPE
    || type.endsWith(".commit")
    || type.endsWith(".failed")
    || type.endsWith(".denied");
}

function replayDecision(decision, source) {
  if (decision.state === "collision") {
    return { status: "failed", error: "request-id-collision" };
  }
  if (decision.state === "unverifiable") {
    return { status: "failed", error: "request-replay-unverifiable" };
  }
  if (decision.state === "replay") {
    const sourceFlag = source === "cache"
      ? "fromCache"
      : source === "tombstone" ? "fromTombstone" : "fromLog";
    return {
      ...decision.result,
      [sourceFlag]: true
    };
  }
  return { status: "failed", error: "request-recovery-required" };
}

function cacheResult(requestId, binding, result) {
  _cache.set(requestId, {
    requestFingerprint: binding.fingerprint,
    result: { ...result }
  });
}

/** JSON-compatible, key-order-independent exact request fingerprint. */
function canonicalJson(value) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new TypeError("request data is not JSON-serializable");
  return stableStringify(JSON.parse(serialized));
}

// A key present with an `undefined` value is indistinguishable from an
// absent key once Foundry actually persists data - JSON has no `undefined`.
// Match that here so a benign, system-dependent `undefined` leaf isn't
// mistaken for a genuinely different fingerprint. Array elements still
// become `null`, matching JSON.stringify.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry) ?? "null").join(",")}]`;
  }
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function findLast(entries, predicate) {
  const index = findLastIndex(entries, predicate);
  return index >= 0 ? entries[index] : null;
}

function findLastIndex(entries, predicate) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) return index;
  }
  return -1;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Diagnostics for development and automated verification. */
export function diagnostics() {
  if (!_initialized) return { initialized: false };
  return {
    initialized: true,
    locksHeld: _lock.size(),
    lockedKeys: _lock.keys(),
    cacheSize: _cache.size()
  };
}

/** Test-only: clear the in-memory LRU cache without touching durable logs. */
export function _resetCacheForTesting() {
  if (_cache) _cache.clear();
}
