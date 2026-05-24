/**
 * Quartermaster — Resource Button Handlers (step 14)
 *
 * Wires the +/− buttons on each custom resource row in the inventory
 * popup. Mirrors the currency-buttons.js pattern: normal click opens a
 * small amount dialog, shift+click applies ±1 immediately.
 *
 * No approval flow for resources at this stage (GMs curate resources;
 * the threshold/approval model for currency doesn't map cleanly).
 */

import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { PAYLOAD_TYPES, submitRequest } from "./socket-handler.js";
import { getResource } from "./resources.js";

const { DialogV2 } = foundry.applications.api;

const QUICK_PICKS = [1, 2, 3, 5, 10];

// ============================================================
// Wiring (called from inventory app _onRender)
// ============================================================

export function attachResourceButtons(app) {
  const el = app?.element;
  if (!el) return;

  const buttons = el.querySelectorAll(".qm-resource-btn");
  for (const btn of buttons) {
    btn.addEventListener("click", onResourceButtonClick);
  }
}

// ============================================================
// Click handler
// ============================================================

async function onResourceButtonClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const btn = event.currentTarget;
  const action = btn.dataset.action; // "resource-add" | "resource-remove"
  const resourceId = btn.dataset.resourceId;
  if (!action || !resourceId) return;

  const direction = action === "resource-add" ? "add" : "remove";

  if (event.shiftKey) {
    const delta = direction === "add" ? 1 : -1;
    await submitResourceChange({ resourceId, delta });
    return;
  }

  const resource = getResource(resourceId);
  if (!resource) {
    ui.notifications.warn(`${MODULE_TITLE}: resource not found.`);
    return;
  }

  const amount = await promptResourceAmount({
    resource,
    direction
  });

  if (amount === null || amount === 0) return;
  const delta = direction === "add" ? amount : -amount;
  await submitResourceChange({ resourceId, delta });
}

// ============================================================
// Amount dialog
// ============================================================

async function promptResourceAmount({ resource, direction }) {
  const isAdd = direction === "add";
  const verb = isAdd ? "Add to" : "Remove from";
  const maxLabel = resource.max != null ? ` / ${resource.max}` : "";

  const quickPickHtml = QUICK_PICKS
    .map(n => `<button type="button" class="qm-pick" data-amount="${n}">${n}</button>`)
    .join("");

  const content = `
    <div class="qm-currency-dialog">
      <p class="qm-current-balance">
        Current: <strong>${resource.value}${maxLabel}</strong>
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
    let closeHookId = null;

    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      if (closeHookId !== null) {
        try { Hooks.off("closeDialogV2", closeHookId); } catch { /* ignore */ }
      }
      resolve(value);
    };

    const dialog = new DialogV2({
      window: {
        title: `${verb} ${resource.name}`,
        icon: isAdd ? "fa-solid fa-plus" : "fa-solid fa-minus"
      },
      position: { width: 380 },
      content,
      buttons: [
        {
          action: "confirm",
          label: isAdd ? "Add" : "Remove",
          icon: isAdd ? "fa-solid fa-plus" : "fa-solid fa-minus",
          default: true,
          callback: (event, button, dlg) => {
            const input = dlg.element.querySelector("#qm-amount-input");
            const raw = parseInt(input?.value ?? "0", 10);
            finish(Number.isFinite(raw) && raw > 0 ? raw : 0);
          }
        },
        {
          action: "cancel",
          label: "Cancel",
          icon: "fa-solid fa-xmark",
          callback: () => finish(null)
        }
      ],
      rejectClose: false
    });

    closeHookId = Hooks.on("closeDialogV2", (closedApp) => {
      if (closedApp !== dialog) return;
      if (!resolved) finish(null);
    });

    dialog.render({ force: true }).then(() => {
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
// Submission
// ============================================================

async function submitResourceChange({ resourceId, delta, reason = "manual" }) {
  const requestId = `qm-${foundry.utils.randomID()}`;
  const result = await submitRequest({
    type: PAYLOAD_TYPES.CUSTOM_RESOURCE_CHANGE,
    requestId,
    timestamp: Date.now(),
    userId: game.user.id,
    payload: { resourceId, delta, reason }
  });
  notifyResourceResult(result, delta);
}

function notifyResourceResult(result, delta) {
  if (!result) {
    ui.notifications.error(`${MODULE_TITLE}: resource change returned no result.`);
    return;
  }
  if (result.status === "success") {
    if (result.resultData?.noop) return;
    const name = result.resultData?.resourceName ?? "Resource";
    const verb = delta >= 0 ? "added to" : "removed from";
    const abs = Math.abs(delta);
    const newVal = result.resultData?.newValue;
    ui.notifications.info(
      `${abs} ${verb} ${name}. Now at ${newVal}.`
    );
    return;
  }

  if (result.error === "resource-not-found") {
    ui.notifications.error(`${MODULE_TITLE}: resource no longer exists.`);
    return;
  }
  if (result.error === "insufficient-resource") {
    ui.notifications.warn(
      `Not enough ${result.resourceName ?? "resource"}: ${result.currentValue} available, tried to remove ${result.requested}.`
    );
    return;
  }
  if (result.error === "max-exceeded") {
    ui.notifications.warn(
      `${result.resourceName ?? "Resource"} is at ${result.currentValue} / ${result.max}; can't add ${result.requested}.`
    );
    return;
  }
  ui.notifications.error(
    `Resource change failed: ${result.error ?? "unknown error"}`
  );
}
