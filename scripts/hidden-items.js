/** GM-only hidden item operations backed by the private staging actor. */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor, getStagingActor } from "./backing-actor.js";
import { writeEntry } from "./transaction-log.js";
import { writeRecoveryRecord } from "./recovery-records.js";
import {
  isActiveStorageGM,
  requireActiveStorageGM,
  withStorageLedgerLock
} from "./storage-ledger.js";

/**
 * Return private staged items. During an interrupted schema-0 migration,
 * legacy hidden items still on the supplied/shared actor are included too.
 */
export function getHiddenItems(actor = getStagingActor()) {
  const staging = getStagingActor();
  const actors = [];
  if (staging) actors.push(staging);
  if (actor && !actors.some(candidate => candidate.id === actor.id)) actors.push(actor);

  const seen = new Set();
  const items = [];
  for (const source of actors) {
    for (const item of source.items ?? []) {
      if (item.getFlag?.(MODULE_ID, FLAGS.HIDDEN) !== true) continue;
      const key = item.uuid ?? `${source.id}.${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return items.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

/**
 * Hide/reveal by moving the Item between the shared and private actors.
 * The destination is created first; source deletion is compensated if needed.
 */
export async function setItemHidden(itemId, hidden) {
  if (!isActiveStorageGM()) {
    console.warn(`${MODULE_TITLE} | setItemHidden: active GM only`);
    return null;
  }
  const backing = getBackingActor();
  const staging = getStagingActor();
  if (!backing || !staging) {
    console.warn(`${MODULE_TITLE} | setItemHidden: storage actors unavailable`);
    return null;
  }

  let outcome;
  try {
    outcome = await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      // Resolve inside the critical section. Two rapid clicks must observe the
      // first completed move instead of both creating a destination copy.
      const inBacking = backing.items.get(itemId);
      const inStaging = staging.items.get(itemId);
      if (hidden) {
        if (inStaging) {
          if (inStaging.getFlag(MODULE_ID, FLAGS.HIDDEN) !== true) {
            await inStaging.setFlag(MODULE_ID, FLAGS.HIDDEN, true);
          }
          return { item: inStaging, recoveryRecord: null };
        }
        if (!inBacking) return { item: null, recoveryRecord: null };
        return moveStorageItemUnlocked(inBacking, staging, { hidden: true, operation: "hide" });
      }

      if (inBacking) {
        if (inBacking.getFlag(MODULE_ID, FLAGS.HIDDEN) === true) {
          await inBacking.unsetFlag(MODULE_ID, FLAGS.HIDDEN);
        }
        return { item: inBacking, recoveryRecord: null };
      }
      if (!inStaging) return { item: null, recoveryRecord: null };
      return moveStorageItemUnlocked(inStaging, backing, { hidden: false, operation: "reveal" });
    });
  } catch (error) {
    console.error(`${MODULE_TITLE} | setItemHidden failed`, error);
    return null;
  }

  // Recovery records use the same non-reentrant storage ledger. Persist them
  // only after the Item-move critical section has been released.
  if (outcome?.recoveryRecord) await writeRecoveryRecord(outcome.recoveryRecord);
  return outcome?.item ?? null;
}

export async function revealItem(itemId, opts = {}) {
  if (!isActiveStorageGM()) return { status: "failed", error: "active-gm-only" };
  const source = findHiddenItem(itemId);
  if (!source) return { status: "failed", itemId, error: "item-not-found" };
  const itemName = source.name ?? "(unknown)";

  try {
    const revealed = await setItemHidden(itemId, false);
    if (!revealed) return { status: "failed", itemId, itemName, error: "move-failed" };
    await writeEntry({
      type: "hidden.revealed",
      requestId: `qm-reveal-${itemId}-${Date.now()}`,
      userId: game.user.id,
      itemId: revealed.id,
      itemName,
      backingActorId: getBackingActor()?.id
    });
    if (opts.announce) await announceReveal(itemName, revealed);
    return { status: "success", itemId: revealed.id, itemName, item: revealed };
  } catch (error) {
    console.error(`${MODULE_TITLE} | revealItem: error for ${itemId}`, error);
    return { status: "failed", itemId, itemName, error: String(error?.message ?? error) };
  }
}

export async function revealItems(itemIds, opts = {}) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return { results: [], successCount: 0, failCount: 0 };
  }
  // Sequential moves avoid embedded-document ID races in some systems.
  const results = [];
  for (const id of itemIds) results.push(await revealItem(id, opts));
  return {
    results,
    successCount: results.filter(result => result.status === "success").length,
    failCount: results.filter(result => result.status !== "success").length
  };
}

export async function deleteHiddenItem(itemId) {
  if (!isActiveStorageGM()) return { status: "failed", error: "active-gm-only" };
  try {
    const deleted = await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      const item = findHiddenItem(itemId);
      if (!item) return { status: "failed", itemId, error: "item-not-found" };
      const itemName = item.name ?? "(unknown)";
      let deleteWarning = null;
      try {
        await item.parent.deleteEmbeddedDocuments("Item", [item.id]);
        if (item.parent.items?.get?.(item.id)) {
          throw new Error("delete-did-not-remove-item");
        }
      } catch (deleteError) {
        // Embedded-document hooks may throw after Foundry has already committed
        // the deletion. Treat that as success so callers do not claim the
        // private Item still exists or try to delete a replacement copy.
        if (typeof item.parent.items?.get === "function"
            && !item.parent.items.get(item.id)) {
          deleteWarning = String(deleteError?.message ?? deleteError);
          console.warn(`${MODULE_TITLE} | hidden item delete reported an error after removal`, deleteError);
        } else {
          throw deleteError;
        }
      }
      return { status: "success", itemId, itemName, deleteWarning };
    });
    if (deleted.status !== "success") return deleted;
    await writeEntry({
      type: "hidden.deleted",
      requestId: `qm-hidden-delete-${itemId}-${Date.now()}`,
      userId: game.user.id,
      itemId,
      itemName: deleted.itemName,
      backingActorId: getBackingActor()?.id
    });
    return {
      status: "success",
      itemId,
      itemName: deleted.itemName,
      ...(deleted.deleteWarning
        ? { warning: "delete-hook-error-after-removal", detail: deleted.deleteWarning }
        : {})
    };
  } catch (error) {
    console.error(`${MODULE_TITLE} | deleteHiddenItem: error for ${itemId}`, error);
    return { status: "failed", itemId, error: String(error?.message ?? error) };
  }
}

export async function stageHiddenItem(sanitizedData) {
  if (!isActiveStorageGM()) return { status: "failed", error: "active-gm-only" };
  const staging = getStagingActor();
  if (!staging) return { status: "failed", error: "no-staging-actor" };

  const data = clone(sanitizedData);
  data.flags ??= {};
  data.flags[MODULE_ID] = {
    ...(data.flags[MODULE_ID] ?? {}),
    [FLAGS.HIDDEN]: true
  };
  try {
    const created = await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      const [item] = await staging.createEmbeddedDocuments("Item", [data], { keepId: true });
      return item ?? null;
    });
    if (!created) return { status: "failed", error: "create-returned-empty" };
    await writeEntry({
      type: "hidden.staged",
      requestId: `qm-hidden-staged-${created.id}-${Date.now()}`,
      userId: game.user.id,
      itemId: created.id,
      itemName: created.name ?? "(unknown)",
      backingActorId: getBackingActor()?.id
    });
    return { status: "success", item: created };
  } catch (error) {
    console.error(`${MODULE_TITLE} | stageHiddenItem: error`, error);
    return { status: "failed", error: String(error?.message ?? error) };
  }
}

function findHiddenItem(itemId) {
  const stagingItem = getStagingActor()?.items.get(itemId);
  if (stagingItem?.getFlag(MODULE_ID, FLAGS.HIDDEN) === true) return stagingItem;
  const legacy = getBackingActor()?.items.get(itemId);
  return legacy?.getFlag(MODULE_ID, FLAGS.HIDDEN) === true ? legacy : null;
}

async function moveStorageItemUnlocked(sourceItem, destinationActor, { hidden, operation }) {
  requireActiveStorageGM();
  const sourceActor = sourceItem.parent;
  const requestId = `qm-storage-${operation}-${sourceItem.id}-${Date.now()}`;
  const data = clone(sourceItem.toObject());
  data.flags ??= {};
  data.flags[MODULE_ID] = { ...(data.flags[MODULE_ID] ?? {}) };
  if (hidden) data.flags[MODULE_ID][FLAGS.HIDDEN] = true;
  else {
    // Loot-prep organization and notes are private staging metadata and must
    // never ride along on the player-readable revealed Item.
    delete data.flags[MODULE_ID][FLAGS.HIDDEN];
    delete data.flags[MODULE_ID][FLAGS.LOOT_PREP_NOTE];
    delete data.flags[MODULE_ID][FLAGS.LOOT_PREP_FOLDER];
    delete data.flags[MODULE_ID].migrationSourceUuid;
  }

  let created = null;
  try {
    requireActiveStorageGM();
    [created] = await destinationActor.createEmbeddedDocuments("Item", [data], { keepId: true });
    if (!created) throw new Error("create-returned-empty");
    try {
      requireActiveStorageGM();
      await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
      if (sourceActor.items?.get?.(sourceItem.id)) {
        throw new Error("source-delete-did-not-remove-item");
      }
    } catch (deleteError) {
      // Hooks can throw after Foundry has already removed the source. In that
      // case the move succeeded and deleting the destination would destroy
      // the only surviving copy.
      if (typeof sourceActor.items?.get === "function"
          && !sourceActor.items.get(sourceItem.id)) {
        console.warn(`${MODULE_TITLE} | ${operation} source delete reported an error after removal`, deleteError);
        return { item: created, recoveryRecord: null };
      }
      throw deleteError;
    }
    return { item: created, recoveryRecord: null };
  } catch (error) {
    let compensationError = null;
    if (created) {
      try {
        requireActiveStorageGM();
        await destinationActor.deleteEmbeddedDocuments("Item", [created.id]);
        if (destinationActor.items?.get?.(created.id)) {
          throw new Error("compensation-delete-did-not-remove-item");
        }
      } catch (compensationFailure) {
        const destinationGone = typeof destinationActor.items?.get === "function"
          && !destinationActor.items.get(created.id);
        if (!destinationGone) compensationError = compensationFailure;
      }
    }
    const recoveryRecord = compensationError
      ? {
        requestId,
        operation: `storage.${operation}`,
        status: "failed",
        sourceActorUuid: sourceActor?.uuid,
        destinationActorUuid: destinationActor?.uuid,
        sourceItemUuid: sourceItem.uuid,
        createdItemUuid: created?.uuid,
        itemSnapshot: data,
        error: String(error?.message ?? error),
        compensationError: String(compensationError?.message ?? compensationError)
      }
      : null;
    console.error(`${MODULE_TITLE} | ${operation} move failed`, error);
    return { item: null, recoveryRecord };
  }
}

async function announceReveal(itemName, item) {
  try {
    requireActiveStorageGM();
    const imgTag = item.img
      ? `<img src="${item.img}" alt="" style="width:36px;height:36px;object-fit:contain;vertical-align:middle;margin-right:6px;">`
      : "";
    await ChatMessage.create({
      content: `<div style="display:flex;align-items:center;">${imgTag}<strong>${itemName}</strong> has been added to the party inventory.</div>`,
      speaker: { alias: MODULE_TITLE }
    });
  } catch (error) {
    console.warn(`${MODULE_TITLE} | revealItem: announce failed`, error);
  }
}

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}
