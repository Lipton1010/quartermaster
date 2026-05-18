/**
 * Quartermaster — Approval Policy (step 13)
 *
 * Pure decision functions for whether a currency request needs GM
 * approval. Reads world settings and the requester's role.
 *
 * Modes:
 *   FREE         — all currency changes execute immediately, no approval
 *   THRESHOLD    — approval needed when |delta| >= configured threshold
 *   ALL_REQUIRED — every player-initiated change needs approval
 *
 * GM requests never need approval (GMs can't approve themselves).
 *
 * Custom resources and item transfers do not currently flow through this
 * policy; that's a v1.1 extension if needed. Step 13 is currency-only.
 */

import { MODULE_ID, SETTINGS, CHOICES } from "./constants.js";

/**
 * @param {Object} request
 * @param {string} request.userId - the user submitting the request
 * @param {number} request.delta  - signed delta (positive=add, negative=remove)
 * @returns {boolean}
 */
export function needsApproval({ userId, delta }) {
  // GMs auto-approve themselves
  const user = game.users?.get?.(userId);
  if (user?.isGM) return false;

  // Read mode
  let mode;
  try {
    mode = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_MODE);
  } catch {
    // If setting somehow not registered, fail safe: require approval
    return true;
  }

  if (mode === CHOICES.CURRENCY_APPROVAL.FREE) return false;
  if (mode === CHOICES.CURRENCY_APPROVAL.ALL_REQUIRED) return true;

  if (mode === CHOICES.CURRENCY_APPROVAL.THRESHOLD) {
    let threshold;
    try {
      threshold = game.settings.get(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_THRESHOLD);
    } catch {
      threshold = 100;
    }
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      threshold = 100;
    }
    return Math.abs(delta) >= threshold;
  }

  // Unknown mode: fail safe
  return true;
}

/**
 * Convenience for player-side use: would the request the current user is
 * about to submit need approval? Used by the inventory UI to show a
 * "waiting for GM" pending notice.
 */
export function needsApprovalForCurrentUser({ delta }) {
  return needsApproval({ userId: game.user?.id, delta });
}

/**
 * Timeout settings bundle, for use by the approval dialog.
 *
 * @returns {{ enabled: boolean, seconds: number }}
 */
export function getTimeoutConfig() {
  let enabled = true;
  let seconds = 30;
  try {
    enabled = Boolean(game.settings.get(MODULE_ID, SETTINGS.USE_APPROVAL_TIMEOUT));
  } catch { /* default true */ }
  try {
    const raw = game.settings.get(MODULE_ID, SETTINGS.APPROVAL_TIMEOUT_SECONDS);
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      seconds = Math.floor(raw);
    }
  } catch { /* default 30 */ }
  return { enabled, seconds };
}
