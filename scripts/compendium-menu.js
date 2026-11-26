/**
 * Extend the native Item compendium menu with imports to Quartermaster storage.
 */
import { MODULE_TITLE } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { importCompendiumItem } from "./drag-drop.js";
import { isActiveStorageGM } from "./storage-ledger.js";

export function registerCompendiumContextMenu() {
  Hooks.on("getItemContextOptions", (app, entries) => {
    const pack = app?.collection;
    if (pack?.documentName !== "Item" || game.packs?.get(pack.collection) !== pack) return;
    if (!Array.isArray(entries) || entries.some(entry => entry.group === "quartermaster")) return;

    for (const [hidden, label, icon] of [
      [false, "Send to Party Inventory", "fa-box-archive"],
      [true, "Send to GM Staging", "fa-eye-slash"]
    ]) {
      const importRow = async row => {
        if (!isActiveStorageGM()) return;
        const id = row?.closest?.("[data-entry-id]")?.dataset.entryId ?? row?.dataset?.entryId;
        if (!id) return;
        try {
          const item = await pack.getDocument(id);
          if (!item) {
            ui.notifications.warn(`${MODULE_TITLE}: item not found in compendium.`);
            return;
          }
          const actor = getBackingActor();
          if (!actor) {
            ui.notifications.error(`${MODULE_TITLE}: Quartermaster storage is unavailable.`);
            return;
          }
          await importCompendiumItem(item, actor, { hidden });
        } catch (error) {
          ui.notifications.error(`${MODULE_TITLE}: failed to load compendium item - ${error.message}`);
        }
      };
      // The native ContextMenu entry and callback signatures changed in v14.
      entries.push(game.release?.generation >= 14 ? {
        label, icon: `fa-solid ${icon}`, group: "quartermaster",
        visible: () => isActiveStorageGM(), onClick: (_event, row) => importRow(row)
      } : {
        name: label, icon: `<i class="fa-solid ${icon}"></i>`, group: "quartermaster",
        condition: () => isActiveStorageGM(), callback: row => importRow(row?.[0] ?? row)
      });
    }
  });
}
