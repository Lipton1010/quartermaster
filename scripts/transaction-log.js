/**
 * Canonical transaction log storage.
 *
 * Full entries live only on the GM-only staging actor. The shared vault holds
 * an optional redacted projection for players when world visibility is "all".
 */

import { MODULE_ID, MODULE_TITLE, FLAGS, SETTINGS, HOOKS } from "./constants.js";
import { getBackingActor, getStagingActor } from "./backing-actor.js";
import { projectPublicTransactionLog } from "./storage-privacy.js";
import {
  isActiveStorageGM,
  requireActiveStorageGM,
  withStorageLedgerLock
} from "./storage-ledger.js";

const LOG_LOOKUP_HORIZON = 50;

export function findByRequestId(requestId) {
  if (!requestId) return null;
  const log = canonicalLog();
  const start = Math.max(0, log.length - LOG_LOOKUP_HORIZON);
  for (let index = log.length - 1; index >= start; index -= 1) {
    if (log[index].requestId === requestId) return clone(log[index]);
  }
  return null;
}

export async function writeEntry(entry) {
  if (!isActiveStorageGM()) {
    console.warn(`${MODULE_TITLE} | transaction-log.writeEntry called outside the active GM; ignoring`);
    return null;
  }

  const fullEntry = {
    id: foundry.utils.randomID(),
    timestamp: Date.now(),
    ...clone(entry)
  };
  const written = await withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return null;
    const staging = getStagingActor();
    const backing = getBackingActor();
    if (!staging || !backing) {
      console.warn(`${MODULE_TITLE} | transaction-log.writeEntry called without complete storage; ignoring`);
      return null;
    }

    const updated = enforceCap([...canonicalLog(), fullEntry]);
    await writeVerifiedLog(staging, updated, "canonical-transaction-log");
    await syncPublicLog(backing, updated);
    return clone(fullEntry);
  });
  if (written) Hooks.callAll(HOOKS.LOG_ENTRY_ADDED, clone(written));
  return written;
}

/** GMs read canonical entries; players can only read the shared projection. */
export function readAll() {
  if (game.user?.isGM) return clone(canonicalLog());
  const backing = getBackingActor();
  return normalizeLog(backing?.getFlag?.(MODULE_ID, FLAGS.TRANSACTION_LOG));
}

export function count() {
  return readAll().length;
}

export async function updateEntry(requestId, updates) {
  if (!isActiveStorageGM()) {
    console.warn(`${MODULE_TITLE} | transaction-log.updateEntry called outside the active GM; ignoring`);
    return null;
  }
  if (!requestId) return null;
  const merged = await withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return null;
    const staging = getStagingActor();
    const backing = getBackingActor();
    if (!staging || !backing) return null;

    const log = canonicalLog();
    const start = Math.max(0, log.length - LOG_LOOKUP_HORIZON);
    let index = -1;
    for (let cursor = log.length - 1; cursor >= start; cursor -= 1) {
      if (log[cursor].requestId === requestId) {
        index = cursor;
        break;
      }
    }
    if (index < 0) return null;

    const nextEntry = { ...log[index], ...clone(updates), id: log[index].id };
    const updated = [...log];
    updated[index] = nextEntry;
    await writeVerifiedLog(staging, updated, "canonical-transaction-log");
    await syncPublicLog(backing, updated);
    return clone(nextEntry);
  });
  if (merged) Hooks.callAll(HOOKS.LOG_ENTRY_ADDED, clone(merged));
  return merged;
}

/**
 * Remove full Item recovery snapshots once a transfer reaches a terminal
 * state. Interrupted operations never call this helper, so their claims keep
 * enough private data for recovery. All entries for the request are scrubbed
 * in case an older build copied the snapshot into a failure row too.
 *
 * @param {string} requestId
 * @returns {Promise<number>} number of entries whose snapshots were released
 */
export async function releaseItemSnapshot(requestId) {
  if (!isActiveStorageGM() || !requestId) return 0;
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return 0;
    const staging = getStagingActor();
    const backing = getBackingActor();
    if (!staging || !backing) return 0;

    const snapshotFields = ["itemData", "itemSnapshot", "rawData", "sanitized"];
    const log = canonicalLog();
    let released = 0;
    const updated = log.map(entry => {
      if (entry.requestId !== requestId) return entry;
      const next = { ...entry };
      let changed = false;
      for (const field of snapshotFields) {
        if (!(field in next)) continue;
        delete next[field];
        changed = true;
      }
      if (changed) released += 1;
      return next;
    });
    if (released === 0) return 0;

    await writeVerifiedLog(staging, updated, "canonical-transaction-log");
    await syncPublicLog(backing, updated);
    return released;
  });
}

export async function clear() {
  if (!isActiveStorageGM()) {
    console.warn(`${MODULE_TITLE} | transaction-log.clear called outside the active GM; ignoring`);
    return false;
  }
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return false;
    const staging = getStagingActor();
    const backing = getBackingActor();
    if (!staging || !backing) return false;
    await writeVerifiedLog(staging, [], "canonical-transaction-log");
    await syncPublicLog(backing, []);
    return true;
  });
}

/** Rebuild the shared projection after visibility-setting changes. */
export async function refreshPublicProjection() {
  if (!isActiveStorageGM()) return false;
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return false;
    const backing = getBackingActor();
    if (!backing || !getStagingActor()) return false;
    await syncPublicLog(backing, canonicalLog());
    return true;
  });
}

function canonicalLog() {
  const staging = getStagingActor();
  if (staging) return normalizeLog(staging.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));
  // Legacy fallback before storage initialization/migration.
  const backing = getBackingActor();
  return normalizeLog(backing?.getFlag?.(MODULE_ID, FLAGS.TRANSACTION_LOG));
}

async function syncPublicLog(backing, canonical) {
  const projected = enforceCap(projectPublicTransactionLog(canonical));
  await writeVerifiedLog(backing, projected, "public-transaction-log-projection");
}

async function writeVerifiedLog(actor, intended, label) {
  requireActiveStorageGM();
  let writeError = null;
  try {
    await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, clone(intended));
  } catch (error) {
    writeError = error;
  }

  const retained = normalizeLog(actor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));
  if (!deepEqual(retained, intended)) {
    if (writeError) throw writeError;
    throw new Error(`${label}-verification-failed`);
  }
  if (writeError) {
    console.warn(`${MODULE_TITLE} | ${label} committed despite an update error`, writeError);
  }
}

function enforceCap(log) {
  let cap = 0;
  try {
    cap = Number(game.settings.get(MODULE_ID, SETTINGS.TRANSACTION_LOG_CAP));
  } catch { /* setting unavailable during early migration/tests */ }
  if (Number.isFinite(cap) && cap > 0 && log.length > cap) return log.slice(-cap);
  return log;
}

function normalizeLog(value) {
  return Array.isArray(value) ? clone(value) : [];
}

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// A key present with an `undefined` value is indistinguishable from an
// absent key once Foundry actually persists a flag - JSON has no `undefined`.
// Match that here so a benign, system-dependent `undefined` leaf (present in
// an in-memory Item's data but dropped on write) isn't mistaken for lost or
// corrupted data. Array elements still become `null`, matching JSON.stringify.
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry) ?? "null").join(",")}]`;
  }
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
