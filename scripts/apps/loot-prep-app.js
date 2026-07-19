/**
 * Quartermaster — GM Loot Prep App (v0.1.2)
 *
 * Features:
 *   - Custom Resources (CRUD)
 *   - Hidden Items (stage, reveal, delete, drag-drop)
 *   - Hidden Currency entries (stage, reveal, delete)
 *   - Loot Prep Folders (organize by encounter/location)
 *   - Drag from Loot Prep to inventory/player sheets = reveal
 *   - Double-click items to open sheet
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "../constants.js";
import { getBackingActor } from "../backing-actor.js";
import {
  getResources, getResource, createResource, updateResource, deleteResource,
  DEFAULT_RESOURCE_ICON
} from "../resources.js";
import { promptResourceEdit } from "./resource-edit-dialog.js";
import {
  getHiddenItems, setItemHidden, revealItem, revealItems,
  deleteHiddenItem, stageHiddenItem
} from "../hidden-items.js";
import {
  getHiddenCurrency, addHiddenCurrency, deleteHiddenCurrency,
  revealHiddenCurrency, revealAllHiddenCurrency
} from "../hidden-currency.js";
import {
  getFolders, createFolder, renameFolder, deleteFolder, setItemFolder
} from "../loot-prep-folders.js";
import {
  getEffectiveItemNote, getFolderNote, getItemNote, setFolderNote, setItemNote
} from "../loot-prep-notes.js";
import { sanitizeItemForTransfer } from "../sanitization.js";
import { QM_REHIDE_MARKER, QM_LOOTPREP_DRAG_MARKER } from "../drag-drop.js";
import { writeEntry } from "../transaction-log.js";
import { getCurrencies, getCurrency } from "../currencies.js";
import { openCurrencyManager } from "./currency-manager-app.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

const _DENOM_TO_CP = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
function _formatPrice(val, denom, qty) {
  if (!val || val <= 0) return null;
  const totalCP = val * (_DENOM_TO_CP[denom] ?? 100) * (qty || 1);
  if (totalCP <= 0) return null;
  if (totalCP >= 100) {
    const gp = totalCP / 100;
    return Number.isInteger(gp) ? `${gp} GP` : `${(Math.round(gp * 100) / 100)} GP`;
  }
  if (totalCP >= 10) {
    const sp = totalCP / 10;
    return Number.isInteger(sp) ? `${sp} SP` : `${(Math.round(sp * 100) / 100)} SP`;
  }
  return `${totalCP} CP`;
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
    position: { width: 720, height: 820 },
    actions: {
      // Resources
      "add-resource":       LootPrepApp.onAddResource,
      "edit-resource":      LootPrepApp.onEditResource,
      "delete-resource":    LootPrepApp.onDeleteResource,
      // Hidden items
      "reveal-item":        LootPrepApp.onRevealItem,
      "delete-hidden-item": LootPrepApp.onDeleteHiddenItem,
      "reveal-selected":    LootPrepApp.onRevealSelected,
      "delete-selected":    LootPrepApp.onDeleteSelected,
      "reveal-all":         LootPrepApp.onRevealAll,
      "create-item":        LootPrepApp.onCreateItem,
      // Currency loot
      "add-currency-loot":     LootPrepApp.onAddCurrencyLoot,
      "manage-currencies":     LootPrepApp.onManageCurrencies,
      "reveal-currency":       LootPrepApp.onRevealCurrency,
      "delete-currency":       LootPrepApp.onDeleteCurrency,
      // Folders
      "create-folder":      LootPrepApp.onCreateFolder,
      "rename-folder":      LootPrepApp.onRenameFolder,
      "edit-folder-note":   LootPrepApp.onEditFolderNote,
      "delete-folder":      LootPrepApp.onDeleteFolder,
      "move-to-folder":     LootPrepApp.onMoveToFolder
    }
  };

  static PARTS = {
    body: {
      template: "modules/quartermaster/templates/loot-prep.hbs",
      classes: ["quartermaster-body"]
    }
  };

  async _prepareContext(options) {
    const actor = getBackingActor();
    const resources = getResources();
    const hiddenItemDocs = actor ? getHiddenItems(actor) : [];
    const hiddenCurrencyEntries = actor ? getHiddenCurrency(actor) : [];
    const folders = actor ? getFolders(actor) : [];
    const foldersById = new Map(folders.map(folder => [folder.id, folder]));

    const hiddenItems = hiddenItemDocs.map(item => {
      const sys = item.system ?? {};
      const qty = sys.quantity ?? 1;
      const rawWeight = sys.weight?.value ?? sys.weight ?? 0;
      const weight = typeof rawWeight === "number"
        ? (rawWeight * qty).toFixed(2).replace(/\.?0+$/, "") : "—";
      const sourceUuid = item.flags?.core?.sourceId ?? item.flags?.dnd5e?.sourceId ?? null;
      const sourcePack = sourceUuid
        ? sourceUuid.replace(/^Compendium\./, "").split(".").slice(0, 2).join(".") : null;
      const priceDisplay = _formatPrice(sys.price?.value, sys.price?.denomination, qty);
      const folderId = item.getFlag(MODULE_ID, "lootPrepFolder") ?? null;
      const effectiveNote = getEffectiveItemNote(item, foldersById.get(folderId));
      return {
        id: item.id, name: item.name ?? "(unnamed)",
        img: item.img ?? "icons/svg/item-bag.svg",
        qty, weight, sourcePack, priceDisplay,
        hasPrice: !!priceDisplay,
        folderId,
        note: effectiveNote.note,
        hasNote: !!effectiveNote.note,
        noteSource: effectiveNote.source,
        noteSourceLabel: effectiveNote.source === "item" ? "Item" : "Folder",
        isCurrency: false
      };
    });

    const currencyEntries = hiddenCurrencyEntries.map(e => {
      const currencyId = e.currencyId ?? e.type;
      const currency = getCurrency(currencyId, actor);
      const symbol = currency?.symbol ?? e.currencySymbol ?? String(currencyId).toUpperCase();
      return {
        id: e.id,
        type: currencyId,
        symbol,
        amount: e.amount,
        label: `${e.amount} ${symbol}`,
        folderId: e.folderId ?? null,
        isCurrency: true
      };
    });

    // Group items and currency by folder
    const folderData = folders.map(f => {
      const fItems = hiddenItems.filter(i => i.folderId === f.id);
      const fCurrency = currencyEntries.filter(c => c.folderId === f.id);
      const note = getFolderNote(f);
      return {
        ...f, note, hasNote: !!note, items: fItems, currency: fCurrency,
        totalEntries: fItems.length + fCurrency.length
      };
    });

    // Uncategorized (no folder)
    const uncatItems = hiddenItems.filter(i => !i.folderId);
    const uncatCurrency = currencyEntries.filter(c => !c.folderId);

    const allHiddenCount = hiddenItems.length + currencyEntries.length;

    return {
      moduleVersion: game.modules.get(MODULE_ID)?.version ?? "unknown",
      isGM: game.user.isGM,
      backingActorPresent: !!actor,
      backingActorName: actor?.name ?? null,
      backingActorId: actor?.id ?? null,
      resources: resources.map(r => ({
        ...r,
        hasMax: r.max != null,
        displayValue: r.max != null ? `${r.value} / ${r.max}` : String(r.value),
        atMax: r.max != null && r.value >= r.max,
        atZero: r.value <= 0
      })),
      hasResources: resources.length > 0,
      folders: folderData,
      hasFolders: folderData.length > 0,
      uncatItems,
      uncatCurrency,
      hasUncategorized: uncatItems.length > 0 || uncatCurrency.length > 0,
      allHiddenCount,
      hasHiddenContent: allHiddenCount > 0,
      hiddenItemCount: hiddenItems.length,
      hiddenCurrencyCount: currencyEntries.length
    };
  }

  _preRender(context, options) {
    try { super._preRender(context, options); } catch {}
    this._savedScroll = this.element?.scrollTop ?? 0;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this._savedScroll > 0 && this.element) {
      this.element.scrollTop = this._savedScroll;
    }
    attachHiddenItemDragDrop(this);
    _wireHiddenItemDrag(this);
    _wireDoubleClick(this);
    _wireLootPrepNotes(this);
  }

  // ================================================================
  // Resources
  // ================================================================

  static async onAddResource(event, target) {
    if (!game.user.isGM) return;
    const data = await promptResourceEdit({ resource: null });
    if (!data) return;
    const created = await createResource(data);
    if (created) { ui.notifications.info(`Resource "${created.name}" created.`); this.render(); }
    else ui.notifications.error(`${MODULE_TITLE}: failed to create resource.`);
  }

  static async onEditResource(event, target) {
    if (!game.user.isGM) return;
    const id = target.dataset.resourceId;
    if (!id) return;
    const existing = getResource(id);
    if (!existing) { this.render(); return; }
    const data = await promptResourceEdit({ resource: existing });
    if (!data) return;
    const updated = await updateResource(id, data);
    if (updated) { ui.notifications.info(`Resource "${updated.name}" updated.`); this.render(); }
    else ui.notifications.error(`${MODULE_TITLE}: failed to update resource.`);
  }

  static async onDeleteResource(event, target) {
    if (!game.user.isGM) return;
    const id = target.dataset.resourceId;
    if (!id) return;
    const existing = getResource(id);
    if (!existing) { this.render(); return; }
    const confirmed = await DialogV2.confirm({
      window: { title: "Delete Resource" },
      content: `<p>Delete <strong>${escapeHtml(existing.name)}</strong>?</p>`,
      rejectClose: false, modal: true
    });
    if (!confirmed) return;
    const removed = await deleteResource(id);
    if (removed) { ui.notifications.info(`Resource "${existing.name}" deleted.`); this.render(); }
    else ui.notifications.error(`${MODULE_TITLE}: delete failed.`);
  }

  // ================================================================
  // Hidden Items
  // ================================================================

  static async onCreateItem(event, target) {
    if (!game.user.isGM) return;

    const folderId = target.dataset.folderId ?? null;
    const created = await _promptHiddenItemCreate(folderId);
    if (!created) return;

    this.render();
    try {
      created.sheet?.render?.(true);
    } catch (err) {
      console.warn(`${MODULE_TITLE} | Created hidden item, but could not open its sheet`, err);
    }
  }

  static async onRevealItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    if (!itemId) return;
    const result = await revealItem(itemId, { announce: event.shiftKey });
    if (result.status === "success") ui.notifications.info(`"${result.itemName}" revealed.`);
    else ui.notifications.error(`${MODULE_TITLE}: reveal failed — ${result.error}`);
    this.render();
  }

  static async onDeleteHiddenItem(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    const itemName = target.dataset.itemName ?? "this item";
    if (!itemId) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "Delete Hidden Item" },
      content: `<p>Delete <strong>${escapeHtml(itemName)}</strong>?</p>`,
      rejectClose: false, modal: true
    });
    if (!confirmed) return;
    const result = await deleteHiddenItem(itemId);
    if (result.status === "success") ui.notifications.info(`"${result.itemName}" deleted.`);
    else ui.notifications.error(`${MODULE_TITLE}: delete failed.`);
    this.render();
  }

  static async onRevealSelected(event, target) {
    if (!game.user.isGM) return;
    const checked = this.element.querySelectorAll(".qm-hidden-item-select:checked");
    const itemIds = Array.from(checked).map(cb => cb.dataset.itemId).filter(Boolean);
    if (itemIds.length === 0) { ui.notifications.warn(`${MODULE_TITLE}: no items selected.`); return; }
    const { successCount, failCount } = await revealItems(itemIds, { announce: event.shiftKey });
    if (failCount === 0) ui.notifications.info(`${successCount} item(s) revealed.`);
    else ui.notifications.warn(`${successCount} revealed, ${failCount} failed.`);
    this.render();
  }

  static async onDeleteSelected(event, target) {
    if (!game.user.isGM) return;
    const checked = this.element.querySelectorAll(".qm-hidden-item-select:checked");
    const itemIds = Array.from(checked)
      .map(cb => cb.dataset.itemId)
      .filter(Boolean);
    if (itemIds.length === 0) {
      ui.notifications.warn(`${MODULE_TITLE}: no items selected.`);
      return;
    }
    const confirmed = await DialogV2.confirm({
      window: { title: "Delete Selected" },
      content: `<p>Permanently delete <strong>${itemIds.length}</strong> selected item(s)?</p>
                <p>This removes them without revealing to players.</p>`,
      rejectClose: false, modal: true
    });
    if (!confirmed) return;

    let deleted = 0;
    for (const id of itemIds) {
      // Check if it's a currency entry or an item
      const currResult = await deleteHiddenCurrency(id);
      if (currResult.status === "success") { deleted++; continue; }
      const itemResult = await deleteHiddenItem(id);
      if (itemResult.status === "success") deleted++;
    }
    ui.notifications.info(`${deleted} item(s) deleted.`);
    this.render();
  }

  static async onRevealAll(event, target) {
    if (!game.user.isGM) return;
    const actor = getBackingActor();
    const hidden = actor ? getHiddenItems(actor) : [];
    const hiddenCurr = actor ? getHiddenCurrency(actor) : [];
    const total = hidden.length + hiddenCurr.length;
    if (total === 0) { ui.notifications.info(`${MODULE_TITLE}: nothing to reveal.`); return; }
    const confirmed = await DialogV2.confirm({
      window: { title: "Reveal All" },
      content: `<p>Reveal all <strong>${total}</strong> hidden entries?</p>`,
      rejectClose: false, modal: true
    });
    if (!confirmed) return;
    const announce = event.shiftKey;
    if (hidden.length > 0) await revealItems(hidden.map(i => i.id), { announce });
    if (hiddenCurr.length > 0) await revealAllHiddenCurrency();
    ui.notifications.info(`All hidden entries revealed.`);
    this.render();
  }

  // ================================================================
  // Currency Loot
  // ================================================================

  static async onAddCurrencyLoot(event, target) {
    if (!game.user.isGM) return;
    const folderId = target.dataset.folderId ?? null;
    const result = await _promptCurrencyLoot(folderId);
    if (result) this.render();
  }

  static async onManageCurrencies() {
    if (!game.user.isGM) return;
    await openCurrencyManager();
  }

  static async onRevealCurrency(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.currencyId;
    if (!entryId) return;
    const result = await revealHiddenCurrency(entryId);
    if (result.status !== "success") {
      ui.notifications.error(`${MODULE_TITLE}: reveal failed — ${result.error}`);
    }
    this.render();
  }

  static async onDeleteCurrency(event, target) {
    if (!game.user.isGM) return;
    const entryId = target.dataset.currencyId;
    if (!entryId) return;
    const result = await deleteHiddenCurrency(entryId);
    if (result.status === "success") ui.notifications.info(`Currency entry deleted.`);
    this.render();
  }

  // ================================================================
  // Folders
  // ================================================================

  static async onCreateFolder(event, target) {
    if (!game.user.isGM) return;
    const result = await _promptFolderName("Create Folder", "");
    if (result) {
      const folder = await createFolder(result);
      if (folder) this.render();
    }
  }

  static async onRenameFolder(event, target) {
    if (!game.user.isGM) return;
    const folderId = target.dataset.folderId;
    if (!folderId) return;
    const actor = getBackingActor();
    const folder = getFolders(actor).find(f => f.id === folderId);
    if (!folder) { this.render(); return; }
    const result = await _promptFolderName("Rename Folder", folder.name);
    if (result) {
      await renameFolder(folderId, result);
      this.render();
    }
  }

  static async onEditFolderNote(event, target) {
    if (!game.user.isGM) return;
    await _editFolderNote(this, target.dataset.folderId);
  }

  static async onDeleteFolder(event, target) {
    if (!game.user.isGM) return;
    const folderId = target.dataset.folderId;
    if (!folderId) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "Delete Folder" },
      content: `<p>Delete this folder? Items inside will move to Uncategorized.</p>`,
      rejectClose: false, modal: true
    });
    if (!confirmed) return;
    await deleteFolder(folderId);
    this.render();
  }

  static async onMoveToFolder(event, target) {
    if (!game.user.isGM) return;
    const itemId = target.dataset.itemId;
    const folderId = target.dataset.folderId || null;
    if (!itemId) return;
    await setItemFolder(itemId, folderId);
    this.render();
  }
}

// ============================================================
// Dialogs
// ============================================================

async function _promptCurrencyLoot(folderId) {
  const currencies = getCurrencies(undefined, { includeHidden: true });
  if (currencies.length === 0) {
    ui.notifications.warn(`${MODULE_TITLE}: no currencies are configured.`);
    return false;
  }
  const defaultId = currencies.find(currency => currency.id === "gp")?.id ?? currencies[0].id;
  const options = currencies.map(currency =>
    `<option value="${escapeHtml(currency.id)}"${currency.id === defaultId ? " selected" : ""}>`
      + `${escapeHtml(currency.name)} (${escapeHtml(currency.symbol)})${currency.hidden ? " - Hidden" : ""}</option>`
  ).join("");
  const content = `
    <form class="qm-pref-form" autocomplete="off">
      <div class="qm-pref-row">
        <label>Currency Type</label>
        <select name="currencyType" class="qm-pref-select">
          ${options}
        </select>
      </div>
      <div class="qm-pref-row">
        <label>Amount</label>
        <input type="number" name="amount" min="0.000001" step="any" value="10" style="width:100px;" />
      </div>
    </form>
  `;

  return new Promise((resolve) => {
    let resolved = false;
    let closeHookId = null;
    let formValues = null;

    const finish = async (saved) => {
      if (resolved) return;
      resolved = true;
      if (closeHookId !== null) {
        try { Hooks.off("closeDialogV2", closeHookId); } catch {}
      }
      if (saved && formValues) {
        await addHiddenCurrency(formValues.type, formValues.amount, folderId);
      }
      resolve(saved);
    };

    const dialog = new DialogV2({
      window: { title: "Add Currency Loot", icon: "fa-solid fa-coins" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "save", label: "Add", icon: "fa-solid fa-plus", default: true,
          callback: (event, btn, dlg) => {
            const root = dlg.element ?? dlg;
            const type = root.querySelector("[name='currencyType']")?.value ?? defaultId;
            const amount = Number.parseFloat(root.querySelector("[name='amount']")?.value);
            if (Number.isFinite(amount) && amount > 0) {
              formValues = { type, amount };
            }
          }
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark",
          callback: () => { formValues = null; }
        }
      ]
    });

    closeHookId = Hooks.on("closeDialogV2", (closedApp) => {
      if (closedApp !== dialog) return;
      finish(formValues !== null);
    });

    dialog.render({ force: true });
  });
}

async function _promptHiddenItemCreate(folderId) {
  const actor = getBackingActor();
  if (!actor) {
    ui.notifications.error(`${MODULE_TITLE}: no backing actor.`);
    return null;
  }

  const itemTypes = game.documentTypes.Item.filter(t => !["base"].includes(t));
  if (itemTypes.length === 0) {
    ui.notifications.error(`${MODULE_TITLE}: no item types are available.`);
    return null;
  }

  const defaultType = itemTypes.includes("loot") ? "loot" : itemTypes[0];
  const options = itemTypes.map(type => {
    const label = game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type);
    return `<option value="${escapeHtml(type)}"${type === defaultType ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");

  const content = `
    <form class="qm-pref-form" autocomplete="off">
      <div class="qm-pref-row">
        <label>Item Name</label>
        <input type="text" name="itemName" value="New Loot" style="flex:1;" />
      </div>
      <div class="qm-pref-row">
        <label>Item Type</label>
        <select name="itemType" class="qm-pref-select">
          ${options}
        </select>
      </div>
      <p class="hint">Creates a hidden Loot Prep item. It will stay hidden from players until revealed.</p>
    </form>
  `;

  return new Promise((resolve) => {
    let resolved = false;
    let closeHookId = null;
    let formValues = null;

    const finish = async (saved) => {
      if (resolved) return;
      resolved = true;
      if (closeHookId !== null) {
        try { Hooks.off("closeDialogV2", closeHookId); } catch {}
      }

      if (!saved || !formValues) {
        resolve(null);
        return;
      }

      try {
        const created = await _createHiddenItem(formValues, folderId);
        resolve(created);
      } catch (err) {
        console.error(`${MODULE_TITLE} | Failed to create hidden Loot Prep item`, err);
        ui.notifications.error(`${MODULE_TITLE}: could not create hidden item.`);
        resolve(null);
      }
    };

    const dialog = new DialogV2({
      window: { title: "Create Loot Prep Item", icon: "fa-solid fa-plus" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "save", label: "Create", icon: "fa-solid fa-plus", default: true,
          callback: (event, btn, dlg) => {
            const root = dlg.element ?? dlg;
            const name = root.querySelector("[name='itemName']")?.value?.trim();
            const type = root.querySelector("[name='itemType']")?.value ?? defaultType;
            if (name && itemTypes.includes(type)) {
              formValues = { name, type };
            }
          }
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark",
          callback: () => { formValues = null; }
        }
      ]
    });

    closeHookId = Hooks.on("closeDialogV2", (closedApp) => {
      if (closedApp !== dialog) return;
      finish(formValues !== null);
    });

    dialog.render({ force: true });
  });
}

async function _createHiddenItem(formValues, folderId) {
  const actor = getBackingActor();
  if (!actor) return null;

  const quartermasterFlags = {
    [FLAGS.HIDDEN]: true
  };
  if (folderId) quartermasterFlags.lootPrepFolder = folderId;

  const itemData = {
    name: formValues.name,
    type: formValues.type,
    img: CONFIG.Item.typeIcons?.[formValues.type] ?? Item.DEFAULT_ICON ?? "icons/svg/item-bag.svg",
    flags: {
      [MODULE_ID]: quartermasterFlags
    }
  };

  const [created] = await actor.createEmbeddedDocuments("Item", [itemData]);
  if (!created) return null;

  await writeEntry({
    type: "hidden.staged",
    requestId: `qm-hidden-staged-${created.id}-${Date.now()}`,
    userId: game.user.id,
    itemId: created.id,
    itemName: created.name ?? "(unknown)",
    backingActorId: actor.id
  });

  ui.notifications.info(`"${created.name}" created in GM Loot Prep.`);
  return created;
}

async function _promptFolderName(title, currentName) {
  const content = `
    <form class="qm-pref-form" autocomplete="off">
      <div class="qm-pref-row">
        <label>Folder Name</label>
        <input type="text" name="folderName" value="${escapeHtml(currentName)}" style="flex:1;" placeholder="e.g., Dragon's Hoard" />
      </div>
    </form>
  `;

  return new Promise((resolve) => {
    let resolved = false;
    let closeHookId = null;
    let result = null;

    const finish = async (saved) => {
      if (resolved) return;
      resolved = true;
      if (closeHookId !== null) {
        try { Hooks.off("closeDialogV2", closeHookId); } catch {}
      }
      resolve(saved ? result : null);
    };

    const dialog = new DialogV2({
      window: { title, icon: "fa-solid fa-folder-plus" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "save", label: "Save", icon: "fa-solid fa-check", default: true,
          callback: (event, btn, dlg) => {
            const root = dlg.element ?? dlg;
            const name = root.querySelector("[name='folderName']")?.value?.trim();
            if (name) result = name;
          }
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark",
          callback: () => { result = null; }
        }
      ]
    });

    closeHookId = Hooks.on("closeDialogV2", (closedApp) => {
      if (closedApp !== dialog) return;
      finish(result !== null);
    });

    dialog.render({ force: true });
  });
}

async function _promptLootPrepNote({ title, currentNote = "", inheritedNote = "" }) {
  const inheritanceHint = inheritedNote
    ? currentNote
      ? `<p class="hint">This item overrides the folder note: <em>${escapeHtml(inheritedNote)}</em>. Clear the item note and save to restore inheritance.</p>`
      : `<p class="hint">This item currently inherits the folder note: <em>${escapeHtml(inheritedNote)}</em>. Saving an item note overrides it.</p>`
    : `<p class="hint">Clear the note and save to remove it.</p>`;
  const content = `
    <form class="qm-pref-form qm-loot-note-form" autocomplete="off">
      <div class="qm-pref-row qm-loot-note-dialog-row">
        <label>Note</label>
        <textarea name="lootPrepNote" rows="5" maxlength="2000" placeholder="Where is this loot found?">${escapeHtml(currentNote)}</textarea>
      </div>
      ${inheritanceHint}
    </form>
  `;

  return new Promise((resolve) => {
    let resolved = false;
    let closeHookId = null;
    let saved = false;
    let result = "";

    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (closeHookId !== null) {
        try { Hooks.off("closeDialogV2", closeHookId); } catch {}
      }
      resolve(saved ? result : null);
    };

    const dialog = new DialogV2({
      window: { title, icon: "fa-solid fa-note-sticky" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "save", label: "Save Note", icon: "fa-solid fa-check", default: true,
          callback: (event, btn, dlg) => {
            const root = dlg.element ?? dlg;
            result = root.querySelector("[name='lootPrepNote']")?.value?.trim() ?? "";
            saved = true;
          }
        },
        {
          action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark",
          callback: () => { saved = false; }
        }
      ]
    });

    closeHookId = Hooks.on("closeDialogV2", (closedApp) => {
      if (closedApp === dialog) finish();
    });

    dialog.render({ force: true });
  });
}

// ============================================================
// Loot Prep note wiring
// ============================================================

function _wireLootPrepNotes(app) {
  const el = app?.element;
  if (!el || !game.user.isGM) return;

  for (const header of el.querySelectorAll(".qm-folder-header[data-folder-id]")) {
    header.addEventListener("contextmenu", (event) => {
      if (event.target.closest("button, input")) return;
      event.preventDefault();
      event.stopPropagation();
      void _editFolderNote(app, header.dataset.folderId);
    });
  }

  for (const row of el.querySelectorAll(".qm-hidden-item-row[data-item-id]")) {
    row.addEventListener("contextmenu", (event) => {
      if (event.target.closest("button, input")) return;
      event.preventDefault();
      event.stopPropagation();
      void _editItemNote(app, row.dataset.itemId);
    });
  }
}

async function _editFolderNote(app, folderId) {
  if (!folderId) return;
  const actor = getBackingActor();
  const folder = getFolders(actor).find(entry => entry.id === folderId);
  if (!folder) return;

  const note = await _promptLootPrepNote({
    title: `Folder Note: ${folder.name}`,
    currentNote: getFolderNote(folder)
  });
  if (note === null) return;

  const saved = await setFolderNote(folderId, note);
  if (!saved) {
    ui.notifications.error(`${MODULE_TITLE}: could not save the folder note.`);
    return;
  }
  ui.notifications.info(note ? `Folder note saved.` : `Folder note cleared.`);
  app.render();
}

async function _editItemNote(app, itemId) {
  if (!itemId) return;
  const actor = getBackingActor();
  const item = actor?.items.get(itemId);
  if (!item) return;

  const folderId = item.getFlag(MODULE_ID, "lootPrepFolder") ?? null;
  const folder = folderId ? getFolders(actor).find(entry => entry.id === folderId) : null;
  const inheritedNote = getFolderNote(folder);
  const note = await _promptLootPrepNote({
    title: `Item Note: ${item.name ?? "(unnamed)"}`,
    currentNote: getItemNote(item),
    inheritedNote
  });
  if (note === null) return;

  const saved = await setItemNote(itemId, note);
  if (!saved) {
    ui.notifications.error(`${MODULE_TITLE}: could not save the item note.`);
    return;
  }
  const message = note
    ? `Item note saved.`
    : inheritedNote ? `Item note cleared; the folder note now applies.` : `Item note cleared.`;
  ui.notifications.info(message);
  app.render();
}

// ============================================================
// Drag-drop wiring
// ============================================================

export function attachHiddenItemDragDrop(app) {
  const el = app?.element;
  if (!el) return;
  const dropZones = el.querySelectorAll(".qm-hidden-drop-zone");
  for (const dropZone of dropZones) {
    dropZone.addEventListener("dragenter", (e) => { e.preventDefault(); dropZone.classList.add("qm-drop-hover"); });
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    dropZone.addEventListener("dragleave", (e) => {
      if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("qm-drop-hover");
    });
    dropZone.addEventListener("drop", (e) => {
      dropZone.classList.remove("qm-drop-hover");
      const folderId = dropZone.dataset.folderId ?? null;
      _onHiddenItemDrop(e, app, folderId);
    });
  }
}

async function _onHiddenItemDrop(event, app, folderId) {
  event.preventDefault();
  if (!game.user.isGM) return;

  let data;
  try { data = JSON.parse(event.dataTransfer.getData("text/plain")); }
  catch { return; }

  const uuid = data.uuid ?? null;
  if (!uuid) return;

  const actor = getBackingActor();
  if (!actor) { ui.notifications.error(`${MODULE_TITLE}: no backing actor.`); return; }

  // Loot Prep internal drag: item already hidden, just move to folder
  if (data[QM_LOOTPREP_DRAG_MARKER]) {
    let sourceItem;
    try { sourceItem = await fromUuid(uuid); } catch { return; }
    if (!sourceItem || sourceItem.parent?.id !== actor.id) return;
    const currentFolder = sourceItem.getFlag(MODULE_ID, "lootPrepFolder") ?? null;
    if (currentFolder === folderId) return; // same folder — no-op
    await setItemFolder(sourceItem.id, folderId);
    ui.notifications.info(`"${sourceItem.name}" moved to ${folderId ? "folder" : "Uncategorized"}.`);
    return;
  }

  // Re-hide flow (from Shared Party Inventory)
  if (data[QM_REHIDE_MARKER]) {
    let sourceItem;
    try { sourceItem = await fromUuid(uuid); } catch { return; }
    if (!sourceItem || sourceItem.parent?.id !== actor.id) return;
    await setItemHidden(sourceItem.id, true);
    await writeEntry({
      type: "hidden.staged",
      requestId: `qm-rehide-${sourceItem.id}-${Date.now()}`,
      userId: game.user.id,
      itemId: sourceItem.id,
      itemName: sourceItem.name,
      backingActorId: actor.id,
      visibility: "gm"
    });
    if (folderId) {
      const { setItemFolder } = await import("../loot-prep-folders.js");
      await setItemFolder(sourceItem.id, folderId);
    }
    ui.notifications.info(`"${sourceItem.name}" moved to hidden loot pool.`);
    return;
  }

  // Compendium / world drop
  let sourceItem;
  try { sourceItem = await fromUuid(uuid); } catch { return; }
  if (!sourceItem || sourceItem.documentName !== "Item") return;

  const rawData = sourceItem.toObject();
  const sanitized = sanitizeItemForTransfer(rawData, actor, { sourceItemUuid: uuid });
  const result = await stageHiddenItem(sanitized);
  if (result.status === "success") {
    if (folderId) {
      const { setItemFolder } = await import("../loot-prep-folders.js");
      await setItemFolder(result.item.id, folderId);
    }
    ui.notifications.info(`"${result.item.name}" staged as hidden loot.`);
    app.render();
  }
}

function _wireHiddenItemDrag(app) {
  const el = app?.element;
  if (!el) return;
  const rows = el.querySelectorAll(".qm-hidden-item-row[data-item-id]");
  for (const row of rows) {
    row.setAttribute("draggable", "true");
    row.addEventListener("dragstart", (event) => {
      const itemId = row.dataset.itemId;
      if (!itemId) return;
      const actor = getBackingActor();
      const item = actor?.items.get(itemId);
      if (!item) return;
      event.dataTransfer.setData("text/plain", JSON.stringify({
        type: "Item", uuid: item.uuid,
        [QM_LOOTPREP_DRAG_MARKER]: true,
        qmSourceItemUuid: item.uuid,
        qmSourceItemName: item.name
      }));
      event.dataTransfer.effectAllowed = "all";
      row.classList.add("qm-being-dragged");
    });
    row.addEventListener("dragend", () => row.classList.remove("qm-being-dragged"));
  }
}

function _wireDoubleClick(app) {
  const el = app?.element;
  if (!el) return;
  const rows = el.querySelectorAll(".qm-hidden-item-row[data-item-id]");
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
    try { await _instance.close(); } catch {}
    _instance = null;
  }
}

export function isLootPrepAppOpen() {
  return Boolean(_instance?.element?.isConnected);
}

// ============================================================
// Auto-refresh hooks
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
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.CUSTOM_RESOURCES}`) ||
        foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.HIDDEN_CURRENCY}`) ||
        foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.LOOT_PREP_FOLDERS}`) ||
        foundry.utils.hasProperty(changes, "system.currency")) {
      scheduleLootPrepRefresh();
    }
  });

  Hooks.on("updateItem", (item, changes) => {
    const b = getBacking();
    if (!b || item.parent?.id !== b.id) return;
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.HIDDEN}`) ||
        foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.lootPrepFolder`) ||
        foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.LOOT_PREP_NOTE}`)) {
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
