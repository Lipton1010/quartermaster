/**
 * Quartermaster — Hidden Currency (v0.1.2)
 *
 * Staged currency entries in GM Loot Prep. Each entry represents an
 * amount of a specific currency type (e.g., "50 GP") that can be
 * revealed to merge into the vault's currency total.
 *
 * Stored as a flag array on the backing actor:
 *   actor.flags.quartermaster.hiddenCurrency[]
 *
 * All writes are GM-only.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { writeEntry } from "./transaction-log.js";

const CURRENCY_SYMBOLS = { pp: "PP", gp: "GP", ep: "EP", sp: "SP", cp: "CP" };

// ============================================================
// Read
// ============================================================

export function getHiddenCurrency(actor) {
  if (!actor) return [];
  const entries = actor.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY) ?? [];
  if (!Array.isArray(entries)) return [];
  return entries.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

// ============================================================
// Write
// ============================================================

/**
 * Add a currency entry to the staging pool.
 * @param {string} type   pp|gp|ep|sp|cp
 * @param {number} amount positive integer
 * @param {string} [folderId] optional folder assignment
 * @returns {Promise<{status: string, entry?: Object}>}
 */
export async function addHiddenCurrency(type, amount, folderId = null) {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  const actor = getBackingActor();
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  const amt = parseInt(amount, 10);
  if (!Number.isFinite(amt) || amt <= 0) return { status: "failed", error: "invalid-amount" };
  if (!CURRENCY_SYMBOLS[type]) return { status: "failed", error: "invalid-type" };

  const entry = {
    id: `qm-hc-${foundry.utils.randomID()}`,
    type,
    amount: amt,
    folderId: folderId || null,
    createdAt: Date.now()
  };

  const existing = getHiddenCurrency(actor);
  const updated = [...existing, entry];
  await actor.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, updated);

  console.debug(`${MODULE_TITLE} | addHiddenCurrency: ${amt} ${type.toUpperCase()}`);
  return { status: "success", entry };
}

/**
 * Delete a currency entry from the staging pool without revealing.
 */
export async function deleteHiddenCurrency(entryId) {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  const actor = getBackingActor();
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  const existing = getHiddenCurrency(actor);
  const entry = existing.find(e => e.id === entryId);
  if (!entry) return { status: "failed", error: "not-found" };

  const updated = existing.filter(e => e.id !== entryId);
  await actor.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, updated);

  console.debug(`${MODULE_TITLE} | deleteHiddenCurrency: removed ${entry.amount} ${entry.type.toUpperCase()}`);
  return { status: "success", entry };
}

/**
 * Reveal a currency entry: merge the amount into the vault's currency
 * and remove the entry from the staging pool.
 */
export async function revealHiddenCurrency(entryId) {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  const actor = getBackingActor();
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  const existing = getHiddenCurrency(actor);
  const entry = existing.find(e => e.id === entryId);
  if (!entry) return { status: "failed", error: "not-found" };

  // Merge into vault currency
  const currentVal = actor.system?.currency?.[entry.type] ?? 0;
  const newVal = currentVal + entry.amount;
  await actor.update({ [`system.currency.${entry.type}`]: newVal });

  // Remove from hidden pool
  const updated = existing.filter(e => e.id !== entryId);
  await actor.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, updated);

  // Log entry
  await writeEntry({
    type: "currency.revealed",
    requestId: `qm-hc-reveal-${entryId}-${Date.now()}`,
    userId: game.user.id,
    currencyType: entry.type,
    amount: entry.amount,
    previousValue: currentVal,
    newValue: newVal,
    backingActorId: actor.id
  });

  const label = `${entry.amount} ${CURRENCY_SYMBOLS[entry.type]}`;
  ui.notifications.info(`${label} added to vault.`);
  console.debug(`${MODULE_TITLE} | revealHiddenCurrency: ${label}`);
  return { status: "success", entry, newValue: newVal };
}

/**
 * Reveal all hidden currency entries at once.
 */
export async function revealAllHiddenCurrency() {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  const actor = getBackingActor();
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  const entries = getHiddenCurrency(actor);
  if (entries.length === 0) return { status: "success", count: 0 };

  // Aggregate by type
  const totals = {};
  for (const e of entries) {
    totals[e.type] = (totals[e.type] ?? 0) + e.amount;
  }

  // Build the currency update
  const currencyUpdate = {};
  for (const [type, add] of Object.entries(totals)) {
    const current = actor.system?.currency?.[type] ?? 0;
    currencyUpdate[`system.currency.${type}`] = current + add;
  }

  await actor.update(currencyUpdate);
  await actor.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, []);

  // Log
  for (const [type, add] of Object.entries(totals)) {
    await writeEntry({
      type: "currency.revealed",
      requestId: `qm-hc-reveal-all-${type}-${Date.now()}`,
      userId: game.user.id,
      currencyType: type,
      amount: add,
      backingActorId: actor.id
    });
  }

  const count = entries.length;
  ui.notifications.info(`${count} currency entry(s) revealed to vault.`);
  return { status: "success", count };
}
