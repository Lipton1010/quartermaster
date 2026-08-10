/** GM-only recovery records stored exclusively on the private staging actor. */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getStagingActor } from "./backing-actor.js";
import {
  isActiveStorageGM,
  requireActiveStorageGM,
  withStorageLedgerLock
} from "./storage-ledger.js";

export function readRecoveryRecords() {
  if (!game.user?.isGM) return [];
  const actor = getStagingActor();
  const records = actor?.getFlag?.(MODULE_ID, FLAGS.RECOVERY_RECORDS);
  return Array.isArray(records) ? clone(records) : [];
}

export async function writeRecoveryRecord(record) {
  if (!isActiveStorageGM() || !record || typeof record !== "object") return null;
  const written = await withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return null;
    const actor = getStagingActor();
    if (!actor) return null;

    const records = readRecoveryRecords();
    const now = Date.now();
    const requestId = cleanString(record.requestId);
    const suppliedId = cleanString(record.id);
    const index = records.findIndex(candidate =>
      (suppliedId && candidate.id === suppliedId)
        || (requestId && candidate.requestId === requestId)
    );
    const previous = index >= 0 ? records[index] : null;
    const fullRecord = {
      id: previous?.id ?? suppliedId ?? `qm-recovery-${foundry.utils.randomID()}`,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      status: "failed",
      ...clone(previous ?? {}),
      ...clone(record),
      requestId: requestId || previous?.requestId || null
    };

    if (index >= 0) records[index] = fullRecord;
    else records.push(fullRecord);
    await writeVerifiedRecoveryRecords(actor, records);
    return clone(fullRecord);
  });
  if (written) console.warn(`${MODULE_TITLE} | Recovery record retained: ${written.id}`);
  return written;
}

export async function updateRecoveryRecord(identifier, updates) {
  if (!isActiveStorageGM() || !identifier || !updates || typeof updates !== "object") return null;
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return null;
    const records = readRecoveryRecords();
    const index = findIndex(records, identifier);
    if (index < 0) return null;
    const actor = getStagingActor();
    if (!actor) return null;

    records[index] = {
      ...records[index],
      ...clone(updates),
      id: records[index].id,
      updatedAt: Date.now()
    };
    await writeVerifiedRecoveryRecords(actor, records);
    return clone(records[index]);
  });
}

export async function removeRecoveryRecord(identifier) {
  if (!isActiveStorageGM() || !identifier) return false;
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return false;
    const actor = getStagingActor();
    if (!actor) return false;
    const records = readRecoveryRecords();
    const index = findIndex(records, identifier);
    if (index < 0) return false;
    records.splice(index, 1);
    await writeVerifiedRecoveryRecords(actor, records);
    return true;
  });
}

// Compatibility aliases for callers that use operation terminology.
export const addRecoveryRecord = writeRecoveryRecord;
export const resolveRecoveryRecord = removeRecoveryRecord;

function findIndex(records, identifier) {
  return records.findIndex(record => record.id === identifier || record.requestId === identifier);
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function writeVerifiedRecoveryRecords(actor, intended) {
  requireActiveStorageGM();
  let writeError = null;
  try {
    await actor.setFlag(MODULE_ID, FLAGS.RECOVERY_RECORDS, clone(intended));
  } catch (error) {
    writeError = error;
  }

  const retained = actor.getFlag(MODULE_ID, FLAGS.RECOVERY_RECORDS);
  if (!Array.isArray(retained) || !deepEqual(retained, intended)) {
    if (writeError) throw writeError;
    throw new Error("recovery-records-verification-failed");
  }
  if (writeError) {
    console.warn(`${MODULE_TITLE} | Recovery records committed despite an update error`, writeError);
  }
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
// Match that here so a benign, system-dependent `undefined` leaf in a
// recovered Item snapshot isn't mistaken for lost or corrupted data. Array
// elements still become `null`, matching JSON.stringify.
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry) ?? "null").join(",")}]`;
  }
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
