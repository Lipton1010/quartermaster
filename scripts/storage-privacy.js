/** Pure privacy helpers shared by migration and the transaction log. */

import { MODULE_ID, SETTINGS, CHOICES } from "./constants.js";

const PUBLIC_FIELDS = Object.freeze([
  "id", "timestamp", "type", "phase", "status", "requestId", "userId",
  "operationType", "itemName", "sourceItemName", "sourceActorName", "destActorName",
  "itemQuantity",
  "currencyType", "currencyName", "currencySymbol", "delta", "amount",
  "previousValue", "newValue", "resourceId", "denialReason"
]);

export function isPublicTransactionLogEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTINGS.TRANSACTION_LOG_VISIBILITY)
      === CHOICES.LOG_VISIBILITY.ALL;
  } catch {
    return false;
  }
}

/**
 * Return a player-safe projection, or null when an entry must stay private.
 * Staging/deletion activity is never projected. A reveal may expose only the
 * newly public item name; raw Item data and internal errors never cross over.
 */
export function redactTransactionEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const type = String(entry.type ?? "");
  if (entry.visibility === "gm") return null;
  if (type.startsWith("hidden.") && type !== "hidden.revealed") return null;

  const projected = {};
  for (const key of PUBLIC_FIELDS) {
    if (entry[key] !== undefined) projected[key] = cloneValue(entry[key]);
  }
  if (!projected.id || !projected.timestamp || !projected.type) return null;
  return projected;
}

export function projectPublicTransactionLog(entries, { enabled = isPublicTransactionLogEnabled() } = {}) {
  if (!enabled || !Array.isArray(entries)) return [];
  return entries.map(redactTransactionEntry).filter(Boolean);
}

function cloneValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}
