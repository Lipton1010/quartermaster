/**
 * Quartermaster — Currency Button Handlers (step 10)
 *
 * Wires the +/− buttons on each currency tile to the socket pipeline.
 * On normal click, opens a small dialog with quick-pick amounts and a
 * custom input. On shift+click, applies +1 / −1 immediately without the
 * dialog (fast adjustment for small amounts).
 *
 * No approval flow at this stage. All requests execute immediately when
 * routed to the GM. Approval lands in step 13.
 */

import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { PAYLOAD_TYPES, submitRequest } from "./socket-handler.js";
import { needsApprovalForCurrentUser } from "./approval-policy.js";
import { getCurrency, getCurrencies, setCurrencyHidden } from "./currencies.js";
import { openCurrencyEditor, openCurrencyManager } from "./apps/currency-manager-app.js";

const { DialogV2 } = foundry.applications.api;

const QUICK_PICKS = [1, 5, 10, 25, 100];

// ============================================================
// Public API — attach handlers to a rendered popup
// ============================================================

/**
 * Bind click handlers on every currency button in the popup. Called from
 * InventoryApp._onRender after each render. Idempotent because the DOM
 * is replaced each time.
 */
export function attachCurrencyButtons(app) {
  const el = app?.element;
  if (!el) return;

  const buttons = el.querySelectorAll(".qm-currency-btn");
  for (const btn of buttons) {
    btn.addEventListener("click", onCurrencyButtonClick);
  }

  if (game.user.isGM) {
    for (const tile of el.querySelectorAll(".qm-currency-tile[data-currency-id]")) {
      tile.addEventListener("contextmenu", event => showCurrencyContextMenu(event, app));
    }
  }

  console.debug(
    `${MODULE_TITLE} | currency buttons wired: ${buttons.length}`
  );
}

// ============================================================
// Click handler
// ============================================================

async function onCurrencyButtonClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const btn = event.currentTarget;
  const action = btn.dataset.action; // "currency-add" | "currency-remove"
  const currencyType = btn.dataset.currencyId;
  if (!action || !currencyType) return;
  const currency = getCurrency(currencyType);
  if (!currency) return;

  const direction = action === "currency-add" ? "add" : "remove";

  // Shift+click: fast path, ±1 immediately, skip dialog
  if (event.shiftKey) {
    const delta = direction === "add" ? 1 : -1;
    await submitCurrencyChange({ currencyType, delta });
    return;
  }

  // Normal click: open the amount dialog
  const amount = await promptCurrencyAmount({
    currency,
    direction,
    currentBalance: currency.value
  });

  if (amount === null || amount === 0) return;

  const delta = direction === "add" ? amount : -amount;
  await submitCurrencyChange({ currencyType, delta });
}

// ============================================================
// Amount dialog
// ============================================================

/**
 * Show a dialog to pick an amount for a currency change. Returns the
 * positive amount entered, or null if cancelled.
 */
async function promptCurrencyAmount({ currency, direction, currentBalance }) {
  const isAdd = direction === "add";
  const fullName = currency.name;
  const verb = isAdd ? "Add" : "Remove";
  const symbol = currency.symbol;

  const quickPickHtml = QUICK_PICKS
    .map(n => `<button type="button" class="qm-pick" data-amount="${n}">${n}</button>`)
    .join("");

  const content = `
    <div class="qm-currency-dialog">
      <p class="qm-current-balance">
        Current: <strong>${currentBalance} ${symbol}</strong>
      </p>
      <div class="qm-quick-picks-row">
        <span class="qm-pick-label">Quick:</span>
        ${quickPickHtml}
      </div>
      <div class="form-group qm-custom-row">
        <label for="qm-amount-input">Amount:</label>
        <input
          type="number"
          id="qm-amount-input"
          name="amount"
          value=""
          min="0.000001"
          max="999999"
          step="any"
          autofocus
        />
      </div>
    </div>
  `;

  return new Promise((resolve) => {
    let resolved = false;
    const dialog = new DialogV2({
      window: {
        title: `${verb} ${fullName}`,
        icon: isAdd ? "fa-solid fa-plus" : "fa-solid fa-minus"
      },
      position: { width: 380 },
      content,
      buttons: [
        {
          action: "confirm",
          label: verb,
          icon: isAdd ? "fa-solid fa-plus" : "fa-solid fa-minus",
          default: true,
          callback: (event, button, dlg) => {
            const input = dlg.element.querySelector("#qm-amount-input");
            const raw = Number.parseFloat(input?.value ?? "0");
            const amount = Number.isFinite(raw) && raw > 0 ? raw : 0;
            resolved = true;
            resolve(amount);
          }
        },
        {
          action: "cancel",
          label: "Cancel",
          icon: "fa-solid fa-xmark",
          callback: () => {
            resolved = true;
            resolve(null);
          }
        }
      ],
      close: () => {
        if (!resolved) resolve(null);
      },
      rejectClose: false
    });

    dialog.render({ force: true }).then(() => {
      // Wire quick-pick buttons to populate the input
      const input = dialog.element.querySelector("#qm-amount-input");
      const picks = dialog.element.querySelectorAll(".qm-pick");
      for (const pick of picks) {
        pick.addEventListener("click", () => {
          if (input) {
            input.value = pick.dataset.amount;
            input.focus();
            input.select();
          }
        });
      }
    });
  });
}

// ============================================================
// Request submission
// ============================================================

async function submitCurrencyChange({ currencyType, delta, reason = "manual" }) {
  const requestId = `qm-${foundry.utils.randomID()}`;
  const currency = getCurrency(currencyType);
  const referenceValue = currency?.referenceRate == null
    ? 0
    : Math.abs(delta * currency.referenceRate);

  // If approval is likely needed (player-side, non-FREE mode), show a
  // pending notice so the user knows the GM was prompted and the lag is
  // expected. GMs adjusting their own currency skip this entirely.
  let pendingNotif = null;
  if (needsApprovalForCurrentUser({ delta, referenceValue })) {
    pendingNotif = ui.notifications.info(
      `${MODULE_TITLE}: waiting for GM approval...`,
      { permanent: true }
    );
  }

  let result;
  try {
    result = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: {
        currencyType,
        delta,
        reason
      }
    });
  } finally {
    // Dismiss the pending notice once we have a decision (success, fail, deny)
    if (pendingNotif) {
      try { ui.notifications.remove?.(pendingNotif); } catch { /* ignore */ }
    }
  }

  notifyCurrencyResult(result, currencyType, delta);
}

function notifyCurrencyResult(result, currencyType, delta) {
  const currency = getCurrency(currencyType);
  const symbol = result?.resultData?.currencySymbol ?? currency?.symbol ?? currencyType.toUpperCase();
  const absAmount = Math.abs(delta);
  const isAdd = delta >= 0;

  if (!result) {
    ui.notifications.error(`${MODULE_TITLE}: currency change returned no result.`);
    return;
  }

  if (result.status === "success") {
    if (result.resultData?.noop) {
      // Zero delta — don't notify
      return;
    }
    const verb = isAdd ? "added" : "removed";
    const newBalance = result.resultData?.newValue;
    ui.notifications.info(
      `${absAmount} ${symbol} ${verb}. New balance: ${newBalance} ${symbol}.`
    );
    return;
  }

  // Denial path (step 13): clean rejection, distinct from a failure
  if (result.status === "denied") {
    if (result.error === "approval-timeout") {
      ui.notifications.warn(
        `${MODULE_TITLE}: approval request timed out. No GM responded.`
      );
    } else {
      ui.notifications.warn(
        `${MODULE_TITLE}: GM denied the ${symbol} request.`
      );
    }
    return;
  }

  // Failure path: specific messaging for the known error codes
  if (result.error === "insufficient-funds") {
    ui.notifications.warn(
      `Not enough ${symbol}. Vault has ${result.currentBalance}, ` +
      `tried to remove ${result.requested}.`
    );
    return;
  }
  if (result.error === "no-backing-actor") {
    ui.notifications.error(`${MODULE_TITLE}: backing actor not initialized.`);
    return;
  }
  if (result.error === "invalid-currency-type") {
    ui.notifications.error(
      `${MODULE_TITLE}: invalid currency type "${result.currencyType}".`
    );
    return;
  }
  if (result.error === "invalid-delta") {
    ui.notifications.error(`${MODULE_TITLE}: invalid delta value.`);
    return;
  }

  ui.notifications.error(
    `Currency change failed: ${result.error ?? "unknown error"}`
  );
}

// ============================================================
// GM right-click visibility menu
// ============================================================

let currencyMenuOutsideHandler = null;

function showCurrencyContextMenu(event, app) {
  event.preventDefault();
  event.stopPropagation();
  closeCurrencyContextMenu();

  const currencyId = event.currentTarget.dataset.currencyId;
  const currency = getCurrency(currencyId);
  if (!currency) return;
  const hidden = getCurrencies(undefined, { includeHidden: true })
    .filter(entry => entry.hidden);

  const menu = document.createElement("nav");
  menu.className = "qm-context-menu qm-currency-context-menu";
  const list = document.createElement("ul");
  list.className = "qm-context-menu-list";
  menu.appendChild(list);

  addMenuItem(list, {
    icon: "fa-solid fa-eye-slash",
    label: `Hide ${currency.name}`,
    action: async () => {
      await setCurrencyHidden(currency.id, true);
      app.render();
    }
  });
  addMenuItem(list, {
    icon: "fa-solid fa-pen",
    label: `Edit ${currency.name}`,
    action: async () => {
      await openCurrencyEditor(currency.id);
      app.render();
    }
  });

  for (const entry of hidden) {
    addMenuItem(list, {
      icon: "fa-solid fa-eye",
      label: `Show ${entry.name}`,
      action: async () => {
        await setCurrencyHidden(entry.id, false);
        app.render();
      }
    });
  }

  addMenuItem(list, {
    icon: "fa-solid fa-coins",
    label: "Manage Currencies...",
    action: () => openCurrencyManager()
  });

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4))}px`;
  // Keep clicks inside the menu alive. The old one-shot pointerdown handler
  // removed the menu before its later click event could run an action.
  currencyMenuOutsideHandler = pointerEvent => {
    if (pointerEvent.target?.closest?.(".qm-currency-context-menu")) return;
    closeCurrencyContextMenu();
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", currencyMenuOutsideHandler, true);
  }, 0);
}

function addMenuItem(list, { icon, label, action }) {
  const item = document.createElement("li");
  item.className = "qm-context-menu-item";
  const iconEl = document.createElement("i");
  iconEl.className = icon;
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  item.append(iconEl, labelEl);
  item.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    closeCurrencyContextMenu();
    await action();
  });
  list.appendChild(item);
}

function closeCurrencyContextMenu() {
  if (currencyMenuOutsideHandler) {
    document.removeEventListener("pointerdown", currencyMenuOutsideHandler, true);
    currencyMenuOutsideHandler = null;
  }
  document.querySelectorAll(".qm-currency-context-menu").forEach(menu => menu.remove());
}
