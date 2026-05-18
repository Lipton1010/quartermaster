/**
 * Quartermaster — Hidden Items (step 15)
 *
 * GM-only helpers for the hidden loot staging pool:
 *
 *   getHiddenItems(actor)          pure read; no GM check needed
 *   setItemHidden(itemId, hidden)  sets or clears the hidden flag
 *   revealItem(itemId, opts)       clears flag; optionally announces
 *   revealItems(itemIds, opts)     batched; resolves in parallel
 *
 * These operate directly on items inside the backing actor's inventory.
 * They do NOT go through the socket pipeline — they are always called
 * from the GM client (LootPrepApp action handlers, bulk-reveal flow).
 *
 * Transaction log entries written here use the single-phase pattern
 * (no claim/commit pair) because hidden-item operations are atomic
 * single-document writes with no cross-actor coordination needed.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { writeEntry } from "./transaction-log.js";

// ============================================================
// Read
// ============================================================

/**
 * Return all items on the given actor that carry the hidden flag.
 * Sorted by item name ascending for stable list ordering.
 *
 * @param {Actor} actor
 * @returns {Item[]}
 */
export function getHiddenItems(actor) {
  if (!actor) return [];
  return actor.items
    .filter(i => i.getFlag(MODULE_ID, FLAGS.HIDDEN) === true)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

// ============================================================
// Write
// ============================================================

/**
 * Set or clear the hidden flag on a single item.
 * GM-only (R-1).
 *
 * @param {string} itemId   item id on the backing actor
 * @param {boolean} hidden  true = hide; false = reveal
 * @returns {Promise<Item|null>}  the updated item, or null
 */
export async function setItemHidden(itemId, hidden) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | setItemHidden: GM-only`);
    return null;
  }
  const actor = getBackingActor();
  if (!actor) {
    console.warn(`${MODULE_TITLE} | setItemHidden: no backing actor`);
    return null;
  }
  const item = actor.items.get(itemId);
  if (!item) {
    console.warn(`${MODULE_TITLE} | setItemHidden: item ${itemId} not found`);
    return null;
  }
  await item.setFlag(MODULE_ID, FLAGS.HIDDEN, hidden);
  return item;
}

/**
 * Reveal a single hidden item: clear its hidden flag, write a log entry,
 * and optionally announce via a chat message.
 *
 * @param {string} itemId
 * @param {Object} [opts]
 * @param {boolean} [opts.announce=false]  post a chat message on reveal
 * @param {boolean} [opts.mergeCurrency=false]  stub for Phase 2 currency merge
 * @returns {Promise<{status: "success"|"failed", itemId?, itemName?, error?}>}
 */
export async function revealItem(itemId, opts = {}) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | revealItem: GM-only`);
    return { status: "failed", error: "gm-only" };
  }
  const actor = getBackingActor();
  if (!actor) {
    return { status: "failed", error: "no-backing-actor" };
  }
  const item = actor.items.get(itemId);
  if (!item) {
    return { status: "failed", itemId, error: "item-not-found" };
  }

  const itemName = item.name ?? "(unknown)";

  try {
    // Clear the hidden flag — this fires an updateItem hook which will
    // trigger the inventory popup auto-refresh (existing hook in inventory-app.js)
    await item.unsetFlag(MODULE_ID, FLAGS.HIDDEN);

    // Write transaction log entry
    await writeEntry({
      type: "hidden.revealed",
      requestId: `qm-reveal-${itemId}-${Date.now()}`,
      userId: game.user.id,
      itemId,
      itemName,
      backingActorId: actor.id
    });

    // Optional chat announcement
    if (opts.announce) {
      await _announceReveal(itemName, item);
    }

    // Phase 2 stub: currency merge
    if (opts.mergeCurrency) {
      console.debug(
        `${MODULE_TITLE} | revealItem: currency merge stub — not yet implemented`
      );
    }

    console.debug(`${MODULE_TITLE} | revealItem: revealed "${itemName}" (${itemId})`);
    return { status: "success", itemId, itemName };
  } catch (err) {
    console.error(`${MODULE_TITLE} | revealItem: error for ${itemId}`, err);
    return { status: "failed", itemId, itemName, error: String(err.message ?? err) };
  }
}

/**
 * Reveal multiple hidden items in parallel. Resolves once all individual
 * revealItem calls complete (partial failures are captured per-item).
 *
 * @param {string[]} itemIds
 * @param {Object} [opts]  forwarded to each revealItem call
 * @returns {Promise<{results: Array, successCount: number, failCount: number}>}
 */
export async function revealItems(itemIds, opts = {}) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return { results: [], successCount: 0, failCount: 0 };
  }
  const results = await Promise.all(itemIds.map(id => revealItem(id, opts)));
  const successCount = results.filter(r => r.status === "success").length;
  const failCount = results.filter(r => r.status !== "success").length;
  return { results, successCount, failCount };
}

/**
 * Permanently delete a hidden item from the backing actor without revealing
 * it. Writes a hidden.deleted log entry.
 *
 * @param {string} itemId
 * @returns {Promise<{status: "success"|"failed", itemId?, itemName?, error?}>}
 */
export async function deleteHiddenItem(itemId) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | deleteHiddenItem: GM-only`);
    return { status: "failed", error: "gm-only" };
  }
  const actor = getBackingActor();
  if (!actor) {
    return { status: "failed", error: "no-backing-actor" };
  }
  const item = actor.items.get(itemId);
  if (!item) {
    return { status: "failed", itemId, error: "item-not-found" };
  }

  const itemName = item.name ?? "(unknown)";

  try {
    await actor.deleteEmbeddedDocuments("Item", [itemId]);

    await writeEntry({
      type: "hidden.deleted",
      requestId: `qm-hidden-delete-${itemId}-${Date.now()}`,
      userId: game.user.id,
      itemId,
      itemName,
      backingActorId: actor.id
    });

    console.debug(`${MODULE_TITLE} | deleteHiddenItem: deleted "${itemName}" (${itemId})`);
    return { status: "success", itemId, itemName };
  } catch (err) {
    console.error(`${MODULE_TITLE} | deleteHiddenItem: error for ${itemId}`, err);
    return { status: "failed", itemId, itemName, error: String(err.message ?? err) };
  }
}

/**
 * Stage a new hidden item onto the backing actor from raw item data
 * (typically a compendium drop). Caller is responsible for sanitizing the
 * data before passing it here.
 *
 * @param {Object} sanitizedData  output of sanitizeItemForTransfer()
 * @returns {Promise<{status: "success"|"failed", item?, error?}>}
 */
export async function stageHiddenItem(sanitizedData) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | stageHiddenItem: GM-only`);
    return { status: "failed", error: "gm-only" };
  }
  const actor = getBackingActor();
  if (!actor) {
    return { status: "failed", error: "no-backing-actor" };
  }

  // Merge hidden flag into the data before create
  const dataWithFlag = foundry.utils.mergeObject(
    foundry.utils.deepClone(sanitizedData),
    { flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } } },
    { inplace: false }
  );

  try {
    const [created] = await actor.createEmbeddedDocuments("Item", [dataWithFlag], {
      keepId: true
    });

    if (!created) {
      return { status: "failed", error: "create-returned-empty" };
    }

    await writeEntry({
      type: "hidden.staged",
      requestId: `qm-hidden-staged-${created.id}-${Date.now()}`,
      userId: game.user.id,
      itemId: created.id,
      itemName: created.name ?? "(unknown)",
      backingActorId: actor.id
    });

    console.debug(`${MODULE_TITLE} | stageHiddenItem: staged "${created.name}" (${created.id})`);
    return { status: "success", item: created };
  } catch (err) {
    console.error(`${MODULE_TITLE} | stageHiddenItem: error`, err);
    return { status: "failed", error: String(err.message ?? err) };
  }
}

// ============================================================
// Private helpers
// ============================================================

async function _announceReveal(itemName, item) {
  try {
    const imgTag = item.img
      ? `<img src="${item.img}" alt="" style="width:36px;height:36px;object-fit:contain;vertical-align:middle;margin-right:6px;">`
      : "";
    await ChatMessage.create({
      content: `<div style="display:flex;align-items:center;">${imgTag}<strong>${itemName}</strong> has been added to the party inventory.</div>`,
      speaker: { alias: "Quartermaster" }
    });
  } catch (err) {
    console.warn(`${MODULE_TITLE} | revealItem: announce failed`, err);
  }
}
