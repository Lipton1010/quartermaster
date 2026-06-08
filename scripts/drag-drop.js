/**
 * Quartermaster — Drag-Drop Wiring
 *
 * Connects user interactions (drag, drop) on the inventory popup and on
 * character sheets to the Claim-and-Commit transfer engine via the socket
 * pipeline.
 *
 * Two flows:
 *
 *   INGRESS — drop on popup
 *     1. User drags item from a character sheet
 *     2. Drop fires on the popup's items container
 *     3. We extract `data.uuid` from the standard Foundry drag payload
 *     4. Submit `{ action: "ingress" }` through socketHandler.submitRequest
 *     5. Result toast notifies success/failure
 *
 *   EGRESS — drag from popup
 *     1. User starts drag on a popup item row
 *     2. We set Foundry-standard drag data PLUS our `qmEgressDrag` marker
 *     3. Foundry's drop handler fires on the receiving character sheet,
 *        but our `dropActorSheetData` hook intercepts (returns false)
 *     4. We submit `{ action: "egress" }` through submitRequest
 *
 * Compendium drops are not handled here; they're a v1.1 enhancement (step
 * 14 GM Loot Prep will provide a structured "add from compendium" flow).
 *
 * All requests route through the socket pipeline regardless of whether
 * the user is a GM. The coordinator/dispatcher handles GM-vs-player
 * routing, so the same code path works from any client.
 */

import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { PAYLOAD_TYPES, submitRequest } from "./socket-handler.js";
import { getBackingActor } from "./backing-actor.js";
import { sanitizeItemForTransfer } from "./sanitization.js";
import { writeEntry } from "./transaction-log.js";

/**
 * Marker added to drag data when items are dragged FROM the popup. The
 * egress drop interceptor checks for this to decide whether to handle
 * the drop or let Foundry/dnd5e handle it normally.
 */
const QM_EGRESS_MARKER = "qmEgressDrag";

/**
 * Marker on drag data from the inventory popup for the re-hide flow.
 * The Loot Prep hidden items drop zone checks for this.
 */
export const QM_REHIDE_MARKER = "qmReHideDrag";

/**
 * Marker on drag data from the Loot Prep hidden items.
 * The inventory drop zone checks for this to trigger a reveal.
 */
export const QM_LOOTPREP_DRAG_MARKER = "qmLootPrepDrag";

// ============================================================
// Inventory popup wiring (called from InventoryApp._onRender)
// ============================================================

/**
 * Attach drag-drop handlers to the rendered inventory popup. Called from
 * InventoryApp._onRender after each render. Safe to call multiple times
 * because we don't store any per-render state (handlers are bound to
 * elements that get replaced on re-render).
 */
export function attachInventoryDragDrop(app) {
  const el = app?.element;
  if (!el) {
    console.warn(`${MODULE_TITLE} | attachInventoryDragDrop: app.element missing`);
    return;
  }

  // Drop target: the entire inventory root, so items can land anywhere in
  // the popup. The dragenter/dragover handlers add the visual highlight.
  const dropZone = el.querySelector(".quartermaster-inventory-root") ?? el;
  dropZone.addEventListener("dragenter", onPopupDragEnter);
  dropZone.addEventListener("dragover", onPopupDragOver);
  dropZone.addEventListener("dragleave", onPopupDragLeave);
  dropZone.addEventListener("drop", (event) => onPopupDrop(event, app));

  // Drag sources: each item row becomes draggable for egress.
  const itemRows = el.querySelectorAll(".qm-item-row");
  for (const row of itemRows) {
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", onItemRowDragStart);
    row.addEventListener("dragend", onItemRowDragEnd);
  }

  console.debug(
    `${MODULE_TITLE} | drag-drop attached: dropZone=${dropZone.className}, ` +
    `draggableRows=${itemRows.length}`
  );
}

// ============================================================
// Drop-on-popup handlers (ingress)
// ============================================================

function onPopupDragEnter(event) {
  // Always preventDefault on dragenter so the browser will fire dragover
  // and drop. Some browsers restrict access to drag data types during
  // dragenter for security reasons (cross-origin protection), so we can't
  // reliably gate on "is this an item drag" here. Validation happens in
  // the drop handler where we have full access to dataTransfer.getData.
  event.preventDefault();
  event.currentTarget.classList.add("qm-drop-target");
}

function onPopupDragOver(event) {
  // CRITICAL: preventDefault on dragover is what tells the browser "this
  // is a valid drop target." Without it, the drop event never fires.
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
}

function onPopupDragLeave(event) {
  // Only clear highlight when leaving the drop zone itself, not a child
  // bubbling up
  if (event.target === event.currentTarget) {
    event.currentTarget.classList.remove("qm-drop-target");
  }
}

async function onPopupDrop(event, app) {
  event.preventDefault();
  event.currentTarget.classList.remove("qm-drop-target");

  const data = parseDropData(event);
  console.debug(`${MODULE_TITLE} | drop received`, {
    hasData: !!data,
    type: data?.type,
    uuid: data?.uuid
  });

  if (!data || data.type !== "Item") {
    return;
  }

  // If our own egress drag landed back on the popup, treat as no-op
  if (data[QM_EGRESS_MARKER]) {
    return;
  }

  const sourceItem = await fromUuid(data.uuid);
  if (!sourceItem) {
    ui.notifications.warn(`${MODULE_TITLE}: dropped item could not be resolved.`);
    return;
  }

  const backingActor = getBackingActor();
  if (!backingActor) {
    ui.notifications.error(`${MODULE_TITLE}: backing actor not initialized.`);
    return;
  }

  // Loot Prep drag: item is already on the backing actor with hidden flag.
  // Reveal it (clear hidden flag) so it appears in the inventory.
  if (data[QM_LOOTPREP_DRAG_MARKER]) {
    if (!game.user.isGM) return;
    if (sourceItem.parent?.id === backingActor.id) {
      const { setItemHidden } = await import("./hidden-items.js");
      await setItemHidden(sourceItem.id, false);
      ui.notifications.info(`"${sourceItem.name}" revealed to the party.`);
      // Write a log entry
      await writeEntry({
        type: "hidden.revealed",
        requestId: `qm-reveal-drag-${sourceItem.id}-${Date.now()}`,
        userId: game.user.id,
        itemId: sourceItem.id,
        itemName: sourceItem.name,
        backingActorId: backingActor.id
      });
      return;
    }
  }

  // Compendium / world items (no actor parent): GM-only direct import
  if (!sourceItem.parent || sourceItem.parent.documentName !== "Actor") {
    if (!game.user.isGM) {
      ui.notifications.warn(
        `${MODULE_TITLE}: only the GM can add compendium items directly.`
      );
      return;
    }
    await importCompendiumItem(sourceItem, backingActor, { hidden: false });
    return;
  }

  // Self-drop: item is already on the backing actor
  if (sourceItem.parent.id === backingActor.id) {
    return;
  }

  await submitIngressRequest({ sourceItem, destActor: backingActor });
}

// ============================================================
// Drag-from-popup handlers (egress)
// ============================================================

function onItemRowDragStart(event) {
  const itemId = event.currentTarget.dataset.itemId;
  if (!itemId) return;

  const backingActor = getBackingActor();
  if (!backingActor) return;

  const item = backingActor.items.get(itemId);
  if (!item) return;

  const payload = {
    type: "Item",
    uuid: item.uuid,
    [QM_EGRESS_MARKER]: true,
    [QM_REHIDE_MARKER]: true,
    qmSourceItemUuid: item.uuid,
    qmSourceItemName: item.name
  };
  event.dataTransfer.setData("text/plain", JSON.stringify(payload));
  // Use "all" instead of "move": "move" excludes "copy", and dnd5e
  // character sheets default to dropEffect "copy" for item drags. With
  // incompatible effectAllowed/dropEffect, the browser shows the no-drop
  // cursor and the drop event never fires. "all" matches any dropEffect.
  event.dataTransfer.effectAllowed = "all";

  document.body.classList.add("qm-dragging");
  event.currentTarget.classList.add("qm-being-dragged");

  console.debug(
    `${MODULE_TITLE} | egress drag started: ${item.name} (${item.uuid})`
  );
}

function onItemRowDragEnd(event) {
  document.body.classList.remove("qm-dragging");
  event.currentTarget.classList.remove("qm-being-dragged");
}

// ============================================================
// Egress interception on character sheets
// ============================================================

/**
 * Register the dropActorSheetData hook to intercept egress drops on
 * character sheets. Called once at module ready.
 *
 * The hook fires on every drop event on every actor sheet. We check for
 * our marker, intercept if present, and return false to stop Foundry's
 * default drop handling (which would try to create the item directly
 * without going through our pipeline, leaving the source still in the
 * vault).
 */
export function registerEgressInterceptor() {
  Hooks.on("dropActorSheetData", (destActor, sheet, data) => {
    console.debug(
      `${MODULE_TITLE} | dropActorSheetData fired`,
      {
        destActorName: destActor?.name,
        hasMarker: !!data?.[QM_EGRESS_MARKER],
        dataType: data?.type,
        dataUuid: data?.uuid
      }
    );

    // Handle loot prep drags to character sheets: reveal then egress
    if (data?.[QM_LOOTPREP_DRAG_MARKER]) {
      handleLootPrepToSheetDrop(destActor, data).catch((err) => {
        console.error(`${MODULE_TITLE} | Loot prep to sheet drop failed`, err);
        ui.notifications.error(`${MODULE_TITLE}: failed to transfer item. Check the console.`);
      });
      return false;
    }

    if (!data?.[QM_EGRESS_MARKER]) return; // not ours; let default handle

    handleEgressDrop(destActor, data).catch((err) => {
      console.error(`${MODULE_TITLE} | Egress drop handler failed`, err);
      ui.notifications.error(
        `${MODULE_TITLE}: failed to transfer item. Check the console.`
      );
    });

    return false; // stop default drop handling
  });
}

async function handleEgressDrop(destActor, data) {
  if (!data.qmSourceItemUuid) {
    console.warn(`${MODULE_TITLE} | Egress drop missing source UUID`);
    return;
  }

  const sourceItem = await fromUuid(data.qmSourceItemUuid);
  if (!sourceItem) {
    ui.notifications.warn(
      `${MODULE_TITLE}: source item no longer exists in the vault.`
    );
    return;
  }

  // Sanity: source is the backing actor, dest is not
  const backingActor = getBackingActor();
  if (sourceItem.parent?.id !== backingActor?.id) {
    ui.notifications.warn(
      `${MODULE_TITLE}: source item is not in the vault.`
    );
    return;
  }
  if (destActor.id === backingActor.id) {
    return; // dropped back on the vault — no-op
  }

  await submitEgressRequest({ sourceItem, destActor });
}

/**
 * Transfer a visible Shared Party Inventory item to an actor using the same
 * egress pipeline as drag-and-drop.
 *
 * @param {string} itemId
 * @param {Actor} destActor
 * @returns {Promise<Object|null>}
 */
export async function transferInventoryItemToActor(itemId, destActor) {
  const backingActor = getBackingActor();
  if (!backingActor) {
    ui.notifications.error(`${MODULE_TITLE}: backing actor not initialized.`);
    return null;
  }
  if (!destActor) {
    ui.notifications.warn(`${MODULE_TITLE}: no character selected.`);
    return null;
  }
  if (destActor.id === backingActor.id) {
    return null;
  }

  const sourceItem = backingActor.items.get(itemId);
  if (!sourceItem) {
    ui.notifications.warn(`${MODULE_TITLE}: source item no longer exists in the vault.`);
    return null;
  }

  return await submitEgressRequest({ sourceItem, destActor });
}

async function handleLootPrepToSheetDrop(destActor, data) {
  if (!data.qmSourceItemUuid) {
    console.warn(`${MODULE_TITLE} | Loot prep drop missing source UUID`);
    return;
  }
  if (!game.user.isGM) return;

  const sourceItem = await fromUuid(data.qmSourceItemUuid);
  if (!sourceItem) {
    ui.notifications.warn(`${MODULE_TITLE}: source item no longer exists.`);
    return;
  }

  const backingActor = getBackingActor();
  if (sourceItem.parent?.id !== backingActor?.id) {
    ui.notifications.warn(`${MODULE_TITLE}: source item is not in the vault.`);
    return;
  }
  if (destActor.id === backingActor.id) return; // dropped back on vault — no-op

  // Step 1: Reveal the item (clear hidden flag)
  const { setItemHidden } = await import("./hidden-items.js");
  await setItemHidden(sourceItem.id, false);

  // Step 2: Now process as a normal egress
  await submitEgressRequest({ sourceItem, destActor });
}

// ============================================================
// Request submission helpers
// ============================================================

async function submitIngressRequest({ sourceItem, destActor }) {
  const requestId = `qm-${foundry.utils.randomID()}`;

  const result = await submitRequest({
    type: PAYLOAD_TYPES.ITEM_TRANSFER,
    requestId,
    timestamp: Date.now(),
    userId: game.user.id,
    action: "ingress",
    payload: buildTransferPayload(sourceItem, destActor)
  });

  notifyTransferResult(result, sourceItem.name, "ingress", destActor.name);
  return result;
}

async function submitEgressRequest({ sourceItem, destActor }) {
  const requestId = `qm-${foundry.utils.randomID()}`;

  const result = await submitRequest({
    type: PAYLOAD_TYPES.ITEM_TRANSFER,
    requestId,
    timestamp: Date.now(),
    userId: game.user.id,
    action: "egress",
    payload: buildTransferPayload(sourceItem, destActor)
  });

  notifyTransferResult(result, sourceItem.name, "egress", destActor.name);
  return result;
}

function buildTransferPayload(sourceItem, destActor) {
  return {
    sourceActorId: sourceItem.parent.id,
    sourceItemId: sourceItem.id,
    sourceItemUuid: sourceItem.uuid,
    sourceItemName: sourceItem.name,
    destActorId: destActor.id,
    destActorName: destActor.name
  };
}

function notifyTransferResult(result, itemName, action, destName) {
  if (!result) {
    ui.notifications.error(`${MODULE_TITLE}: transfer returned no result.`);
    return;
  }
  if (result.status === "success") {
    // For ingress, destName is the vault and "added to" reads correctly.
    // For egress, destName is the receiving character; "given to" makes
    // the direction clear without needing to reference the source name.
    const msg = action === "ingress"
      ? `${itemName} added to ${destName}.`
      : `${itemName} given to ${destName}.`;
    ui.notifications.info(msg);
    return;
  }
  const errMsg = result.error ?? result.details?.error ?? "unknown error";
  ui.notifications.error(`Transfer failed: ${errMsg}`);
}

// ============================================================
// Compendium import (step 18)
// ============================================================

/**
 * Import an item from a compendium or world directory directly onto the
 * backing actor. GM-only. Used by both the inventory drop zone and the
 * compendium context menu.
 *
 * @param {Item} sourceItem   resolved Item document
 * @param {Actor} backingActor
 * @param {Object} opts
 * @param {boolean} [opts.hidden=false]  set hidden flag (staging vs visible)
 * @returns {Promise<{status: string, item?: Item, error?: string}>}
 */
export async function importCompendiumItem(sourceItem, backingActor, opts = {}) {
  const hidden = opts.hidden ?? false;

  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | importCompendiumItem: GM-only`);
    return { status: "failed", error: "gm-only" };
  }
  if (!sourceItem || !backingActor) {
    return { status: "failed", error: "missing-arguments" };
  }

  try {
    const rawData = sourceItem.toObject();
    const sanitized = sanitizeItemForTransfer(rawData, backingActor, {
      sourceItemUuid: sourceItem.uuid
    });

    // Merge flags: hidden if staging, plus preserve any existing sanitized flags
    const flags = foundry.utils.mergeObject(
      sanitized.flags ?? {},
      hidden ? { [MODULE_ID]: { hidden: true } } : {},
      { inplace: false }
    );
    const itemData = { ...sanitized, flags };

    const [created] = await backingActor.createEmbeddedDocuments("Item", [itemData], {
      keepId: true
    });

    if (!created) {
      return { status: "failed", error: "create-returned-empty" };
    }

    // Write log entry
    const logType = hidden ? "hidden.staged" : "import.direct";
    await writeEntry({
      type: logType,
      requestId: `qm-import-${created.id}-${Date.now()}`,
      userId: game.user.id,
      itemId: created.id,
      itemName: created.name ?? "(unknown)",
      backingActorId: backingActor.id,
      sourceUuid: sourceItem.uuid
    });

    const dest = hidden ? "GM staging" : "party inventory";
    ui.notifications.info(`"${created.name}" added to ${dest}.`);
    console.debug(`${MODULE_TITLE} | importCompendiumItem: "${created.name}" → ${dest}`);
    return { status: "success", item: created };
  } catch (err) {
    console.error(`${MODULE_TITLE} | importCompendiumItem error`, err);
    ui.notifications.error(`${MODULE_TITLE}: import failed — ${err.message}`);
    return { status: "failed", error: String(err.message ?? err) };
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Parse drag data from a drop event. Tries text/plain first, falls back
 * to other common formats. Returns null on parse failure.
 *
 * In some Foundry/dnd5e drag flows the data may have been set with a
 * different MIME type or as raw JSON. We try the common variants in
 * order.
 */
function parseDropData(event) {
  const sources = [
    event.dataTransfer?.getData("text/plain"),
    event.dataTransfer?.getData("application/json"),
    event.dataTransfer?.getData("text")
  ];
  for (const raw of sources) {
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      // try the next source
    }
  }
  return null;
}
