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
import { getCurrency, applyCurrencyDelta, roundCurrency } from "./currencies.js";

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
 * @param {string} type   standard or custom currency ID
 * @param {number} amount positive amount; decimals are supported
 * @param {string} [folderId] optional folder assignment
 * @returns {Promise<{status: string, entry?: Object}>}
 */
export async function addHiddenCurrency(type, amount, folderId = null) {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  const actor = getBackingActor();
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  const amt = roundCurrency(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) return { status: "failed", error: "invalid-amount" };
  const currency = getCurrency(type, actor);
  if (!currency) return { status: "failed", error: "invalid-type" };

  const entry = {
    id: `qm-hc-${foundry.utils.randomID()}`,
    type,
    currencyId: type,
    currencyName: currency.name,
    currencySymbol: currency.symbol,
    amount: amt,
    folderId: folderId || null,
    createdAt: Date.now()
  };

  const existing = getHiddenCurrency(actor);
  const updated = [...existing, entry];
  await actor.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, updated);

  console.debug(`${MODULE_TITLE} | addHiddenCurrency: ${amt} ${currency.symbol}`);
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

  console.debug(`${MODULE_TITLE} | deleteHiddenCurrency: removed ${entry.amount} ${entry.currencySymbol ?? entry.type.toUpperCase()}`);
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

  const currencyId = entry.currencyId ?? entry.type;
  const currency = getCurrency(currencyId, actor);
  if (!currency) return { status: "failed", error: "currency-not-found" };
  const currentVal = currency.value ?? 0;
  const applied = await applyCurrencyDelta(currencyId, entry.amount, actor);
  if (applied.status !== "success") return applied;
  const newVal = applied.newValue;

  // Remove from hidden pool
  const updated = existing.filter(e => e.id !== entryId);
  await actor.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, updated);

  // Log entry
  await writeEntry({
    type: "currency.revealed",
    requestId: `qm-hc-reveal-${entryId}-${Date.now()}`,
    userId: game.user.id,
    currencyType: currencyId,
    currencyName: currency.name,
    currencySymbol: currency.symbol,
    delta: entry.amount,
    amount: entry.amount,
    previousValue: currentVal,
    newValue: newVal,
    backingActorId: actor.id
  });

  const label = `${entry.amount} ${currency.symbol}`;
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
    const currencyId = e.currencyId ?? e.type;
    totals[currencyId] = roundCurrency((totals[currencyId] ?? 0) + e.amount);
  }

  const revealed = [];
  for (const [type, add] of Object.entries(totals)) {
    const currency = getCurrency(type, actor);
    if (!currency) return { status: "failed", error: "currency-not-found", currencyType: type };
    const applied = await applyCurrencyDelta(type, add, actor);
    if (applied.status !== "success") return applied;
    revealed.push({ type, add, currency, previousValue: applied.previousValue, newValue: applied.newValue });
  }

  await actor.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, []);

  // Log
  for (const result of revealed) {
    await writeEntry({
      type: "currency.revealed",
      requestId: `qm-hc-reveal-all-${result.type}-${Date.now()}`,
      userId: game.user.id,
      currencyType: result.type,
      currencyName: result.currency.name,
      currencySymbol: result.currency.symbol,
      delta: result.add,
      amount: result.add,
      previousValue: result.previousValue,
      newValue: result.newValue,
      backingActorId: actor.id
    });
  }

  const count = entries.length;
  ui.notifications.info(`${count} currency entry(s) revealed to vault.`);
  return { status: "success", count };
}
