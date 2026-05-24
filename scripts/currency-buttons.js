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
import { getBackingActor } from "./backing-actor.js";
import { needsApprovalForCurrentUser } from "./approval-policy.js";

const { DialogV2 } = foundry.applications.api;

const CURRENCY_FULL_NAMES = {
  pp: "Platinum Pieces",
  gp: "Gold Pieces",
  ep: "Electrum Pieces",
  sp: "Silver Pieces",
  cp: "Copper Pieces"
};

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
  const currencyType = btn.dataset.currency; // pp | gp | ep | sp | cp
  if (!action || !currencyType) return;

  const direction = action === "currency-add" ? "add" : "remove";

  // Shift+click: fast path, ±1 immediately, skip dialog
  if (event.shiftKey) {
    const delta = direction === "add" ? 1 : -1;
    await submitCurrencyChange({ currencyType, delta });
    return;
  }

  // Normal click: open the amount dialog
  const backingActor = getBackingActor();
  const currentBalance = backingActor?.system?.currency?.[currencyType] ?? 0;

  const amount = await promptCurrencyAmount({
    currencyType,
    direction,
    currentBalance
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
async function promptCurrencyAmount({ currencyType, direction, currentBalance }) {
  const isAdd = direction === "add";
  const fullName = CURRENCY_FULL_NAMES[currencyType] ?? currencyType.toUpperCase();
  const verb = isAdd ? "Add" : "Remove";
  const symbol = currencyType.toUpperCase();

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
          min="1"
          max="999999"
          step="1"
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
            const raw = parseInt(input?.value ?? "0", 10);
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

  // If approval is likely needed (player-side, non-FREE mode), show a
  // pending notice so the user knows the GM was prompted and the lag is
  // expected. GMs adjusting their own currency skip this entirely.
  let pendingNotif = null;
  if (needsApprovalForCurrentUser({ delta })) {
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
  const symbol = currencyType.toUpperCase();
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
