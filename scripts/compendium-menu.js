/**
 * Quartermaster — Compendium Context Menu (step 18)
 *
 * Injects Quartermaster options into compendium item context menus:
 *   - "Send to Party Inventory"  (visible on backing actor)
 *   - "Send to GM Staging"       (private staging actor)
 *
 * GM-only: options only appear for GM users.
 *
 * Adds entries to Foundry's Item context menu without replacing its actions.
 */

import { MODULE_TITLE } from "./constants.js";
import { getBackingActor, getStagingActor } from "./backing-actor.js";
import { importCompendiumItem } from "./drag-drop.js";
import { stageHiddenItem } from "./hidden-items.js";
import { isActiveStorageGM, requireActiveStorageGM } from "./storage-ledger.js";
import { sanitizeItemForTransfer } from "./sanitization.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";


/**
 * Register hooks to inject context menu on compendium item entries.
 * Called once at module ready.
 */
export function registerCompendiumContextMenu() {
  Hooks.on("getItemContextOptions", (app, entries) => {
    const pack = app.collection;
    if (pack?.documentName !== "Item" || game.packs?.get(pack.collection) !== pack) return;
    entries.push(
      {
        name: "Send to Party Inventory",
        icon: '<i class="fa-solid fa-box-archive"></i>',
        group: "quartermaster",
        condition: () => isActiveStorageGM(),
        callback: row => handleAction("send-to-inventory", pack, row.dataset.entryId)
      },
      {
        name: "Send to GM Staging",
        icon: '<i class="fa-solid fa-eye-slash"></i>',
        group: "quartermaster",
        condition: () => isActiveStorageGM(),
        callback: row => handleAction("send-to-staging", pack, row.dataset.entryId)
      }
    );
  });
}

async function handleAction(action, pack, docId) {
  if (!isActiveStorageGM()) return;
  requireActiveStorageGM();

  const backingActor = getBackingActor();
  const stagingActor = getStagingActor();
  if (!backingActor || !stagingActor) {
    ui.notifications.error(`${MODULE_TITLE}: Quartermaster storage is unavailable.`);
    return;
  }

  let item;
  try {
    item = await pack.getDocument(docId);
  } catch (err) {
    ui.notifications.error(`${MODULE_TITLE}: failed to load item — ${err.message}`);
    return;
  }

  if (!item) {
    ui.notifications.warn(`${MODULE_TITLE}: item not found in compendium.`);
    return;
  }

  switch (action) {
    case "send-to-inventory":
      await importCompendiumItem(item, backingActor, { hidden: false });
      break;
    case "send-to-staging": {
      const adapter = getActiveSystemAdapter();
      if (!adapter.canReceiveItem(item, stagingActor)) {
        ui.notifications.warn(`${MODULE_TITLE}: this item is not compatible with GM staging.`);
        break;
      }
      try {
        const sanitized = sanitizeItemForTransfer(item.toObject(), stagingActor, {
          sourceItem: item,
          sourceItemUuid: item.uuid,
          preserveHiddenFlag: false,
          adapter
        });
        const result = await stageHiddenItem(sanitized);
        if (result.status === "success") {
          ui.notifications.info(`"${result.item.name}" added to GM staging.`);
        } else {
          ui.notifications.error(`${MODULE_TITLE}: staging failed — ${result.error}`);
        }
      } catch (error) {
        console.error(`${MODULE_TITLE} | compendium staging failed`, error);
        ui.notifications.error(`${MODULE_TITLE}: staging failed — ${error.message}`);
      }
      break;
    }
    default:
      console.warn(`${MODULE_TITLE} | unknown compendium action: ${action}`);
  }
}
