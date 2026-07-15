/**
 * Quartermaster — Approval Dialog (step 13)
 *
 * GM-side prompt for approving or denying a currency change request.
 * Fires inside the GM-side dispatcher when policy.needsApproval returns
 * true.
 *
 * Resolution semantics:
 *   "approve" — GM clicked Approve
 *   "deny"    — GM clicked Deny, closed the dialog, or pressed escape
 *   "timeout" — countdown ran out (only if useApprovalTimeout enabled)
 *
 * Multi-GM: only the active GM runs this code path (the socket layer
 * already routes requests to the active GM). Non-active GMs don't see
 * the dialog. If the active GM is AFK, the request times out and the
 * player gets a clean denied response.
 */

import { MODULE_TITLE } from "./constants.js";
import { getTimeoutConfig } from "./approval-policy.js";

const { DialogV2 } = foundry.applications.api;

const CURRENCY_NAMES = {
  pp: "Platinum Pieces",
  gp: "Gold Pieces",
  ep: "Electrum Pieces",
  sp: "Silver Pieces",
  cp: "Copper Pieces"
};

/**
 * Show the approval dialog and resolve with the GM's decision.
 *
 * @param {Object} request
 * @param {string} request.requestId
 * @param {string} request.userId        - originating user
 * @param {string} request.currencyType  - pp | gp | ep | sp | cp
 * @param {number} request.delta         - signed delta
 * @param {number} request.currentBalance
 * @param {string} [request.reason]
 * @returns {Promise<"approve"|"deny"|"timeout">}
 */
export async function promptCurrencyApproval(request) {
  const {
    userId,
    currencyType,
    currencyName,
    currencySymbol,
    delta,
    currentBalance,
    reason
  } = request;

  const userName = game.users?.get?.(userId)?.name ?? "(unknown user)";
  const symbol = currencySymbol || currencyType.toUpperCase();
  const safeSymbol = escapeHtml(symbol);
  const fullName = currencyName || CURRENCY_NAMES[currencyType] || symbol;
  const verb = delta > 0 ? "add" : "remove";
  const preposition = delta > 0 ? "to" : "from";
  const abs = Math.abs(delta);
  const newBalance = currentBalance + delta;
  const insufficient = newBalance < 0;

  const { enabled: timeoutEnabled, seconds: timeoutSeconds } = getTimeoutConfig();

  const reasonHtml = reason && reason !== "manual"
    ? `<p class="qm-approval-reason"><em>Reason: ${escapeHtml(reason)}</em></p>`
    : "";

  const warningHtml = insufficient
    ? `<p class="qm-approval-warning">
         <i class="fa-solid fa-triangle-exclamation"></i>
         This would leave the vault with <strong>${newBalance} ${safeSymbol}</strong>
         (insufficient funds; the request will fail even if approved).
       </p>`
    : "";

  const countdownHtml = timeoutEnabled
    ? `<div class="qm-approval-countdown">
         <i class="fa-solid fa-clock"></i>
         <span class="qm-countdown-value">${timeoutSeconds}</span>s to decide
       </div>`
    : "";

  const content = `
    <div class="qm-approval-request">
      <p class="qm-approval-lead">
        <strong>${escapeHtml(userName)}</strong> wants to
        <strong>${verb} ${abs} ${safeSymbol}</strong>
        ${preposition} the party vault.
      </p>
      <div class="qm-approval-balance">
        <div>
          <span class="qm-approval-balance-label">Current:</span>
          <strong>${currentBalance} ${safeSymbol}</strong>
        </div>
        <div class="qm-approval-arrow">
          <i class="fa-solid fa-arrow-right"></i>
        </div>
        <div>
          <span class="qm-approval-balance-label">After:</span>
          <strong>${newBalance} ${safeSymbol}</strong>
        </div>
      </div>
      ${reasonHtml}
      ${warningHtml}
      ${countdownHtml}
    </div>
  `;

  return new Promise((resolve) => {
    let resolved = false;
    let countdownInterval = null;
    let closeHookId = null;
    let remaining = timeoutSeconds;

    const finish = (decision) => {
      if (resolved) return;
      resolved = true;
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      if (closeHookId !== null) {
        try { Hooks.off("closeDialogV2", closeHookId); } catch { /* ignore */ }
        closeHookId = null;
      }
      resolve(decision);
    };

    const dialog = new DialogV2({
      window: {
        title: `Currency Approval: ${fullName}`,
        icon: "fa-solid fa-gavel"
      },
      position: { width: 440 },
      classes: ["quartermaster", "quartermaster-approval"],
      content,
      buttons: [
        {
          action: "approve",
          label: "Approve",
          icon: "fa-solid fa-check",
          default: true,
          callback: () => finish("approve")
        },
        {
          action: "deny",
          label: "Deny",
          icon: "fa-solid fa-xmark",
          callback: () => finish("deny")
        }
      ],
      rejectClose: false,
      modal: false
    });

    // Use the closeDialogV2 hook rather than the close config callback.
    // In Foundry V14, clicking the X header button removes the dialog
    // from the DOM but does not always fire the config callback; the
    // hook fires reliably regardless of close mechanism (X, Escape,
    // programmatic dialog.close()).
    closeHookId = Hooks.on("closeDialogV2", (closedApp) => {
      if (closedApp !== dialog) return;
      if (!resolved) finish("deny");
    });

    dialog.render({ force: true }).then(() => {
      if (!timeoutEnabled) return;

      countdownInterval = setInterval(() => {
        remaining--;
        const valueEl = dialog.element?.querySelector(".qm-countdown-value");
        if (valueEl) valueEl.textContent = String(Math.max(0, remaining));

        if (remaining <= 0) {
          if (!resolved) {
            // Resolve FIRST so the close hook firing from dialog.close()
            // sees resolved=true and is a no-op
            finish("timeout");
            try { dialog.close(); } catch { /* ignore */ }
          }
        }
      }, 1000);
    });
  });
}

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
