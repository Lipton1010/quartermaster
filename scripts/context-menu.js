/**
 * Quartermaster — Inventory Context Menu (step 16)
 *
 * Provides a right-click context menu on item rows in the Shared Party
 * Inventory popup. GM-only actions:
 *
 *   - Hide (send to Loot Prep)  — sets the hidden flag, moves item out of
 *                                  the visible inventory back into the
 *                                  hidden staging pool
 *   - Delete Item               — permanently removes the item from the
 *                                  backing actor entirely
 *
 * The menu is built from scratch on each right-click so it reflects the
 * current GM state without stale data. Only rendered for GM clients;
 * non-GM right-clicks are ignored.
 *
 * Singleton: only one menu is open at a time. Clicking outside or opening
 * a second menu closes the previous one.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { setItemHidden } from "./hidden-items.js";
import { writeEntry } from "./transaction-log.js";

// ============================================================
// Internal state
// ============================================================

let _activeMenu = null;

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// Public: attach right-click listener to inventory popup
// ============================================================

/**
 * Wire contextmenu listener on every .qm-item-row in the rendered popup.
 * Called from InventoryApp._onRender after each render pass.
 *
 * @param {InventoryApp} app
 */
export function attachInventoryContextMenu(app) {
  if (!game.user.isGM) return; // players never get the menu

  const el = app?.element;
  if (!el) return;

  const rows = el.querySelectorAll(".qm-item-row");
  for (const row of rows) {
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openContextMenu(event, row, app);
    });
  }
}

// ============================================================
// Menu open / close
// ============================================================

function openContextMenu(event, row, app) {
  closeContextMenu(); // close any existing menu first

  const itemId   = row.dataset.itemId;
  const itemName = row.querySelector(".qm-item-name")?.textContent?.trim() ?? "(item)";

  const menu = document.createElement("div");
  menu.className = "quartermaster qm-context-menu";
  menu.innerHTML = `
    <ul class="qm-context-menu-list">
      <li class="qm-context-menu-item" data-action="hide-item" data-item-id="${escapeHtml(itemId)}">
        <i class="fa-solid fa-eye-slash"></i>
        Hide (send to Loot Prep)
      </li>
      <li class="qm-context-menu-item qm-context-menu-danger" data-action="delete-item" data-item-id="${escapeHtml(itemId)}" data-item-name="${escapeHtml(itemName)}">
        <i class="fa-solid fa-trash"></i>
        Delete Item
      </li>
    </ul>
  `;

  // Position near the cursor, keeping it on screen
  document.body.appendChild(menu);
  _activeMenu = menu;

  const menuRect = menu.getBoundingClientRect();
  let x = event.clientX;
  let y = event.clientY;
  if (x + menuRect.width > window.innerWidth)  x = window.innerWidth  - menuRect.width  - 8;
  if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 8;
  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;

  // Wire item clicks
  menu.querySelectorAll(".qm-context-menu-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const action   = item.dataset.action;
      const targetId = item.dataset.itemId;
      const targetName = item.dataset.itemName ?? "(item)";
      closeContextMenu();
      handleContextAction(action, targetId, targetName, app);
    });
  });

  // Close on outside click or Escape
  const onOutside = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onEscape = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };
  setTimeout(() => {
    document.addEventListener("click",   onOutside, { once: false });
    document.addEventListener("keydown", onEscape,  { once: true  });
    menu._cleanup = () => {
      document.removeEventListener("click",   onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, 0);
}

function closeContextMenu() {
  if (_activeMenu) {
    if (typeof _activeMenu._cleanup === "function") _activeMenu._cleanup();
    _activeMenu.remove();
    _activeMenu = null;
  }
}

// ============================================================
// Action dispatch
// ============================================================

export async function handleInventoryGMAction(action, itemId, itemName, app) {
  return handleContextAction(action, itemId, itemName, app);
}

async function handleContextAction(action, itemId, itemName, app) {
  if (!game.user.isGM) return;

  switch (action) {
    case "hide-item":   return handleHideItem(itemId, app);
    case "delete-item": return handleDeleteItem(itemId, itemName, app);
    default:
      console.warn(`${MODULE_TITLE} | unknown context action: ${action}`);
  }
}

async function handleHideItem(itemId, app) {
  if (!game.user.isGM) return;
  const actor = getBackingActor();
  if (!actor) {
    ui.notifications.error(`${MODULE_TITLE}: no backing actor.`);
    return;
  }
  const item = actor.items.get(itemId);
  if (!item) {
    ui.notifications.warn(`${MODULE_TITLE}: item no longer exists.`);
    app?.render();
    return;
  }

  await setItemHidden(itemId, true);
  await writeEntry({
    type: "hidden.staged",
    requestId: `qm-rehide-${itemId}-${Date.now()}`,
    userId: game.user.id,
    itemId,
    itemName: item.name,
    backingActorId: actor.id,
    visibility: "gm"
  });
  // setItemHidden fires updateItem → inventory popup auto-refreshes via existing hook
  // and loot-prep auto-refreshes via its updateItem hook
  ui.notifications.info(`"${item.name}" moved to hidden loot pool.`);
}

async function handleDeleteItem(itemId, itemName, app) {
  if (!game.user.isGM) return;
  const actor = getBackingActor();
  if (!actor) {
    ui.notifications.error(`${MODULE_TITLE}: no backing actor.`);
    return;
  }
  const item = actor.items.get(itemId);
  if (!item) {
    ui.notifications.warn(`${MODULE_TITLE}: item no longer exists.`);
    app?.render();
    return;
  }

  const { DialogV2 } = foundry.applications.api;
  const confirmed = await DialogV2.confirm({
    window: { title: "Delete Item" },
    content: `<p>Permanently delete <strong>${escapeHtml(item.name)}</strong> from the vault?</p>
              <p>This cannot be undone.</p>`,
    rejectClose: false,
    modal: true
  });
  if (!confirmed) return;

  try {
    await actor.deleteEmbeddedDocuments("Item", [itemId]);

    await writeEntry({
      type: "hidden.deleted",
      requestId: `qm-inv-delete-${itemId}-${Date.now()}`,
      userId: game.user.id,
      itemId,
      itemName: item.name,
      backingActorId: actor.id
    });

    ui.notifications.info(`"${item.name}" deleted from the vault.`);
    // inventory popup auto-refreshes via deleteItem hook
  } catch (err) {
    console.error(`${MODULE_TITLE} | delete item error`, err);
    ui.notifications.error(`${MODULE_TITLE}: delete failed — ${err.message}`);
  }
}
