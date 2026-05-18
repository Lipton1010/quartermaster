/**
 * Quartermaster — GM Loot Prep App (step 15)
 *
 * The GM-side popup for staging hidden loot and managing custom party
 * resources. Step 14 implemented the Custom Resources section. Step 15
 * adds the Hidden Items section: list, reveal (single / selected / all),
 * delete, and drag-drop from compendium directories.
 *
 * GM-only at every entry point: button is hidden from non-GMs,
 * openLootPrepApp rejects non-GM calls, and action handlers all
 * double-check game.user.isGM.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "../constants.js";
import { getBackingActor } from "../backing-actor.js";
import {
  getResources,
  getResource,
  createResource,
  updateResource,
  deleteResource,
  DEFAULT_RESOURCE_ICON
} from "../resources.js";
import { promptResourceEdit } from "./resource-edit-dialog.js";
import {
  getHiddenItems,
  setItemHidden,
  revealItem,
  revealItems,
  deleteHiddenItem,
  stageHiddenItem
} from "../hidden-items.js";
import { sanitizeItemForTransfer } from "../sanitization.js";
import { QM_REHIDE_MARKER } from "../drag-drop.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export class LootPrepApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "quartermaster-loot-prep",
    classes: ["quartermaster", "quartermaster-loot-prep"],
    tag: "section",
    window: {
      title: "quartermaster.buttons.gmLootPrep",
      icon: "fa-solid fa-coins",
      resizable: true,
      minimizable: true
    },
    position: {
      width: 680,
      height: 780
    },
    actions: {
      "add-resource":       LootPrepApp.onAddResource,
      "edit-resource":      LootPrepApp.onEditResource,
      "delete-resource":    LootPrepApp.onDeleteResource,
      "reveal-item":        LootPrepApp.onRevealItem,
      "delete-hidden-item": LootPrepApp.onDeleteHiddenItem,
      "reveal-selected":    LootPrepApp.onRevealSelected,
      "reveal-all":         LootPrepApp.onRevealAll
    }
  };

  static PARTS = {
    body: {
      template: "modules/quartermaster/templates/loot-prep.hbs",
      classes: ["quartermaster-body"]
    }
  };

  async _prepareContext(options) {
    const moduleVersion = game.modules.get(MODULE_ID)?.version ?? "unknown";
    const actor = getBackingActor();
    const resources = getResources();
    const hiddenItemDocs = actor ? getHiddenItems(actor) : [];

    const hiddenItems = hiddenItemDocs.map(item => {
      const sys = item.system ?? {};
      const qty = sys.quantity ?? 1;
      const rawWeight = sys.weight?.value ?? sys.weight ?? 0;
      const weight = typeof rawWeight === "number"
        ? (rawWeight * qty).toFixed(2).replace(/\.?0+$/, "")
        : "—";
      const sourceUuid = item.flags?.core?.sourceId ?? item.flags?.dnd5e?.sourceId ?? null;
      const sourcePack = sourceUuid
        ? sourceUuid.replace(/^Compendium\./, "").split(".").slice(0, 2).join(".")
        : null;
      return {
        id:         item.id,
        name:       item.name ?? "(unnamed)",
        img:        item.img ?? "icons/svg/item-bag.svg",
        qty,
        weight,
        sourcePack
      };
    });

    return {
      moduleVersion,
      isGM: game.user.isGM,
      backingActorPresent: !!actor,
      backingActorName: actor?.name ?? null,
      backingActorId:   actor?.id ?? null,
      resources: resources.map(r => ({
        ...r,
        hasMax:       r.max != null,
        displayValue: r.max != null ? `${r.value} / ${r.max}` : String(r.value),
        atMax:        r.max != null && r.value >= r.max,
        atZero:       r.value <= 0
      })),
      hasResources:     resources.length > 0,
      hiddenItems,
      hasHiddenItems:   hiddenItems.length > 0,
      hiddenItemCount:  hiddenItems.length
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    attachHiddenItemDragDrop(this);
  }

  // ----------------------------------------------------------------
  // Custom Resources (step 14)
  // ----------------------------------------------------------------

  static async onAddResource(event, target) {
    if (!game.user.isGM) return;
    const data = await promptResourceEdit({ resource: null });
    if (!data) return;
    const created = await createResource(data);
    if (created) {
      ui.notifications.info(`Resource "${created.name}" created.`);
      this.render();
    } else {
      ui.notifications.error(`${MODULE_TITLE}: failed to create resource.`);
    }
  }

  static async onEditResource(event, target) {
    if (!game.user.isGM) return;
    const id = target.dataset.resourceId;
    if (!id) return;
    const existing = getResource(id);
    if (!existing) {
      ui.notifications.warn(`${MODULE_TITLE}: resource no longer exists.`);
      this.render();
      return;
    }
    const data = await promptResourceEdit({ resource: existing });
    if (!data) return;
    const updated = await updateResource(id, data);
    if (updated) {
      ui.notifications.info(`Resource "${updated.name}" updated.`);
      this.render();
    } else {
      ui.notifications.error(`${MODULE_TITLE}: failed to update resource.`);
    }
  }

  static async onDeleteResource(event, target) {
    if (!game.user.isGM) return;
    const id = target.dataset.resourceId;
    if (!id) return;
    const existing = getResource(id);
    if (!existing) { this.render(); return; }

    const confirmed = await DialogV2.confirm({
      window: { title: "Delete Resource" },
      content: `<p>Delete <strong>${escapeHtml(existing.name)}</strong>?</p>
                <p>This permanently removes the resource and its current value.</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;

    const removed = await deleteResource(id);
    if (removed) {
      ui.notifications.info(`Resource "${existing.name}" deleted.`);
      this.render();
    } else {
      ui.notifications.error(`${MODULE_TITLE}: delete failed.`);
    }
  }

  // ----------------------------------------------------------------
  // Hidden Items (step 15)
  // ----------------------------------------------------------------

  static async onRevealItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const announce = event.shiftKey;
    const result = await revealItem(itemId, { announce });
    if (result.status === "success") {
      ui.notifications.info(`"${result.itemName}" revealed to the party.`);
    } else {
      ui.notifications.error(`${MODULE_TITLE}: reveal failed — ${result.error}`);
    }
    this.render();
  }

  static async onDeleteHiddenItem(event, target) {
    if (!game.user.isGM) return;
    const itemId   = target.dataset.itemId;
    const itemName = target.dataset.itemName ?? "this item";
    if (!itemId) return;

    const confirmed = await DialogV2.confirm({
      window: { title: "Delete Hidden Item" },
      content: `<p>Permanently delete <strong>${escapeHtml(itemName)}</strong>?</p>
                <p>This removes it from the staging pool without revealing it to players.</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;

    const result = await deleteHiddenItem(itemId);
    if (result.status === "success") {
      ui.notifications.info(`"${result.itemName}" deleted from hidden pool.`);
    } else {
      ui.notifications.error(`${MODULE_TITLE}: delete failed — ${result.error}`);
    }
    this.render();
  }

  static async onRevealSelected(event, target) {
    if (!game.user.isGM) return;
    const checked = this.element.querySelectorAll(".qm-hidden-item-select:checked");
    const itemIds = Array.from(checked).map(cb => cb.dataset.itemId).filter(Boolean);
    if (itemIds.length === 0) {
      ui.notifications.warn(`${MODULE_TITLE}: no items selected.`);
      return;
    }
    const announce = event.shiftKey;
    const { successCount, failCount } = await revealItems(itemIds, { announce });
    if (failCount === 0) {
      ui.notifications.info(`${successCount} item(s) revealed.`);
    } else {
      ui.notifications.warn(`${successCount} revealed, ${failCount} failed. See console.`);
    }
    this.render();
  }

  static async onRevealAll(event, target) {
    if (!game.user.isGM) return;
    const actor  = getBackingActor();
    const hidden = actor ? getHiddenItems(actor) : [];
    if (hidden.length === 0) {
      ui.notifications.info(`${MODULE_TITLE}: no hidden items to reveal.`);
      return;
    }
    const confirmed = await DialogV2.confirm({
      window: { title: "Reveal All Hidden Items" },
      content: `<p>Reveal all <strong>${hidden.length}</strong> hidden item(s) to the party?</p>
                <p>They will appear in the Shared Party Inventory immediately.</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;

    const announce  = event.shiftKey;
    const itemIds   = hidden.map(i => i.id);
    const { successCount, failCount } = await revealItems(itemIds, { announce });
    if (failCount === 0) {
      ui.notifications.info(`All ${successCount} item(s) revealed.`);
    } else {
      ui.notifications.warn(`${successCount} revealed, ${failCount} failed. See console.`);
    }
    this.render();
  }
}

// ============================================================
// Drag-drop wiring for the hidden items drop zone
// ============================================================

export function attachHiddenItemDragDrop(app) {
  const el = app?.element;
  if (!el) return;
  const dropZone = el.querySelector(".qm-hidden-drop-zone");
  if (!dropZone) return;

  dropZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dropZone.classList.add("qm-drop-hover");
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  dropZone.addEventListener("dragleave", (e) => {
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove("qm-drop-hover");
    }
  });
  dropZone.addEventListener("drop", (e) => {
    dropZone.classList.remove("qm-drop-hover");
    _onHiddenItemDrop(e, app);
  });
}

async function _onHiddenItemDrop(event, app) {
  event.preventDefault();
  if (!game.user.isGM) return;

  let data;
  try {
    data = JSON.parse(event.dataTransfer.getData("text/plain"));
  } catch {
    console.warn(`${MODULE_TITLE} | hidden drop: could not parse drag data`);
    return;
  }

  const uuid = data.uuid ?? null;
  if (!uuid) {
    ui.notifications.warn(`${MODULE_TITLE}: drop a compendium item onto the Hidden Items zone.`);
    return;
  }

  const actor = getBackingActor();
  if (!actor) {
    ui.notifications.error(`${MODULE_TITLE}: no backing actor configured.`);
    return;
  }

  // Re-hide flow: item dragged from the Shared Party Inventory (already on
  // the backing actor). Just set the hidden flag — do NOT create a copy.
  if (data[QM_REHIDE_MARKER]) {
    let sourceItem;
    try {
      sourceItem = await fromUuid(uuid);
    } catch (err) {
      ui.notifications.error(`${MODULE_TITLE}: could not resolve item — ${err?.message ?? err}`);
      return;
    }
    if (!sourceItem || sourceItem.parent?.id !== actor.id) {
      ui.notifications.warn(`${MODULE_TITLE}: item is not in the vault.`);
      return;
    }
    await setItemHidden(sourceItem.id, true);
    ui.notifications.info(`"${sourceItem.name}" moved to hidden loot pool.`);
    // Both inventory popup and loot prep popup auto-refresh via their updateItem hooks
    return;
  }

  // Compendium / world drop: load item, sanitize, create with hidden flag
  let sourceItem;
  try {
    sourceItem = await fromUuid(uuid);
  } catch (err) {
    ui.notifications.error(`${MODULE_TITLE}: could not load item — ${err?.message ?? err}`);
    return;
  }

  if (!sourceItem || sourceItem.documentName !== "Item") {
    ui.notifications.warn(`${MODULE_TITLE}: only Item documents can be staged as hidden loot.`);
    return;
  }

  const rawData  = sourceItem.toObject();
  const sanitized = sanitizeItemForTransfer(rawData, actor, { sourceItemUuid: uuid });
  const result   = await stageHiddenItem(sanitized);

  if (result.status === "success") {
    ui.notifications.info(`"${result.item.name}" staged as hidden loot.`);
    app.render();
  } else {
    ui.notifications.error(`${MODULE_TITLE}: staging failed — ${result.error}`);
  }
}

// ============================================================
// Singleton management
// ============================================================

let _instance = null;

export async function openLootPrepApp() {
  if (!game.user.isGM) {
    ui.notifications.warn("GM Loot Prep is only available to Game Masters.");
    return null;
  }
  if (!_instance) _instance = new LootPrepApp();
  await _instance.render({ force: true });
  return _instance;
}

export async function closeLootPrepApp() {
  if (_instance) {
    try { await _instance.close(); } catch { /* already closed */ }
    _instance = null;
  }
}

export function isLootPrepAppOpen() {
  return Boolean(_instance?.element?.isConnected);
}

// ============================================================
// Auto-refresh hooks (resources + hidden items)
// ============================================================

let _refreshTimer = null;

function scheduleLootPrepRefresh() {
  if (!isLootPrepAppOpen()) return;
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    if (isLootPrepAppOpen()) _instance.render();
  }, 200);
}

export function registerLootPrepRefreshHooks() {
  const getBacking = () => getBackingActor();

  Hooks.on("updateActor", (actor, changes) => {
    const b = getBacking();
    if (!b || actor.id !== b.id) return;
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.CUSTOM_RESOURCES}`)) {
      scheduleLootPrepRefresh();
    }
  });

  Hooks.on("updateItem", (item, changes) => {
    const b = getBacking();
    if (!b || item.parent?.id !== b.id) return;
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.HIDDEN}`)) {
      scheduleLootPrepRefresh();
    }
  });

  Hooks.on("createItem", (item) => {
    const b = getBacking();
    if (b && item.parent?.id === b.id) scheduleLootPrepRefresh();
  });

  Hooks.on("deleteItem", (item) => {
    const b = getBacking();
    if (b && item.parent?.id === b.id) scheduleLootPrepRefresh();
  });
}
