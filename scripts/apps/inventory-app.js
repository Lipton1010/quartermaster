/**
 * Quartermaster — Inventory App (step 17)
 *
 * Step 17 adds:
 *   - Header gear icon for per-user inventory preferences
 *   - Live re-render when preferences change (hook listener)
 */

import { MODULE_ID, MODULE_TITLE, SETTINGS, HOOKS } from "../constants.js";
import { getBackingActor } from "../backing-actor.js";
import { buildInventoryContext } from "../inventory-rendering.js";
import { attachInventoryDragDrop } from "../drag-drop.js";
import { attachCurrencyButtons } from "../currency-buttons.js";
import { attachResourceButtons } from "../resource-buttons.js";
import { attachInventoryContextMenu, handleInventoryGMAction } from "../context-menu.js";
import { promptInventoryPreferences } from "./preferences-dialog.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

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

  async _onRender(context, options) {
    await super._onRender(context, options);
    attachInventoryDragDrop(this);
    attachCurrencyButtons(this);
    attachResourceButtons(this);
    attachInventoryContextMenu(this);
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

  static async onOpenPreferences(event, target) {
    const saved = await promptInventoryPreferences();
    if (saved) this.render();
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
