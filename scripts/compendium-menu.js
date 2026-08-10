/**
 * Quartermaster — Compendium Context Menu (step 18)
 *
 * Injects Quartermaster options into compendium item context menus:
 *   - "Send to Party Inventory"  (visible on backing actor)
 *   - "Send to GM Staging"       (private staging actor)
 *
 * GM-only: options only appear for GM users.
 *
 * V14 approach: Hook into the renderCompendium hook, then attach a
 * contextmenu listener to item entries. When right-clicked, we show
 * a custom context menu (same pattern as context-menu.js).
 */

import { MODULE_TITLE } from "./constants.js";
import { getBackingActor, getStagingActor } from "./backing-actor.js";
import { importCompendiumItem } from "./drag-drop.js";
import { stageHiddenItem } from "./hidden-items.js";
import { isActiveStorageGM, requireActiveStorageGM } from "./storage-ledger.js";
import { sanitizeItemForTransfer } from "./sanitization.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

let _activeMenu = null;

function closeMenu() {
  if (_activeMenu) {
    if (typeof _activeMenu._cleanup === "function") _activeMenu._cleanup();
    _activeMenu.remove();
    _activeMenu = null;
  }
}

/**
 * Register hooks to inject context menu on compendium item entries.
 * Called once at module ready.
 */
export function registerCompendiumContextMenu() {
  // Hook fires every time a compendium window renders its content
  Hooks.on("renderCompendium", (app, html) => {
    if (!isActiveStorageGM()) return;

    // Check this is an Item-type compendium
    const pack = app.collection;
    if (!pack || pack.documentName !== "Item") return;

    const el = html instanceof HTMLElement ? html : html[0] ?? html;
    if (!el) return;

    // Find all entry rows in the compendium listing
    const entries = el.querySelectorAll(".directory-item, .entry-name, li.compendium-entry, [data-document-id]");
    for (const entry of entries) {
      // Only attach once
      if (entry.dataset.qmContextAttached) continue;
      entry.dataset.qmContextAttached = "true";

      entry.addEventListener("contextmenu", (event) => {
        // Don't override if user is holding shift (some modules use shift+right-click)
        if (event.shiftKey) return;

        const docId = entry.dataset.documentId ?? entry.dataset.entryId ??
                      entry.closest("[data-document-id]")?.dataset.documentId;
        if (!docId) return;

        event.preventDefault();
        event.stopPropagation();
        showCompendiumMenu(event, pack, docId);
      });
    }
  });
}

function showCompendiumMenu(event, pack, docId) {
  closeMenu();

  const menu = document.createElement("div");
  menu.className = "quartermaster qm-context-menu";
  menu.innerHTML = `
    <ul class="qm-context-menu-list">
      <li class="qm-context-menu-item" data-action="send-to-inventory">
        <i class="fa-solid fa-box-archive"></i>
        Send to Party Inventory
      </li>
      <li class="qm-context-menu-item" data-action="send-to-staging">
        <i class="fa-solid fa-eye-slash"></i>
        Send to GM Staging
      </li>
    </ul>
  `;

  document.body.appendChild(menu);
  _activeMenu = menu;

  // Position near cursor
  const menuRect = menu.getBoundingClientRect();
  let x = event.clientX;
  let y = event.clientY;
  if (x + menuRect.width > window.innerWidth)  x = window.innerWidth  - menuRect.width  - 8;
  if (y + menuRect.height > window.innerHeight) y = window.innerHeight - menuRect.height - 8;
  menu.style.left = `${x}px`;
  menu.style.top  = `${y}px`;

  // Wire clicks
  menu.querySelectorAll(".qm-context-menu-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      closeMenu();
      handleAction(action, pack, docId);
    });
  });

  // Close on outside click or Escape
  const onOutside = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  const onEscape = (e) => {
    if (e.key === "Escape") closeMenu();
  };
  setTimeout(() => {
    document.addEventListener("click", onOutside, { once: false });
    document.addEventListener("keydown", onEscape, { once: true });
    menu._cleanup = () => {
      document.removeEventListener("click", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, 0);
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
