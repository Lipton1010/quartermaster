/**
 * Quartermaster - GM currency manager and currency editor.
 */

import { MODULE_ID, MODULE_TITLE } from "../constants.js";
import { getBackingActor } from "../backing-actor.js";
import {
  DEFAULT_CURRENCY_IMAGE,
  getCurrencies,
  getCurrency,
  getReferenceCurrency,
  createCustomCurrency,
  updateCurrency,
  setCurrencyHidden,
  setReferenceCurrency,
  deleteCustomCurrency
} from "../currencies.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class CurrencyManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "quartermaster-currency-manager",
    classes: ["quartermaster", "quartermaster-currency-manager"],
    tag: "section",
    window: {
      title: "Manage Currencies",
      icon: "fa-solid fa-coins",
      resizable: true,
      minimizable: true
    },
    position: { width: 620, height: 640 },
    actions: {
      "add-currency": CurrencyManagerApp.onAddCurrency,
      "edit-currency": CurrencyManagerApp.onEditCurrency,
      "toggle-currency": CurrencyManagerApp.onToggleCurrency,
      "delete-currency": CurrencyManagerApp.onDeleteCurrency
    }
  };

  static PARTS = {
    body: {
      template: "modules/quartermaster/templates/currency-manager.hbs",
      classes: ["quartermaster-body"]
    }
  };

  async _prepareContext() {
    const actor = getBackingActor();
    const allCurrencies = getCurrencies(actor, { includeHidden: true });
    const referenceCurrency = getReferenceCurrency(actor);
    const currencies = allCurrencies.map(currency => ({
      ...currency,
      kindLabel: currency.isCustom ? "Custom" : "Built-in",
      visibilityLabel: currency.hidden ? "Hidden" : "Shown",
      visibilityIcon: currency.hidden ? "fa-solid fa-eye" : "fa-solid fa-eye-slash",
      visibilityActionLabel: currency.hidden ? "Show" : "Hide",
      conversionLabel: formatConversion(currency, referenceCurrency),
      weightLabel: currency.isCustom
        ? currency.weightPerUnit > 0 ? `${currency.weightPerUnit} lb each` : "Weightless"
        : "50 coins per lb",
      canHide: !currency.isReference,
      canDelete: currency.isCustom && !currency.isReference
    }));

    return {
      backingActorPresent: Boolean(actor),
      currencies,
      hasCurrencies: currencies.length > 0,
      referenceCurrency,
      referenceOptions: allCurrencies.map(currency => ({
        ...currency,
        canBeReference: currency.referenceRate != null
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const select = this.element?.querySelector(".qm-reference-currency-select");
    select?.addEventListener("change", async () => {
      select.disabled = true;
      const result = await setReferenceCurrency(select.value);
      if (result.status === "success") {
        const thresholdMessage = result.approvalThreshold == null
          ? ""
          : ` Approval threshold: ${result.approvalThreshold} ${result.currency.symbol}.`;
        ui.notifications.info(
          `${result.currency.name} is now the reference currency.${thresholdMessage}`
        );
      } else {
        notifyFailure(result);
      }
      this.render();
    });
  }

  static async onAddCurrency() {
    if (!game.user.isGM) return;
    const saved = await promptCurrencyEdit();
    if (saved) this.render();
  }

  static async onEditCurrency(event, target) {
    if (!game.user.isGM) return;
    const saved = await promptCurrencyEdit(target.dataset.currencyId);
    if (saved) this.render();
  }

  static async onToggleCurrency(event, target) {
    if (!game.user.isGM) return;
    const currency = getCurrency(target.dataset.currencyId);
    if (!currency) return;
    const result = await setCurrencyHidden(currency.id, !currency.hidden);
    if (result.status !== "success") notifyFailure(result);
    this.render();
  }

  static async onDeleteCurrency(event, target) {
    if (!game.user.isGM) return;
    const currency = getCurrency(target.dataset.currencyId);
    if (!currency?.isCustom) return;

    const confirmed = await DialogV2.confirm({
      window: { title: `Delete ${currency.name}?`, icon: "fa-solid fa-trash" },
      content: `<p>Delete <strong>${escapeHtml(currency.name)}</strong> and its current balance of `
        + `<strong>${currency.value} ${escapeHtml(currency.symbol)}</strong>?</p>`
        + `<p>This cannot be undone.</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;

    const result = await deleteCustomCurrency(currency.id);
    if (result.status === "success") {
      ui.notifications.info(`${currency.name} deleted.`);
    } else {
      notifyFailure(result);
    }
    this.render();
  }
}

let _instance = null;

export async function openCurrencyManager() {
  if (!game.user.isGM) {
    ui.notifications.warn(`${MODULE_TITLE}: only a GM can manage currencies.`);
    return null;
  }
  if (!_instance) _instance = new CurrencyManagerApp();
  await _instance.render({ force: true });
  return _instance;
}

export async function openCurrencyEditor(currencyId) {
  if (!game.user.isGM) return false;
  const saved = await promptCurrencyEdit(currencyId);
  if (saved && _instance?.element?.isConnected) _instance.render();
  return saved;
}

async function promptCurrencyEdit(currencyId = null) {
  const currency = currencyId ? getCurrency(currencyId) : null;
  if (currencyId && !currency) {
    ui.notifications.warn(`${MODULE_TITLE}: currency not found.`);
    return false;
  }

  const isEdit = Boolean(currency);
  const isStandard = Boolean(currency && !currency.isCustom);
  const referenceCurrency = getReferenceCurrency();
  const isReference = Boolean(currency?.isReference);
  const title = isStandard
    ? `Edit ${currency.name}`
    : isEdit ? `Edit Currency: ${currency.name}` : "Add Custom Currency";
  const initial = currency ?? {
    name: "",
    symbol: "",
    image: "",
    value: 0,
    referenceRate: null,
    weightPerUnit: 0
  };

  const customFields = isStandard ? "" : `
    <div class="form-group">
      <label for="qm-cur-name">Name</label>
      <input type="text" id="qm-cur-name" name="name" value="${escapeAttribute(initial.name)}"
             placeholder="e.g. Credits" maxlength="80" required autofocus />
    </div>
    <div class="form-group">
      <label for="qm-cur-symbol">Short Label</label>
      <input type="text" id="qm-cur-symbol" name="symbol" value="${escapeAttribute(initial.symbol)}"
             placeholder="e.g. CR" maxlength="12" required />
      <p class="hint">Displayed above the balance in the inventory tile.</p>
    </div>
    <div class="form-group">
      <label for="qm-cur-value">${isEdit ? "Current Balance" : "Starting Balance"}</label>
      <input type="number" id="qm-cur-value" name="value" value="${initial.value}"
             min="0" step="any" />
    </div>
    <div class="form-group">
      <label for="qm-cur-weight">Weight per Unit (lb)</label>
      <input type="number" id="qm-cur-weight" name="weightPerUnit" value="${initial.weightPerUnit ?? 0}"
             min="0" step="any" placeholder="0" />
      <p class="hint">Optional. Use 0 for weightless. Applied only when Currency Counts Toward Weight is enabled.</p>
    </div>
  `;

  const conversionFields = isReference ? `
    <fieldset class="qm-conversion-fields">
      <legend>Reference Conversion</legend>
      <div class="qm-conversion-row">
        <span>1 ${escapeHtml(initial.symbol)} = 1 ${escapeHtml(initial.symbol)}</span>
      </div>
      <p class="hint">The selected reference currency is fixed at 1. Choose another reference in Manage Currencies to edit this rate.</p>
    </fieldset>
  ` : `
    <fieldset class="qm-conversion-fields">
      <legend>${isStandard ? "Reference Conversion" : "Optional Reference Conversion"}</legend>
      <div class="qm-conversion-row">
        <span>1 ${escapeHtml(initial.symbol || "custom unit")} equals</span>
        <input type="number" name="referenceRate" value="${initial.referenceRate ?? ""}"
               min="0.000000000001" step="any" placeholder="${isStandard ? "Rate" : "No conversion"}" />
        <strong>${escapeHtml(referenceCurrency?.symbol ?? "GP")}</strong>
      </div>
      <p class="hint">${isStandard
        ? `Enter this currency's value in ${escapeHtml(referenceCurrency?.name ?? "Gold")}.`
        : `Leave blank to exclude this currency from equivalent totals and approval-threshold calculations.`}</p>
    </fieldset>
  `;

  const content = `
    <form class="qm-currency-edit" autocomplete="off">
      ${customFields}
      ${conversionFields}
      <div class="form-group">
        <label for="qm-cur-image">Tile Background Image</label>
        <div class="qm-currency-image-control">
          <img class="qm-currency-image-preview" src="${escapeAttribute(initial.image || DEFAULT_CURRENCY_IMAGE)}" alt="" />
          <input type="text" id="qm-cur-image" name="image" value="${escapeAttribute(initial.image)}"
                 placeholder="Optional image path" />
          <button type="button" class="qm-pick-currency-image" title="Browse for image">
            <i class="fa-solid fa-folder-open"></i>
          </button>
        </div>
        <p class="hint">Shown as a subtle image behind this currency's balance.</p>
      </div>
    </form>
  `;

  return new Promise(resolve => {
    let resolved = false;
    let closeHookId = null;
    const finish = value => {
      if (resolved) return;
      resolved = true;
      if (closeHookId !== null) Hooks.off("closeDialogV2", closeHookId);
      resolve(value);
    };

    const dialog = new DialogV2({
      window: { title, icon: isEdit ? "fa-solid fa-pen" : "fa-solid fa-plus" },
      position: { width: 500 },
      classes: ["quartermaster"],
      content,
      rejectClose: false,
      buttons: [
        {
          action: "save",
          label: isEdit ? "Save" : "Add Currency",
          icon: "fa-solid fa-check",
          default: true,
          callback: async (event, button, dlg) => {
            const root = dlg.element;
            const data = readCurrencyForm(root, initial, isStandard, isReference);
            if (!data) throw new Error("validation-failed");
            const result = isEdit
              ? await updateCurrency(currency.id, data)
              : await createCustomCurrency(data);
            if (result.status !== "success") {
              notifyFailure(result);
              throw new Error("validation-failed");
            }
            finish(true);
          }
        },
        {
          action: "cancel",
          label: "Cancel",
          icon: "fa-solid fa-xmark",
          callback: () => finish(false)
        }
      ]
    });

    closeHookId = Hooks.on("closeDialogV2", closed => {
      if (closed === dialog) finish(false);
    });

    dialog.render({ force: true }).then(() => wireImagePicker(dialog));
  });
}

function readCurrencyForm(root, initial, isStandard, isReference) {
  const image = root.querySelector("[name='image']")?.value?.trim() ?? "";
  const rateRaw = root.querySelector("[name='referenceRate']")?.value ?? "";
  const referenceRate = isReference ? 1 : rateRaw === "" ? null : Number(rateRaw);

  if (!isReference && isStandard && (!Number.isFinite(referenceRate) || referenceRate <= 0)) {
    ui.notifications.warn(`${MODULE_TITLE}: built-in currencies require a positive conversion rate.`);
    return null;
  }
  if (!isReference && !isStandard && referenceRate != null
      && (!Number.isFinite(referenceRate) || referenceRate <= 0)) {
    ui.notifications.warn(`${MODULE_TITLE}: enter a positive conversion rate or leave it blank.`);
    return null;
  }
  if (isStandard) return { image, referenceRate };

  const name = root.querySelector("[name='name']")?.value?.trim() ?? "";
  const symbol = root.querySelector("[name='symbol']")?.value?.trim() ?? "";
  const value = Number(root.querySelector("[name='value']")?.value ?? 0);
  const weightRaw = root.querySelector("[name='weightPerUnit']")?.value ?? "";
  const weightPerUnit = weightRaw === "" ? 0 : Number(weightRaw);

  if (!name || !symbol) {
    ui.notifications.warn(`${MODULE_TITLE}: currency name and short label are required.`);
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    ui.notifications.warn(`${MODULE_TITLE}: balance must be zero or greater.`);
    return null;
  }
  if (!Number.isFinite(weightPerUnit) || weightPerUnit < 0) {
    ui.notifications.warn(`${MODULE_TITLE}: weight per unit must be zero or greater.`);
    return null;
  }
  return {
    name,
    symbol,
    image,
    value,
    hidden: initial.hidden ?? false,
    referenceRate,
    weightPerUnit
  };
}

function wireImagePicker(dialog) {
  const root = dialog.element;
  const input = root?.querySelector("[name='image']");
  const preview = root?.querySelector(".qm-currency-image-preview");
  const button = root?.querySelector(".qm-pick-currency-image");
  if (!input) return;

  input.addEventListener("input", () => {
    if (preview) preview.src = input.value || DEFAULT_CURRENCY_IMAGE;
  });
  button?.addEventListener("click", () => {
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: input.value,
      callback: path => {
        input.value = path;
        if (preview) preview.src = path;
      }
    });
    picker.render(true);
  });
}

function notifyFailure(result) {
  const messages = {
    "duplicate-symbol": "That short label is already used by another custom currency.",
    "currency-has-staged-loot": "Reveal or delete this currency's staged Loot Prep entries before deleting it.",
    "currency-has-no-conversion": "Set a conversion rate for that currency before making it the reference.",
    "reference-currency": "Choose a different reference currency before hiding or deleting this one.",
    "invalid-conversion-rate": "Enter a positive conversion rate.",
    "currency-not-found": "Currency not found.",
    "standard-currency": "Built-in currencies cannot be deleted.",
    "name-required": "Currency name is required.",
    "symbol-required": "Currency short label is required."
  };
  ui.notifications.warn(`${MODULE_TITLE}: ${messages[result?.error] ?? result?.error ?? "currency update failed"}`);
}

function formatConversion(currency, referenceCurrency) {
  if (currency.isReference) return `Reference: 1 ${currency.symbol} = 1 ${currency.symbol}`;
  if (currency.referenceRate == null) return "No conversion";
  return `1 ${currency.symbol} = ${currency.referenceRate} ${referenceCurrency?.symbol ?? "GP"}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
