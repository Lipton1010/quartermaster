/**
 * Quartermaster — Sidebar Button Injection
 *
 * Injects two action buttons at the top of the Actors directory sidebar:
 *
 *   1. "Shared Party Inventory" — visible to all users; opens the main popup
 *   2. "GM Loot Prep"           — visible only to GMs; opens the loot prep popup
 *
 * Triggered by the renderActorDirectory hook, which fires every time the
 * Actors tab renders (initial load, filter change, document update). The
 * injection is idempotent: a re-render that already has our buttons present
 * is a no-op.
 *
 * Compatible with both Foundry V14's ApplicationV2 directory (HTMLElement
 * passed to the hook) and earlier jQuery-wrapped versions.
 */

import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { openInventoryApp } from "./apps/inventory-app.js";
import { openLootPrepApp } from "./apps/loot-prep-app.js";
import { openTransactionLogApp } from "./apps/transaction-log-app.js";
import { canUserAccessLog } from "./transaction-log-query.js";

const CONTAINER_CLASS = "quartermaster-sidebar-actions";
const BUTTON_CLASS = "quartermaster-sidebar-btn";

/**
 * Inject the Quartermaster buttons into the Actors directory header.
 * Called from the renderActorDirectory hook in module.js.
 *
 * @param {ActorDirectory} app
 * @param {HTMLElement|jQuery} html
 */
export function injectSidebarButtons(app, html) {
  const rootEl = normalizeHtml(html);
  if (!rootEl) return;

  // Idempotency: skip if our container is already present
  if (rootEl.querySelector(`.${CONTAINER_CLASS}`)) return;

  // Find the directory header. V14 ApplicationV2 directories use
  // `.directory-header`; older versions use `header.directory-header`
  // or `header`. Try a few selectors before giving up.
  const header = rootEl.querySelector(".directory-header")
              ?? rootEl.querySelector("header.directory-header")
              ?? rootEl.querySelector("header");

  if (!header) {
    console.warn(
      `${MODULE_TITLE} | Could not locate directory header in Actors sidebar; ` +
      `button injection skipped`
    );
    return;
  }

  const container = document.createElement("div");
  container.classList.add(CONTAINER_CLASS);

  // Shared Party Inventory — visible to all users
  container.appendChild(buildButton({
    cssClass: "qm-btn-inventory",
    icon: "fa-solid fa-box-archive",
    labelKey: "quartermaster.buttons.sharedPartyInventory",
    onClick: handleInventoryClick
  }));

  // GM Loot Prep — visible only to GMs
  if (game.user.isGM) {
    container.appendChild(buildButton({
      cssClass: "qm-btn-lootprep",
      icon: "fa-solid fa-coins",
      labelKey: "quartermaster.buttons.gmLootPrep",
      onClick: handleLootPrepClick
    }));
  }

  // Transaction Log — visible based on transactionLogVisibility setting
  // GMs always see it; players see it when setting is "all"
  if (canUserAccessLog(game.user)) {
    container.appendChild(buildButton({
      cssClass: "qm-btn-log",
      icon: "fa-solid fa-list-check",
      labelKey: "quartermaster.buttons.log",
      onClick: handleLogClick
    }));
  }

  // Insert at the very top of the header so our buttons sit above the
  // existing Create Actor / Create Folder controls.
  header.insertBefore(container, header.firstChild);
}

function buildButton({ cssClass, icon, labelKey, onClick }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.classList.add(BUTTON_CLASS, cssClass);
  btn.setAttribute("data-quartermaster-action", labelKey);

  const iconEl = document.createElement("i");
  iconEl.className = icon;
  iconEl.setAttribute("aria-hidden", "true");
  btn.appendChild(iconEl);

  const labelEl = document.createElement("span");
  labelEl.textContent = game.i18n.localize(labelKey);
  btn.appendChild(labelEl);

  btn.addEventListener("click", onClick);
  return btn;
}

function handleInventoryClick(event) {
  event?.preventDefault?.();
  try {
    openInventoryApp();
  } catch (err) {
    console.error(`${MODULE_TITLE} | Failed to open inventory app`, err);
    ui.notifications.error(
      `${MODULE_TITLE}: could not open Shared Party Inventory. ` +
      `Check the console for details.`
    );
  }
}

function handleLootPrepClick(event) {
  event?.preventDefault?.();
  if (!game.user.isGM) return;
  try {
    openLootPrepApp();
  } catch (err) {
    console.error(`${MODULE_TITLE} | Failed to open loot prep app`, err);
    ui.notifications.error(
      `${MODULE_TITLE}: could not open GM Loot Prep. ` +
      `Check the console for details.`
    );
  }
}

function handleLogClick(event) {
  event?.preventDefault?.();
  try {
    openTransactionLogApp();
  } catch (err) {
    console.error(`${MODULE_TITLE} | Failed to open transaction log`, err);
    ui.notifications.error(
      `${MODULE_TITLE}: could not open Transaction Log. ` +
      `Check the console for details.`
    );
  }
}

/**
 * Normalize the html argument from renderActorDirectory to a raw HTMLElement.
 * V14 ApplicationV2 passes HTMLElement; older versions pass jQuery.
 */
function normalizeHtml(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}
