/**
 * Quartermaster — Preferences Dialogs (step 17)
 *
 * Per-popup gear dialogs for client-scope preferences.
 * Uses the canonical closeDialogV2 hook pattern (R-22).
 *
 * Pattern: Save button callback reads form values synchronously (while DOM
 * exists), stashes them. The closeDialogV2 hook then writes settings and
 * resolves the promise. This avoids the V14 issue where DialogV2 does not
 * await async button callbacks.
 */

import { MODULE_ID, MODULE_TITLE, SETTINGS, CHOICES, HOOKS } from "../constants.js";

const { DialogV2 } = foundry.applications.api;

function escapeHtml(s) {
  if (typeof s !== "string") return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function radioGroup(name, options, currentValue) {
  return options.map(([value, label]) => {
    const checked = value === currentValue ? "checked" : "";
    return `<label class="qm-pref-radio"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${checked}> ${escapeHtml(label)}</label>`;
  }).join("\n");
}

function selectGroup(name, options, currentValue) {
  const opts = options.map(([value, label]) => {
    const sel = value === currentValue ? "selected" : "";
    return `<option value="${escapeHtml(value)}" ${sel}>${escapeHtml(label)}</option>`;
  }).join("\n");
  return `<select name="${escapeHtml(name)}" class="qm-pref-select">${opts}</select>`;
}

function checkbox(name, currentValue, label) {
  const checked = currentValue ? "checked" : "";
  return `<label class="qm-pref-checkbox"><input type="checkbox" name="${escapeHtml(name)}" ${checked}> ${escapeHtml(label)}</label>`;
}

async function writePreferences(entries) {
  const changedKeys = [];
  for (const [key, value] of entries) {
    const current = game.settings.get(MODULE_ID, key);
    if (current !== value) {
      await game.settings.set(MODULE_ID, key, value);
      changedKeys.push(key);
    }
  }
  if (changedKeys.length > 0) {
    Hooks.callAll(HOOKS.PREFERENCES_CHANGED, { keys: changedKeys });
  }
  return changedKeys;
}

// ============================================================
// Shared dialog runner
// ============================================================

function _showPreferencesDialog(title, content, readFn) {
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
        await writePreferences(formValues);
      }
      resolve(saved);
    };

    const dialog = new DialogV2({
      window: { title, icon: "fa-solid fa-gear" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "save",
          label: "Save",
          icon: "fa-solid fa-check",
          default: true,
          callback: (event, btn, dlg) => {
            const root = dlg.element ?? dlg;
            formValues = readFn(root);
          }
        },
        {
          action: "cancel",
          label: "Cancel",
          icon: "fa-solid fa-xmark",
          callback: () => {
            formValues = null;
          }
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

// ============================================================
// Inventory Preferences
// ============================================================

export function promptInventoryPreferences() {
  const currentSort = game.settings.get(MODULE_ID, SETTINGS.SORT_ORDER);
  const currentSize = game.settings.get(MODULE_ID, SETTINGS.DEFAULT_ENTRY_SIZE);
  const currentHide = game.settings.get(MODULE_ID, SETTINGS.HIDE_ZERO_BALANCES);
  const currentHideEP = game.settings.get(MODULE_ID, SETTINGS.HIDE_ELECTRUM);

  const content = `
    <form class="qm-pref-form" autocomplete="off">
      <fieldset class="qm-pref-fieldset">
        <legend>Sort Order</legend>
        ${radioGroup("sortOrder", [
          [CHOICES.SORT_ORDER.CURRENCY_FIRST, "Currencies first"],
          [CHOICES.SORT_ORDER.ALPHABETICAL,   "Alphabetical"],
          [CHOICES.SORT_ORDER.BY_TYPE,        "By item type"],
          [CHOICES.SORT_ORDER.CUSTOM,         "Manual (custom)"]
        ], currentSort)}
      </fieldset>
      <fieldset class="qm-pref-fieldset">
        <legend>Entry Size</legend>
        ${radioGroup("entrySize", [
          [CHOICES.ENTRY_SIZE.COMPACT, "Compact"],
          [CHOICES.ENTRY_SIZE.MEDIUM,  "Medium"],
          [CHOICES.ENTRY_SIZE.LARGE,   "Large"]
        ], currentSize)}
      </fieldset>
      <div class="qm-pref-row">
        ${checkbox("hideZero", currentHide, "Hide currencies at zero")}
      </div>
      <div class="qm-pref-row">
        ${checkbox("hideElectrum", currentHideEP, "Hide Electrum (EP)")}
      </div>
    </form>
  `;

  return _showPreferencesDialog("Inventory Preferences", content, (root) => [
    [SETTINGS.SORT_ORDER, root.querySelector("[name='sortOrder']:checked")?.value ?? currentSort],
    [SETTINGS.DEFAULT_ENTRY_SIZE, root.querySelector("[name='entrySize']:checked")?.value ?? currentSize],
    [SETTINGS.HIDE_ZERO_BALANCES, root.querySelector("[name='hideZero']")?.checked ?? currentHide],
    [SETTINGS.HIDE_ELECTRUM, root.querySelector("[name='hideElectrum']")?.checked ?? currentHideEP]
  ]);
}

// ============================================================
// Transaction Log Preferences
// ============================================================

export function promptTransactionLogPreferences() {
  const currentPhase    = game.settings.get(MODULE_ID, SETTINGS.LOG_DEFAULT_PHASE_FILTER);
  const currentCategory = game.settings.get(MODULE_ID, SETTINGS.LOG_DEFAULT_CATEGORY_FILTER);
  const currentExpand   = game.settings.get(MODULE_ID, SETTINGS.LOG_AUTO_EXPAND_GROUPS);

  const content = `
    <form class="qm-pref-form" autocomplete="off">
      <div class="qm-pref-row">
        <label>Default Phase Filter</label>
        ${selectGroup("phaseFilter", [
          ["all","All"],["commit","Commit"],["failed","Failed"],["denied","Denied"],["claim","Claim"]
        ], currentPhase)}
      </div>
      <div class="qm-pref-row">
        <label>Default Category Filter</label>
        ${selectGroup("categoryFilter", [
          ["all","All"],["transfer","Transfer"],["currency","Currency"],["resource","Resource"],["hidden","Hidden"],["import","Import"],["unknown","Unknown"]
        ], currentCategory)}
      </div>
      <div class="qm-pref-row">
        ${checkbox("autoExpand", currentExpand, "Auto-expand all groups on open")}
      </div>
    </form>
  `;

  return _showPreferencesDialog("Transaction Log Preferences", content, (root) => [
    [SETTINGS.LOG_DEFAULT_PHASE_FILTER, root.querySelector("[name='phaseFilter']")?.value ?? currentPhase],
    [SETTINGS.LOG_DEFAULT_CATEGORY_FILTER, root.querySelector("[name='categoryFilter']")?.value ?? currentCategory],
    [SETTINGS.LOG_AUTO_EXPAND_GROUPS, root.querySelector("[name='autoExpand']")?.checked ?? currentExpand]
  ]);
}
