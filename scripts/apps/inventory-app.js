/**
 * Quartermaster — Inventory App (step 17)
 *
 * Step 17 adds:
 *   - Header gear icon for per-user inventory preferences
 *   - Live re-render when preferences change (hook listener)
 */

import { MODULE_ID, MODULE_TITLE, FLAGS, SETTINGS, HOOKS } from "../constants.js";
import { getBackingActor } from "../backing-actor.js";
import { buildInventoryContext } from "../inventory-rendering.js";
import { attachInventoryDragDrop } from "../drag-drop.js";
import { attachCurrencyButtons } from "../currency-buttons.js";
import { attachResourceButtons } from "../resource-buttons.js";
import { attachInventoryContextMenu, handleInventoryGMAction } from "../context-menu.js";
import { promptInventoryPreferences } from "./preferences-dialog.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;



/**
 * Move an item up or down in the manual sort order.
 * Assigns/reassigns qmSortIndex flags on all items.
 */
async function moveItemInOrder(itemId, direction) {
  const actor = getBackingActor();
  if (!actor) return;

  // Get current items sorted by their sortIndex (or name as fallback)
  const items = actor.items
    .filter(i => !i.getFlag(MODULE_ID, FLAGS.HIDDEN))
    .map(i => ({
      id: i.id,
      name: i.name,
      sortIndex: i.getFlag(MODULE_ID, "sortIndex") ?? 999999
    }))
    .sort((a, b) => {
      if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });

  const idx = items.findIndex(i => i.id === itemId);
  if (idx === -1) return;

  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= items.length) return;

  // Swap
  [items[idx], items[newIdx]] = [items[newIdx], items[idx]];

  // Reassign sort indices
  for (let i = 0; i < items.length; i++) {
    const item = actor.items.get(items[i].id);
    if (item) {
      await item.setFlag(MODULE_ID, "sortIndex", (i + 1) * 10);
    }
  }
}

export class InventoryApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "quartermaster-inventory",
    classes: ["quartermaster", "quartermaster-inventory"],
    tag: "section",
    window: {
      title: "quartermaster.buttons.sharedPartyInventory",
      icon: "fa-solid fa-box-archive",
      resizable: true,
      minimizable: true
    },
    position: {
      width: 540,
      height: 720
    },
    actions: {
      "hide-item":        InventoryApp.onHideItem,
      "delete-item":      InventoryApp.onDeleteItem,
      "create-item":      InventoryApp.onCreateItem,
      "move-item-up":     InventoryApp.onMoveItemUp,
      "move-item-down":   InventoryApp.onMoveItemDown,
      "open-preferences": InventoryApp.onOpenPreferences
    }
  };

  static PARTS = {
    body: {
      template: "modules/quartermaster/templates/inventory.hbs",
      classes: ["quartermaster-body"]
    }
  };

  _getHeaderControls() {
    const controls = super._getHeaderControls?.() ?? [];
    controls.push({
      icon: "fa-solid fa-gear",
      label: "Preferences",
      action: "open-preferences"
    });
    return controls;
  }

  async _prepareContext(options) {
    const actor = getBackingActor();
    const ctx = buildInventoryContext(actor);

    ctx.moduleVersion = game.modules.get(MODULE_ID)?.version ?? "unknown";
    ctx.moduleTitle   = MODULE_TITLE;

    const entrySize = game.settings.get(MODULE_ID, SETTINGS.DEFAULT_ENTRY_SIZE);
    ctx.entrySize      = entrySize;
    ctx.entrySizeClass = `qm-entry-${entrySize}`;

    return ctx;
  }

  async render(options = {}) {
    // Save scroll position before DOM replacement
    this._savedScrollTop = 0;
    const appEl = document.getElementById("quartermaster-inventory");
    if (appEl) {
      // Try the app element itself, then any scrollable child
      if (appEl.scrollTop > 0) this._savedScrollTop = appEl.scrollTop;
      else {
        for (const child of appEl.querySelectorAll("*")) {
          if (child.scrollTop > 0) { this._savedScrollTop = child.scrollTop; this._scrollEl = child.className; break; }
        }
      }
    }
    return super.render(options);
  }

  _preRender(context, options) {
    try { super._preRender(context, options); } catch {}
    // Save scroll position on the element itself before PARTS replacement
    this._savedScroll = this.element?.scrollTop ?? 0;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    // Restore scroll after new content is in place
    if (this._savedScroll > 0 && this.element) {
      this.element.scrollTop = this._savedScroll;
    }

    // Restore scroll position after DOM replacement
    if (this._savedScrollTop > 0) {
      const restore = () => {
        const appEl = document.getElementById("quartermaster-inventory");
        if (!appEl) return;
        // Try setting on the app element first
        appEl.scrollTop = this._savedScrollTop;
        // Then try every child
        for (const child of appEl.querySelectorAll("*")) {
          if (child.scrollHeight > child.clientHeight) {
            child.scrollTop = this._savedScrollTop;
          }
        }
      };
      requestAnimationFrame(restore);
      // Double-try in case the first frame was too early
      setTimeout(restore, 50);
    }
    attachInventoryDragDrop(this);
    attachCurrencyButtons(this);
    attachResourceButtons(this);
    attachInventoryContextMenu(this);

    // Double-click item row → open item sheet
    const rows = this.element.querySelectorAll(".qm-item-row[data-item-id]");
    for (const row of rows) {
      row.addEventListener("dblclick", (event) => {
        if (event.target.closest("button, input")) return;
        const itemId = row.dataset.itemId;
        if (!itemId) return;
        const actor = getBackingActor();
        const item = actor?.items.get(itemId);
        if (item) item.sheet.render(true);
      });
    }

    // Custom sort: drag-to-reorder within the item list
    const isCustomSort = game.settings.get(MODULE_ID, SETTINGS.SORT_ORDER) === "custom";
    if (isCustomSort) _wireReorderDrag(this);

    // Sort-by select in items header
    const sortSelect = this.element.querySelector(".qm-sort-select[name='sortOrder']");
    if (sortSelect) {
      sortSelect.addEventListener("change", async (event) => {
        const value = event.target.value;
        await game.settings.set(MODULE_ID, SETTINGS.SORT_ORDER, value);
        Hooks.callAll(HOOKS.PREFERENCES_CHANGED, { keys: [SETTINGS.SORT_ORDER] });
        this.render();
      });
    }
  }

  // ============================================================
  // Action handlers
  // ============================================================

  static async onHideItem(event, target) {
    if (!game.user.isGM) return;
    await handleInventoryGMAction(
      "hide-item", target.dataset.itemId, target.dataset.itemName ?? "", this
    );
  }

  static async onDeleteItem(event, target) {
    if (!game.user.isGM) return;
    await handleInventoryGMAction(
      "delete-item", target.dataset.itemId, target.dataset.itemName ?? "", this
    );
  }

  static async onMoveItemUp(event, target) {
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    await moveItemInOrder(itemId, -1);
    this.render();
  }

  static async onMoveItemDown(event, target) {
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    await moveItemInOrder(itemId, 1);
    this.render();
  }

  static async onCreateItem(event, target) {
    if (!game.user.isGM) return;
    const actor = getBackingActor();
    if (!actor) {
      ui.notifications.error(`${MODULE_TITLE}: no backing actor.`);
      return;
    }
    // Open dnd5e's item creation dialog targeting the backing actor
    const itemTypes = game.documentTypes.Item.filter(t => !["base"].includes(t));
    const typeChoices = {};
    for (const t of itemTypes) {
      typeChoices[t] = game.i18n.localize(CONFIG.Item.typeLabels?.[t] ?? t);
    }
    Item.implementation.createDialog({}, { parent: actor, types: itemTypes });
  }

  static async onOpenPreferences(event, target) {
    const saved = await promptInventoryPreferences();
    if (saved) this.render();
  }
}

// ============================================================
// Drag-to-reorder (custom sort mode)
// ============================================================

function _wireReorderDrag(app) {
  const el = app?.element;
  if (!el) return;
  const rows = el.querySelectorAll(".qm-item-row[data-item-id]");
  let draggedItemId = null;

  for (const row of rows) {
    // Track which item is being dragged (set by the existing dragstart on the row)
    row.addEventListener("dragstart", () => {
      draggedItemId = row.dataset.itemId;
    });

    row.addEventListener("dragover", (e) => {
      if (!draggedItemId || draggedItemId === row.dataset.itemId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      // Show insertion indicator: top half = above, bottom half = below
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      row.classList.remove("qm-reorder-above", "qm-reorder-below");
      if (e.clientY < midY) {
        row.classList.add("qm-reorder-above");
      } else {
        row.classList.add("qm-reorder-below");
      }
    });

    row.addEventListener("dragleave", () => {
      row.classList.remove("qm-reorder-above", "qm-reorder-below");
    });

    row.addEventListener("drop", async (e) => {
      row.classList.remove("qm-reorder-above", "qm-reorder-below");
      if (!draggedItemId || draggedItemId === row.dataset.itemId) return;

      // Check if this is an internal reorder (source is from our inventory)
      let data;
      try { data = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
      if (!data?.qmEgressDrag) return; // not from our inventory

      e.preventDefault();
      e.stopPropagation();

      const targetId = row.dataset.itemId;
      const rect = row.getBoundingClientRect();
      const insertBefore = e.clientY < (rect.top + rect.height / 2);

      await reorderItem(draggedItemId, targetId, insertBefore);
      draggedItemId = null;
      app.render();
    });

    row.addEventListener("dragend", () => {
      draggedItemId = null;
      // Clean up any stale indicators
      el.querySelectorAll(".qm-reorder-above, .qm-reorder-below").forEach(r => {
        r.classList.remove("qm-reorder-above", "qm-reorder-below");
      });
    });
  }
}

async function reorderItem(draggedId, targetId, insertBefore) {
  const actor = getBackingActor();
  if (!actor) return;

  // Build current order
  const items = actor.items
    .filter(i => !i.getFlag(MODULE_ID, FLAGS.HIDDEN))
    .map(i => ({
      id: i.id,
      name: i.name,
      sortIndex: i.getFlag(MODULE_ID, "sortIndex") ?? 999999
    }))
    .sort((a, b) => {
      if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });

  // Remove dragged item from list
  const draggedIdx = items.findIndex(i => i.id === draggedId);
  if (draggedIdx === -1) return;
  const [dragged] = items.splice(draggedIdx, 1);

  // Find target position and insert
  const targetIdx = items.findIndex(i => i.id === targetId);
  if (targetIdx === -1) return;
  const insertIdx = insertBefore ? targetIdx : targetIdx + 1;
  items.splice(insertIdx, 0, dragged);

  // Reassign sort indices
  for (let i = 0; i < items.length; i++) {
    const item = actor.items.get(items[i].id);
    if (item) {
      await item.setFlag(MODULE_ID, "sortIndex", (i + 1) * 10);
    }
  }
}

// ============================================================
// Singleton management
// ============================================================

let _instance = null;

export async function openInventoryApp() {
  if (!_instance) _instance = new InventoryApp();
  await _instance.render({ force: true });
  return _instance;
}

export async function closeInventoryApp() {
  if (_instance) {
    try { await _instance.close(); } catch {}
    _instance = null;
  }
}

export function isInventoryAppOpen() {
  return Boolean(_instance?.element?.isConnected);
}

// ============================================================
// Debounced refresh wiring
// ============================================================

let _refreshTimer = null;

export function scheduleInventoryRefresh() {
  if (!isInventoryAppOpen()) return;
  const debounceMs = game.settings.get(MODULE_ID, SETTINGS.UI_REFRESH_DEBOUNCE_MS) ?? 100;
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    performRefresh();
  }, debounceMs);
}

function performRefresh() {
  if (!isInventoryAppOpen()) return;
  if (document.body.classList.contains("qm-dragging")) {
    _refreshTimer = setTimeout(performRefresh, 200);
    return;
  }
  _instance.render();
}

export async function forceInventoryRefresh() {
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  if (isInventoryAppOpen()) await _instance.render();
}

// ============================================================
// Hook handlers (registered once at module ready)
// ============================================================

export function registerInventoryRefreshHooks() {
  Hooks.on("updateActor", (actor) => {
    if (actor.id === getBackingActor()?.id) scheduleInventoryRefresh();
  });
  Hooks.on("createItem", (item) => {
    if (item.parent?.id === getBackingActor()?.id) scheduleInventoryRefresh();
  });
  Hooks.on("updateItem", (item) => {
    if (item.parent?.id === getBackingActor()?.id) scheduleInventoryRefresh();
  });
  Hooks.on("deleteItem", (item) => {
    if (item.parent?.id === getBackingActor()?.id) scheduleInventoryRefresh();
  });

  // Path B: re-render when preferences change from any source
  Hooks.on(HOOKS.PREFERENCES_CHANGED, () => {
    scheduleInventoryRefresh();
  });
}
