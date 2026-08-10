/** Restartable migration from the v0.1.8 single-actor layout to schema 1. */

import {
  MODULE_ID,
  MODULE_TITLE,
  FLAGS,
  STORAGE_SCHEMA_VERSION
} from "./constants.js";
import { projectPublicTransactionLog } from "./storage-privacy.js";
import {
  isActiveStorageGM,
  requireActiveStorageGM,
  withStorageLedgerLock
} from "./storage-ledger.js";

const MIGRATION_SOURCE_FLAG = "migrationSourceUuid";

export async function migrateStorageSchema(backingActor, stagingActor) {
  if (!game.user?.isGM) return { migrated: false, reason: "gm-only" };
  if (!isActiveStorageGM()) return { migrated: false, reason: "active-gm-only" };
  if (!backingActor || !stagingActor) throw new Error("storage-actors-required");

  const currentVersion = normalizeVersion(
    backingActor.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION)
  );
  const stagingVersion = normalizeVersion(
    stagingActor.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION)
  );
  if (currentVersion > STORAGE_SCHEMA_VERSION) {
    throw new Error(`unsupported-storage-schema-${currentVersion}`);
  }
  if (stagingVersion > STORAGE_SCHEMA_VERSION) {
    throw new Error(`unsupported-staging-storage-schema-${stagingVersion}`);
  }
  if (currentVersion === STORAGE_SCHEMA_VERSION) {
    // The shared marker is written last, so it is authoritative proof that the
    // schema-1 copy-and-verify pass completed. If the private marker was later
    // lost, repair it only after rechecking the privacy boundary and canonical
    // log. Never leave a permanently blocked world because one marker vanished.
    // Early schema-1 development builds did not archive loot-prep notes from
    // already-visible Items. Repair that privacy boundary idempotently before
    // accepting the marker as complete.
    await migrateVisibleItemMetadata(backingActor, stagingActor);
    verifyPrivateStorageCleared(backingActor);
    await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      await ensureStagingDefaults(stagingActor);
      if (stagingVersion !== STORAGE_SCHEMA_VERSION) {
        await verifyAndRefreshTransactionProjection(backingActor, stagingActor);
      }
    });
    if (stagingVersion !== STORAGE_SCHEMA_VERSION) {
      await setVerifiedSchemaMarker(stagingActor, "staging");
      return {
        migrated: false,
        version: currentVersion,
        repairedStagingMarker: true
      };
    }
    return { migrated: false, version: currentVersion, repairedStagingMarker: false };
  }

  let state = normalizeState(backingActor.getFlag(MODULE_ID, FLAGS.MIGRATION_STATE));
  state = {
    ...state,
    targetVersion: STORAGE_SCHEMA_VERSION,
    status: "running",
    startedAt: state.startedAt ?? Date.now(),
    updatedAt: Date.now(),
    phase: state.phase ?? "prepare",
    attempts: (state.attempts ?? 0) + 1
  };
  requireActiveStorageGM();
  await backingActor.setFlag(MODULE_ID, FLAGS.MIGRATION_STATE, state);

  try {
    await setPhase(backingActor, state, "items");
    const itemCount = await migrateHiddenItems(backingActor, stagingActor);

    await setPhase(backingActor, state, "visible-item-metadata");
    const metadataCount = await migrateVisibleItemMetadata(backingActor, stagingActor);

    await setPhase(backingActor, state, "loot-prep-metadata");
    await migrateArrayFlag(backingActor, stagingActor, FLAGS.HIDDEN_CURRENCY, entryIdentity);
    await migrateArrayFlag(backingActor, stagingActor, FLAGS.LOOT_PREP_FOLDERS, entryIdentity);
    const fractionalCurrencyWarnings = await detectFractionalHiddenCurrency(backingActor, stagingActor);

    await setPhase(backingActor, state, "transaction-log");
    await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      await migrateTransactionLog(backingActor, stagingActor, state);
    });

    await setPhase(backingActor, state, "verify");
    verifyPrivateStorageCleared(backingActor);
    await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      await ensureStagingDefaults(stagingActor);
    });

    state = {
      ...state,
      status: "complete",
      phase: "complete",
      migratedItemCount: itemCount,
      migratedVisibleItemMetadataCount: metadataCount,
      fractionalCurrencyWarnings,
      completedAt: Date.now(),
      updatedAt: Date.now(),
      error: null
    };
    requireActiveStorageGM();
    await backingActor.setFlag(MODULE_ID, FLAGS.MIGRATION_STATE, state);
    await setVerifiedSchemaMarker(stagingActor, "staging");
    // The shared marker advances last. A failure before this line is retried.
    await setVerifiedSchemaMarker(backingActor, "shared");
    console.log(`${MODULE_TITLE} | Storage migration to schema ${STORAGE_SCHEMA_VERSION} complete`);
    return { migrated: true, version: STORAGE_SCHEMA_VERSION, itemCount, fractionalCurrencyWarnings };
  } catch (error) {
    const failed = {
      ...state,
      status: "failed",
      updatedAt: Date.now(),
      error: String(error?.message ?? error)
    };
    if (isActiveStorageGM()) {
      try {
        await backingActor.setFlag(MODULE_ID, FLAGS.MIGRATION_STATE, failed);
      } catch (stateError) {
        console.error(`${MODULE_TITLE} | Failed to persist migration failure state`, stateError);
      }
    }
    console.error(`${MODULE_TITLE} | Storage migration failed at ${state.phase}`, error);
    throw error;
  }
}

async function setPhase(actor, state, phase) {
  requireActiveStorageGM();
  state.phase = phase;
  state.updatedAt = Date.now();
  state.error = null;
  await actor.setFlag(MODULE_ID, FLAGS.MIGRATION_STATE, { ...state });
}

async function migrateHiddenItems(backingActor, stagingActor) {
  requireActiveStorageGM();
  const hiddenItems = backingActor.items.filter(item =>
    item.getFlag(MODULE_ID, FLAGS.HIDDEN) === true
  );
  let count = 0;

  for (const source of hiddenItems) {
    const sourceUuid = source.uuid ?? `${backingActor.uuid}.Item.${source.id}`;
    const expectedData = clone(source.toObject());
    expectedData.flags ??= {};
    expectedData.flags[MODULE_ID] = {
      ...(expectedData.flags[MODULE_ID] ?? {}),
      [FLAGS.HIDDEN]: true,
      [MIGRATION_SOURCE_FLAG]: sourceUuid
    };
    let destination = stagingActor.items.find(item =>
      item.getFlag(MODULE_ID, MIGRATION_SOURCE_FLAG) === sourceUuid
    );

    if (!destination) {
      const sameId = stagingActor.items.get(source.id);
      if (sameId) {
        const marker = sameId.getFlag(MODULE_ID, MIGRATION_SOURCE_FLAG);
        if (marker !== sourceUuid) throw new Error(`staging-item-id-collision-${source.id}`);
        destination = sameId;
      }
    }

    if (!destination) {
      requireActiveStorageGM();
      [destination] = await stagingActor.createEmbeddedDocuments("Item", [expectedData], { keepId: true });
    }

    if (!destination || !verifyMigratedItem(expectedData, destination.toObject())) {
      throw new Error(`hidden-item-verification-failed-${source.id}`);
    }

    requireActiveStorageGM();
    await backingActor.deleteEmbeddedDocuments("Item", [source.id]);
    count += 1;
  }
  return count;
}

/**
 * Notes/folder assignments on already-visible v0.1.8 Items are still private
 * GM preparation data. Archive them on staging before scrubbing the shared
 * Item. The stable UUID identity makes the pass restartable and conflict-safe.
 */
async function migrateVisibleItemMetadata(backingActor, stagingActor) {
  requireActiveStorageGM();
  const records = [];
  const sources = [];
  for (const item of backingActor.items ?? []) {
    if (item.getFlag(MODULE_ID, FLAGS.HIDDEN) === true) continue;
    const note = item.getFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE);
    const folderId = item.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDER);
    if (note == null && folderId == null) continue;
    const sourceItemUuid = item.uuid ?? `${backingActor.uuid}.Item.${item.id}`;
    records.push({
      id: sourceItemUuid,
      sourceItemUuid,
      itemId: item.id,
      itemName: item.name ?? null,
      note: note ?? null,
      folderId: folderId ?? null
    });
    sources.push(item);
  }
  if (records.length === 0) return 0;

  const current = normalizeArray(
    stagingActor.getFlag(MODULE_ID, FLAGS.MIGRATED_ITEM_METADATA)
  );
  const merged = mergeUnique(current, records, entryIdentity);
  await writeAndVerifyArrayFlag(
    stagingActor,
    FLAGS.MIGRATED_ITEM_METADATA,
    merged,
    "migrated-visible-item-metadata"
  );

  for (const item of sources) {
    await scrubPrivateItemFlag(item, FLAGS.LOOT_PREP_NOTE);
    await scrubPrivateItemFlag(item, FLAGS.LOOT_PREP_FOLDER);
  }
  return records.length;
}

async function scrubPrivateItemFlag(item, flag) {
  requireActiveStorageGM();
  let writeError = null;
  try {
    await item.unsetFlag(MODULE_ID, flag);
  } catch (error) {
    writeError = error;
  }
  if (item.getFlag(MODULE_ID, flag) != null) {
    if (writeError) throw writeError;
    throw new Error(`shared-item-${flag}-scrub-verification-failed-${item.id}`);
  }
  if (writeError) {
    console.warn(`${MODULE_TITLE} | ${flag} scrub committed despite an update error`, writeError);
  }
}

function verifyMigratedItem(expected, actual) {
  const project = data => ({
    _id: data?._id ?? data?.id ?? null,
    name: data?.name ?? null,
    type: data?.type ?? null,
    img: data?.img ?? null,
    system: data?.system ?? {},
    effects: data?.effects ?? [],
    flags: data?.flags ?? {}
  });
  // A system's data model may back a field with a genuine Set (e.g. a tag list
  // with no meaningful order or duplicates). Recreating the Item through
  // createEmbeddedDocuments can round-trip such a field with a benign
  // duplicate entry. Compare primitive-only arrays as deduplicated, unordered
  // content so that normalization isn't mistaken for lost or corrupted data;
  // arrays of objects (like `effects`) still compare exactly.
  return deepEqual(
    normalizeSetSemanticArrays(project(expected)),
    normalizeSetSemanticArrays(project(actual))
  );
}

function normalizeSetSemanticArrays(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeSetSemanticArrays);
    const allPrimitive = normalized.every(entry => entry === null || typeof entry !== "object");
    return allPrimitive ? [...new Set(normalized)].sort() : normalized;
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) result[key] = normalizeSetSemanticArrays(value[key]);
    return result;
  }
  return value;
}

async function migrateArrayFlag(source, destination, flag, identity) {
  requireActiveStorageGM();
  const sourceEntries = normalizeArray(source.getFlag(MODULE_ID, flag));
  const destinationEntries = normalizeArray(destination.getFlag(MODULE_ID, flag));
  const merged = mergeUnique(destinationEntries, sourceEntries, identity);

  if (!deepEqual(destinationEntries, merged)) {
    requireActiveStorageGM();
    await destination.setFlag(MODULE_ID, flag, merged);
  }
  const verified = normalizeArray(destination.getFlag(MODULE_ID, flag));
  for (const entry of sourceEntries) {
    const copied = verified.find(candidate => identity(candidate) === identity(entry));
    if (!copied || !deepEqual(copied, entry)) {
      throw new Error(`${flag}-verification-failed`);
    }
  }
  if (sourceEntries.length > 0) {
    requireActiveStorageGM();
    await source.setFlag(MODULE_ID, flag, []);
  }
}

/**
 * v0.1.8 accepted fractional hidden-currency amounts. Some native currencies
 * (PF2e's coin APIs) now require whole units, so a migrated fractional entry
 * could never be revealed. Detect these instead of leaving them silently
 * stuck, and hand the GM enough identity to reconcile or discard them.
 */
async function detectFractionalHiddenCurrency(backingActor, stagingActor) {
  const entries = normalizeArray(stagingActor.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY));
  if (entries.length === 0) return [];

  let getCurrency;
  try {
    ({ getCurrency } = await import("./currencies.js"));
  } catch (error) {
    console.warn(`${MODULE_TITLE} | Unable to load currency definitions to check migrated hidden currency`, error);
    return [];
  }

  const flagged = [];
  for (const entry of entries) {
    const amount = Number(entry?.amount);
    if (!Number.isFinite(amount) || Number.isInteger(amount)) continue;
    const currencyId = entry?.currencyId ?? entry?.type;
    if (!currencyId) continue;
    let currency = null;
    try {
      currency = getCurrency(currencyId, backingActor);
    } catch (error) {
      console.warn(`${MODULE_TITLE} | Unable to resolve migrated currency "${currencyId}"`, error);
      continue;
    }
    if (currency?.wholeUnitsOnly) {
      flagged.push({ id: entry.id ?? null, currencyId, amount });
    }
  }

  if (flagged.length > 0) {
    console.warn(
      `${MODULE_TITLE} | Migrated hidden currency includes fractional amounts that cannot be revealed until a GM corrects them`,
      flagged
    );
    globalThis.ui?.notifications?.warn?.(
      `${MODULE_TITLE}: migrated hidden currency includes fractional amounts (${
        flagged.map(entry => `${entry.amount} ${entry.currencyId}`).join(", ")
      }) that cannot be revealed until a GM corrects them.`
    );
  }
  return flagged;
}

async function migrateTransactionLog(backingActor, stagingActor, state) {
  const publicOrLegacy = normalizeArray(backingActor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));
  let canonical = normalizeArray(stagingActor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));

  if (!state.canonicalLogCopied) {
    canonical = mergeUnique(canonical, publicOrLegacy, logIdentity);
    await writeAndVerifyArrayFlag(
      stagingActor,
      FLAGS.TRANSACTION_LOG,
      canonical,
      "canonical-transaction-log"
    );
    const verified = normalizeArray(stagingActor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));
    for (const entry of publicOrLegacy) {
      const copied = verified.find(candidate => logIdentity(candidate) === logIdentity(entry));
      if (!copied || !deepEqual(copied, entry)) {
        throw new Error("transaction-log-verification-failed");
      }
    }
    state.canonicalLogCopied = true;
    state.updatedAt = Date.now();
    requireActiveStorageGM();
    await backingActor.setFlag(MODULE_ID, FLAGS.MIGRATION_STATE, state);
  } else {
    canonical = normalizeArray(stagingActor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));
    // A persisted phase flag is only a restart hint, never authority to erase
    // the shared copy. The shared entries must still match either their full
    // canonical records or the prior player-safe projection. This catches a
    // missing or changed same-ID private record before replacing shared data.
    verifyCanonicalLogReplay(publicOrLegacy, canonical);
  }

  await writeAndVerifyTransactionProjection(backingActor, canonical);
}

async function ensureStagingDefaults(stagingActor) {
  for (const flag of [
    FLAGS.HIDDEN_CURRENCY,
    FLAGS.LOOT_PREP_FOLDERS,
    FLAGS.MIGRATED_ITEM_METADATA,
    FLAGS.TRANSACTION_LOG,
    FLAGS.RECOVERY_RECORDS,
    FLAGS.OPERATION_TOMBSTONES
  ]) {
    const value = stagingActor.getFlag(MODULE_ID, flag);
    if (value == null) {
      await writeAndVerifyArrayFlag(stagingActor, flag, [], `staging-default-${flag}`);
      continue;
    }
    // An unexpected object/string may contain recoverable private data. Do not
    // replace it with an empty array just to make startup succeed.
    if (!Array.isArray(value)) throw new Error(`invalid-staging-private-data-${flag}`);
  }
}

async function verifyAndRefreshTransactionProjection(backingActor, stagingActor) {
  const shared = normalizeArray(backingActor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));
  const canonical = normalizeArray(stagingActor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));
  verifyCanonicalLogReplay(shared, canonical);
  await writeAndVerifyTransactionProjection(backingActor, canonical);
}

function verifyCanonicalLogReplay(sharedEntries, canonicalEntries) {
  // Validate the canonical collection itself, including the otherwise easy to
  // miss case where two private entries reuse an ID but disagree.
  mergeUnique([], canonicalEntries, logIdentity);

  const alwaysPublic = projectPublicTransactionLog(canonicalEntries, { enabled: true });
  const canonicalById = new Map(canonicalEntries.map(entry => [logIdentity(entry), entry]));
  const publicById = new Map(alwaysPublic.map(entry => [logIdentity(entry), entry]));

  for (const shared of sharedEntries) {
    const key = logIdentity(shared);
    const canonical = canonicalById.get(key);
    const projected = publicById.get(key);
    if (!canonical || (!deepEqual(shared, canonical) && !deepEqual(shared, projected))) {
      throw new Error(`transaction-log-record-conflict-${key}`);
    }
  }
}

async function writeAndVerifyTransactionProjection(backingActor, canonicalEntries) {
  const projected = projectPublicTransactionLog(canonicalEntries);
  await writeAndVerifyArrayFlag(
    backingActor,
    FLAGS.TRANSACTION_LOG,
    projected,
    "transaction-log-projection"
  );
}

async function writeAndVerifyArrayFlag(actor, flag, intended, label) {
  requireActiveStorageGM();
  let writeError = null;
  try {
    await actor.setFlag(MODULE_ID, flag, clone(intended));
  } catch (error) {
    writeError = error;
  }
  const verified = normalizeArray(actor.getFlag(MODULE_ID, flag));
  if (!deepEqual(intended, verified)) {
    if (writeError) throw writeError;
    throw new Error(`${label}-verification-failed`);
  }
  if (writeError) {
    console.warn(`${MODULE_TITLE} | ${label} committed despite an update error`, writeError);
  }
}

async function setVerifiedSchemaMarker(actor, label) {
  requireActiveStorageGM();
  let writeError = null;
  try {
    await actor.setFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION);
  } catch (error) {
    writeError = error;
  }

  const verified = normalizeVersion(
    actor.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION)
  );
  if (verified !== STORAGE_SCHEMA_VERSION) {
    if (writeError) throw writeError;
    throw new Error(`${label}-storage-schema-marker-verification-failed`);
  }
  if (writeError) {
    console.warn(
      `${MODULE_TITLE} | ${label} storage schema marker committed despite an update error; `
      + "the verified marker is authoritative",
      writeError
    );
  }
}

function verifyPrivateStorageCleared(backingActor) {
  const remainingItems = backingActor.items.filter(item =>
    item.getFlag(MODULE_ID, FLAGS.HIDDEN) === true
  );
  if (remainingItems.length > 0) throw new Error("hidden-items-remain-on-shared-vault");
  const metadataLeaks = backingActor.items.filter(item =>
    item.getFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE) != null
      || item.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDER) != null
  );
  if (metadataLeaks.length > 0) {
    throw new Error("loot-prep-item-metadata-remains-on-shared-vault");
  }
  if (normalizeArray(backingActor.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY)).length > 0) {
    throw new Error("hidden-currency-remains-on-shared-vault");
  }
  if (normalizeArray(backingActor.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS)).length > 0) {
    throw new Error("loot-prep-folders-remain-on-shared-vault");
  }
}

function normalizeVersion(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeState(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function normalizeArray(value) {
  return Array.isArray(value) ? clone(value) : [];
}

function mergeUnique(existing, incoming, identity) {
  const result = clone(existing);
  const seen = new Map();
  for (const entry of result) {
    const key = identity(entry);
    if (seen.has(key) && !deepEqual(seen.get(key), entry)) {
      throw new Error(`migration-record-conflict-${key}`);
    }
    if (!seen.has(key)) seen.set(key, entry);
  }
  for (const entry of incoming) {
    const key = identity(entry);
    if (seen.has(key)) {
      if (!deepEqual(seen.get(key), entry)) {
        throw new Error(`migration-record-conflict-${key}`);
      }
      continue;
    }
    const copied = clone(entry);
    seen.set(key, copied);
    result.push(copied);
  }
  return result;
}

function entryIdentity(entry) {
  return String(entry?.id ?? stableStringify(entry));
}

function logIdentity(entry) {
  if (entry?.id != null) return String(entry.id);
  if (entry?.requestId != null) {
    return `${entry.requestId}:${entry.type ?? "unknown"}:${entry.timestamp ?? "unknown"}`;
  }
  return stableStringify(entry);
}

// A key present with an `undefined` value is indistinguishable from an
// absent key once Foundry actually persists a flag - JSON has no `undefined`.
// Match that here so a benign, system-dependent `undefined` leaf isn't
// mistaken for lost or corrupted data. Array elements still become `null`,
// matching JSON.stringify.
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry) ?? "null").join(",")}]`;
  }
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}
