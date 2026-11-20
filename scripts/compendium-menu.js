/**
 * Quartermaster — Compendium Context Menu (step 18)
 *
 * Adds Quartermaster options to Foundry's *native* context menu on entries
 * inside an opened Item compendium pack:
 *   - "Send to Party Inventory"  (visible on backing actor)
 *   - "Send to GM Staging"       (hidden on backing actor)
 *
 * GM-only: options only appear for GM users.
 *
 * Foundry 14.370 fires getItemContextOptions(application, menuItems) for Item
 * entry menus. Appending to that array preserves the native Import and Delete
 * actions and their permission checks. The old row handler stopped contextmenu
 * propagation before Foundry could open its native menu (issue #6).
 */

import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { importCompendiumItem } from "./drag-drop.js";

const LABELS = {
  party: "Send to Party Inventory",
  staging: "Send to GM Staging"
};

/**
 * Register the hooks that inject Quartermaster options into the native
 * compendium entry context menu. Called once at module ready.
 */
export function registerCompendiumContextMenu() {
  Hooks.on("getItemContextOptions", (application, menuItems) => {
    if (!game.user.isGM) return;
    if (!isItemCompendiumWindow(application)) return;
    if (!Array.isArray(menuItems)) return;

    // Never register the same option twice on one menu array.
    const marker = `${MODULE_ID}-compendium-send`;
    if (menuItems.some(item => item?.classes === marker)) return;

    menuItems.push({
      label: LABELS.party,
      icon: "fa-solid fa-box-archive",
      group: "quartermaster",
      classes: marker,
      onClick: (event, li) => handleAction("send-to-inventory", application, li)
    }, {
      label: LABELS.staging,
      icon: "fa-solid fa-eye-slash",
      group: "quartermaster",
      classes: marker,
      onClick: (event, li) => handleAction("send-to-staging", application, li)
    });
  });
}

/**
 * True only for an opened compendium pack window holding Item entries.
 * The world Items sidebar (ItemDirectory) and every non-Item pack are left
 * untouched: their native menus are not modified by this module.
 *
 * @param {ApplicationV2} application  The application that fired the hook
 * @returns {boolean}
 */
function isItemCompendiumWindow(application) {
  const pack = application?.collection;
  return application?.documentName === "Item"
    && pack?.documentName === "Item"
    && application instanceof foundry.applications.sidebar.apps.Compendium;
}

/**
 * Resolve the right-clicked row's Item from the pack and hand it to the
 * existing transfer logic.
 *
 * @param {string} action        "send-to-inventory" or "send-to-staging"
 * @param {ApplicationV2} application  Compendium window the menu came from
 * @param {HTMLElement} li       The directory row Foundry opened the menu on
 */
async function handleAction(action, application, li) {
  if (!game.user.isGM) return;

  const pack = application?.collection;
  const entryId = li?.closest?.("[data-entry-id]")?.dataset?.entryId;
  if (!pack || !entryId) {
    ui.notifications.warn(`${MODULE_TITLE}: could not identify the compendium entry.`);
    return;
  }

  const backingActor = getBackingActor();
  if (!backingActor) {
    ui.notifications.error(`${MODULE_TITLE}: no backing actor configured.`);
    return;
  }

  let item;
  try {
    item = await pack.getDocument(entryId);
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
    case "send-to-staging":
      await importCompendiumItem(item, backingActor, { hidden: true });
      break;
    default:
      console.warn(`${MODULE_TITLE} | unknown compendium action: ${action}`);
  }
}
