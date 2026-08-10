/**
 * Durable replay ledger for authenticated mutations.
 *
 * These records intentionally do not share the presentation transaction log:
 * that log is capped and may be cleared by a GM, while a request tombstone must
 * remain authoritative for the whole accepted replay window. The staging Actor
 * keeps this flag private from players.
 */

import { FLAGS, MODULE_ID } from "./constants.js";
import { getStagingActor } from "./backing-actor.js";
import { requireActiveStorageGM, withStorageLedgerLock } from "./storage-ledger.js";

const TOMBSTONE_VERSION = 1;

/** Inspect the current private replay state without mutating it. */
export function inspectOperationTombstone(requestId, requestFingerprint) {
  const staging = requirePrivateStaging();
  return inspectRecords(readRecords(staging), requestId, requestFingerprint);
}

/**
 * Atomically create a pending claim, or return the existing request decision.
 * The write is read back before mutation code is allowed to proceed.
 */
export async function claimOperationTombstone({
  requestId,
  requestFingerprint,
  requester,
  operationType,
  timestamp,
  maxAgeMs,
  now = Date.now()
}) {
  return await withStorageLedgerLock(async () => {
    requireActiveStorageGM();
    const staging = requirePrivateStaging();
    const current = readRecords(staging);
    const retained = pruneExpiredRecords(current, { maxAgeMs, now });
    const existing = inspectRecords(retained, requestId, requestFingerprint);

    if (existing.state !== "none") {
      if (!recordsEqual(current, retained)) await persistAndVerify(staging, retained);
      return existing;
    }

    const record = {
      version: TOMBSTONE_VERSION,
      requestId,
      requestFingerprint,
      requester,
      operationType,
      timestamp,
      claimedAt: now,
      state: "pending"
    };
    const updated = [...retained, record];
    await persistAndVerify(staging, updated);
    return { state: "claimed", record: clone(record) };
  });
}

/**
 * Atomically replace a verified pending claim with its terminal result.
 * A missing claim, fingerprint collision, or failed read-back never invents a
 * terminal record.
 */
export async function finalizeOperationTombstone({
  requestId,
  requestFingerprint,
  result,
  maxAgeMs,
  now = Date.now()
}) {
  return await withStorageLedgerLock(async () => {
    requireActiveStorageGM();
    const staging = requirePrivateStaging();
    const current = readRecords(staging);
    const retained = pruneExpiredRecords(current, {
      maxAgeMs,
      now,
      preserveRequestId: requestId
    });
    const matchingIndexes = [];
    for (let index = 0; index < retained.length; index += 1) {
      if (retained[index]?.requestId === requestId) matchingIndexes.push(index);
    }
    if (matchingIndexes.length === 0) return { state: "missing" };

    const matching = matchingIndexes.map(index => retained[index]);
    if (matching.some(record => !validFingerprint(record.requestFingerprint))) {
      return { state: "unverifiable" };
    }
    if (matching.some(record => record.requestFingerprint !== requestFingerprint)) {
      return { state: "collision" };
    }
    if (matching.length !== 1) return { state: "unverifiable" };

    const existing = matching[0];
    const normalizedResult = normalizeResult(result);
    if (existing.state === "terminal") {
      return recordsEqual(existing.result, normalizedResult)
        ? { state: "replay", result: clone(existing.result) }
        : { state: "unverifiable" };
    }
    if (existing.state !== "pending") return { state: "unverifiable" };

    const terminal = {
      ...existing,
      state: "terminal",
      terminalAt: now,
      result: normalizedResult
    };
    const updated = [...retained];
    updated[matchingIndexes[0]] = terminal;
    await persistAndVerify(staging, updated);
    return { state: "terminal", record: clone(terminal) };
  });
}

/** Test/diagnostic snapshot of the private ledger. */
export function readOperationTombstones() {
  return readRecords(requirePrivateStaging());
}

function inspectRecords(records, requestId, requestFingerprint) {
  const matching = records.filter(record => record?.requestId === requestId);
  if (matching.length === 0) return { state: "none" };
  if (!validFingerprint(requestFingerprint)) return { state: "unverifiable" };
  if (matching.some(record => !validFingerprint(record?.requestFingerprint))) {
    return { state: "unverifiable" };
  }
  if (matching.some(record => record.requestFingerprint !== requestFingerprint)) {
    return { state: "collision" };
  }
  if (matching.length !== 1) return { state: "unverifiable" };

  const record = matching[0];
  if (record.state === "pending") return { state: "pending" };
  if (record.state !== "terminal" || !record.result || typeof record.result !== "object") {
    return { state: "unverifiable" };
  }
  if (typeof record.result.status !== "string" || !record.result.status) {
    return { state: "unverifiable" };
  }
  return { state: "replay", result: clone(record.result) };
}

function pruneExpiredRecords(records, { maxAgeMs, now, preserveRequestId = null }) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return records;
  const cutoff = now - maxAgeMs;
  return records.filter(record => {
    if (record?.requestId === preserveRequestId) return true;
    // Malformed records are security evidence, not disposable presentation
    // data. Keep them so the matching request continues to fail closed.
    if (typeof record?.timestamp !== "number" || !Number.isFinite(record.timestamp)) return true;
    return record.timestamp >= cutoff;
  });
}

function normalizeResult(result) {
  if (!result || typeof result !== "object" || typeof result.status !== "string") {
    throw new TypeError("operation-terminal-result-invalid");
  }
  return clone(result);
}

function requirePrivateStaging() {
  if (!globalThis.game?.user?.isGM) throw new Error("operation-tombstones-require-gm");
  const staging = getStagingActor();
  if (!staging) throw new Error("operation-tombstones-staging-unavailable");
  return staging;
}

function readRecords(staging) {
  const value = staging.getFlag?.(MODULE_ID, FLAGS.OPERATION_TOMBSTONES);
  return Array.isArray(value) ? clone(value) : [];
}

async function persistAndVerify(staging, records) {
  await staging.setFlag(MODULE_ID, FLAGS.OPERATION_TOMBSTONES, clone(records));
  const verified = readRecords(staging);
  if (!recordsEqual(verified, records)) {
    throw new Error("operation-tombstone-write-verification-failed");
  }
}

function validFingerprint(value) {
  return typeof value === "string" && value.length > 0;
}

function recordsEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
