/**
 * Quartermaster - Currency definitions and custom currency storage.
 *
 * D&D5e's five standard balances remain in actor.system.currency. Custom
 * currencies and presentation options are stored in one Quartermaster flag.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS, SETTINGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";

export const STANDARD_CURRENCIES = Object.freeze({
  pp: { id: "pp", name: "Platinum", symbol: "PP", gpRate: 10 },
  gp: { id: "gp", name: "Gold", symbol: "GP", gpRate: 1 },
  ep: { id: "ep", name: "Electrum", symbol: "EP", gpRate: 0.5 },
  sp: { id: "sp", name: "Silver", symbol: "SP", gpRate: 0.1 },
  cp: { id: "cp", name: "Copper", symbol: "CP", gpRate: 0.01 }
});

export const STANDARD_CURRENCY_ORDER = Object.freeze(["pp", "gp", "ep", "sp", "cp"]);
export const DEFAULT_CURRENCY_IMAGE = "icons/svg/coins.svg";
export const DEFAULT_REFERENCE_CURRENCY_ID = "gp";

const CURRENCY_CONFIG_VERSION = 2;
const hasOwn = (object, property) => Object.prototype.hasOwnProperty.call(object, property);

export function getCurrencyConfig(actor = getBackingActor()) {
  const raw = actor?.getFlag?.(MODULE_ID, FLAGS.CURRENCY_CONFIG);
  const hasStoredConfig = raw && typeof raw === "object" && !Array.isArray(raw);
  const standard = {};

  for (const id of STANDARD_CURRENCY_ORDER) {
    const saved = hasStoredConfig && raw.standard?.[id] && typeof raw.standard[id] === "object"
      ? raw.standard[id]
      : {};
    standard[id] = {
      hidden: Boolean(saved.hidden),
      image: cleanString(saved.image),
      referenceRate: positiveNumber(saved.referenceRate ?? saved.gpRate)
        ?? STANDARD_CURRENCIES[id].gpRate
    };
  }

  // Carry the old per-client Hide Electrum preference into the new world-level
  // configuration the first time the currency manager writes its data.
  if (!hasStoredConfig) {
    try {
      standard.ep.hidden = Boolean(game.settings.get(MODULE_ID, SETTINGS.HIDE_ELECTRUM));
    } catch { /* legacy setting unavailable */ }
  }

  const custom = Array.isArray(raw?.custom)
    ? raw.custom.map(normalizeCustomCurrency).filter(Boolean)
    : [];

  const availableIds = new Set([...STANDARD_CURRENCY_ORDER, ...custom.map(currency => currency.id)]);
  const requestedReferenceId = cleanString(raw?.referenceCurrencyId) || DEFAULT_REFERENCE_CURRENCY_ID;
  let referenceCurrencyId = availableIds.has(requestedReferenceId)
    ? requestedReferenceId
    : DEFAULT_REFERENCE_CURRENCY_ID;

  const requestedReference = STANDARD_CURRENCIES[referenceCurrencyId]
    ? standard[referenceCurrencyId]
    : custom.find(currency => currency.id === referenceCurrencyId);
  if (!positiveNumber(requestedReference?.referenceRate)) {
    referenceCurrencyId = DEFAULT_REFERENCE_CURRENCY_ID;
  }

  // The selected reference is always visible and always equals one unit of itself.
  if (STANDARD_CURRENCIES[referenceCurrencyId]) {
    standard[referenceCurrencyId] = {
      ...standard[referenceCurrencyId],
      hidden: false,
      referenceRate: 1
    };
  } else {
    const reference = custom.find(currency => currency.id === referenceCurrencyId);
    if (reference) {
      reference.hidden = false;
      reference.referenceRate = 1;
    }
  }

  return { version: CURRENCY_CONFIG_VERSION, referenceCurrencyId, standard, custom };
}

export async function ensureCurrencyConfig(actor = getBackingActor()) {
  if (!game.user.isGM || !actor) return false;
  const existing = actor.getFlag?.(MODULE_ID, FLAGS.CURRENCY_CONFIG);
  if (existing && typeof existing === "object" && !Array.isArray(existing)
      && Number(existing.version) >= CURRENCY_CONFIG_VERSION
      && cleanString(existing.referenceCurrencyId)) return false;
  await saveCurrencyConfig(actor, getCurrencyConfig(actor));
  return true;
}

export function getCurrencies(actor = getBackingActor(), { includeHidden = true, hideZero = false } = {}) {
  if (!actor) return [];
  const config = getCurrencyConfig(actor);
  const native = actor.system?.currency ?? {};

  const standard = STANDARD_CURRENCY_ORDER.map((id, index) => {
    const definition = STANDARD_CURRENCIES[id];
    const presentation = config.standard[id];
    return {
      ...definition,
      value: normalizeAmount(native[id], 0),
      hidden: presentation.hidden,
      image: presentation.image,
      hasImage: Boolean(presentation.image),
      isCustom: false,
      order: index,
      referenceRate: presentation.referenceRate
    };
  });

  const custom = config.custom.map((currency, index) => ({
    ...currency,
    hasImage: Boolean(currency.image),
    isCustom: true,
    order: STANDARD_CURRENCY_ORDER.length + (currency.order ?? index)
  }));

  const combined = [...standard, ...custom];
  const gpReferenceRate = positiveNumber(
    combined.find(currency => currency.id === DEFAULT_REFERENCE_CURRENCY_ID)?.referenceRate
  );
  const enriched = combined.map(currency => {
    const referenceRate = positiveNumber(currency.referenceRate);
    return {
      ...currency,
      referenceCurrencyId: config.referenceCurrencyId,
      referenceRate,
      isReference: currency.id === config.referenceCurrencyId,
      // Compatibility fields for consumers of the v0.1.6 currency API.
      conversionDenomination: referenceRate ? config.referenceCurrencyId : null,
      conversionRate: referenceRate,
      gpRate: referenceRate && gpReferenceRate
        ? roundRate(referenceRate / gpReferenceRate)
        : null
    };
  });

  return enriched
    .filter(currency => includeHidden || !currency.hidden)
    .filter(currency => !hideZero || currency.value > 0)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getCurrency(currencyId, actor = getBackingActor()) {
  if (!currencyId) return null;
  return getCurrencies(actor, { includeHidden: true }).find(currency => currency.id === currencyId) ?? null;
}

export function getReferenceCurrency(actor = getBackingActor()) {
  const config = getCurrencyConfig(actor);
  return getCurrency(config.referenceCurrencyId, actor);
}

export function getCurrencyReferenceRate(currencyOrId, actor = getBackingActor()) {
  const currency = typeof currencyOrId === "string"
    ? getCurrency(currencyOrId, actor)
    : currencyOrId;
  return positiveNumber(currency?.referenceRate);
}

export function getCurrencyGpRate(currencyOrId, actor = getBackingActor()) {
  const currency = typeof currencyOrId === "string"
    ? getCurrency(currencyOrId, actor)
    : currencyOrId;
  return positiveNumber(currency?.gpRate);
}

export async function createCustomCurrency(input, actor = getBackingActor()) {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  const name = cleanString(input?.name);
  const symbol = cleanSymbol(input?.symbol);
  if (!name) return { status: "failed", error: "name-required" };
  if (!symbol) return { status: "failed", error: "symbol-required" };

  const config = getCurrencyConfig(actor);
  if (config.custom.some(currency => currency.symbol.toLowerCase() === symbol.toLowerCase())) {
    return { status: "failed", error: "duplicate-symbol" };
  }

  const currency = normalizeCustomCurrency({
    id: `qm-cur-${foundry.utils.randomID()}`,
    name,
    symbol,
    image: input?.image,
    value: input?.value,
    hidden: input?.hidden,
    referenceRate: input?.referenceRate,
    weightPerUnit: input?.weightPerUnit,
    createdAt: Date.now(),
    order: config.custom.length > 0
      ? Math.max(...config.custom.map(entry => entry.order ?? 0)) + 10
      : 10
  });

  config.custom.push(currency);
  await saveCurrencyConfig(actor, config);
  return { status: "success", currency };
}

export async function updateCurrency(currencyId, changes, actor = getBackingActor()) {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  const config = getCurrencyConfig(actor);
  if (STANDARD_CURRENCIES[currencyId]) {
    const current = config.standard[currencyId];
    const isReference = config.referenceCurrencyId === currencyId;
    const hidden = changes?.hidden === undefined ? current.hidden : Boolean(changes.hidden);
    if (isReference && hidden) return { status: "failed", error: "reference-currency" };

    let referenceRate = current.referenceRate;
    if (isReference) referenceRate = 1;
    else if (changes?.referenceRate !== undefined) {
      referenceRate = positiveNumber(changes.referenceRate);
      if (!referenceRate) return { status: "failed", error: "invalid-conversion-rate" };
    }
    config.standard[currencyId] = {
      hidden,
      image: changes?.image === undefined ? current.image : cleanString(changes.image),
      referenceRate
    };
    await saveCurrencyConfig(actor, config);
    return { status: "success", currency: getCurrency(currencyId, actor) };
  }

  const index = config.custom.findIndex(currency => currency.id === currencyId);
  if (index < 0) return { status: "failed", error: "currency-not-found" };

  const current = config.custom[index];
  const next = normalizeCustomCurrency({ ...current, ...changes, id: current.id });
  if (!next?.name) return { status: "failed", error: "name-required" };
  if (!next?.symbol) return { status: "failed", error: "symbol-required" };
  if (config.custom.some((currency, i) => i !== index
      && currency.symbol.toLowerCase() === next.symbol.toLowerCase())) {
    return { status: "failed", error: "duplicate-symbol" };
  }

  if (config.referenceCurrencyId === currencyId) {
    if (changes?.hidden === true) return { status: "failed", error: "reference-currency" };
    next.hidden = false;
    next.referenceRate = 1;
  }

  config.custom[index] = next;
  await saveCurrencyConfig(actor, config);
  return { status: "success", currency: next };
}

export async function setCurrencyHidden(currencyId, hidden, actor = getBackingActor()) {
  return updateCurrency(currencyId, { hidden: Boolean(hidden) }, actor);
}

/**
 * Change the fixed reference currency while preserving every established
 * exchange relationship. Rates are rebased by the selected currency's
 * current rate, so only the unit used to describe totals changes.
 */
export async function setReferenceCurrency(currencyId, actor = getBackingActor()) {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  const config = getCurrencyConfig(actor);
  if (config.referenceCurrencyId === currencyId) {
    return { status: "success", currency: getCurrency(currencyId, actor), unchanged: true };
  }

  const selected = getCurrency(currencyId, actor);
  if (!selected) return { status: "failed", error: "currency-not-found" };
  const selectedRate = positiveNumber(selected.referenceRate);
  if (!selectedRate) return { status: "failed", error: "currency-has-no-conversion" };

  for (const id of STANDARD_CURRENCY_ORDER) {
    config.standard[id] = {
      ...config.standard[id],
      referenceRate: roundRate(config.standard[id].referenceRate / selectedRate)
    };
  }
  config.custom = config.custom.map(currency => ({
    ...currency,
    referenceRate: currency.referenceRate == null
      ? null
      : roundRate(currency.referenceRate / selectedRate)
  }));
  config.referenceCurrencyId = currencyId;

  if (STANDARD_CURRENCIES[currencyId]) {
    config.standard[currencyId] = {
      ...config.standard[currencyId],
      hidden: false,
      referenceRate: 1
    };
  } else {
    const index = config.custom.findIndex(currency => currency.id === currencyId);
    config.custom[index] = {
      ...config.custom[index],
      hidden: false,
      referenceRate: 1
    };
  }

  await saveCurrencyConfig(actor, config);

  // Keep the approval threshold economically equivalent after changing units.
  let approvalThreshold = null;
  try {
    const currentThreshold = Number(
      game.settings.get(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_THRESHOLD)
    );
    if (Number.isFinite(currentThreshold) && currentThreshold >= 0) {
      approvalThreshold = roundRate(currentThreshold / selectedRate);
      await game.settings.set(
        MODULE_ID,
        SETTINGS.CURRENCY_APPROVAL_THRESHOLD,
        approvalThreshold
      );
    }
  } catch (err) {
    console.warn(`${MODULE_TITLE} | Could not rebase the approval threshold`, err);
  }

  return {
    status: "success",
    currency: getCurrency(currencyId, actor),
    approvalThreshold
  };
}

export async function deleteCustomCurrency(currencyId, actor = getBackingActor()) {
  if (!game.user.isGM) return { status: "failed", error: "gm-only" };
  if (!actor) return { status: "failed", error: "no-backing-actor" };
  if (STANDARD_CURRENCIES[currencyId]) return { status: "failed", error: "standard-currency" };

  const staged = actor.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY) ?? [];
  if (Array.isArray(staged) && staged.some(entry => (entry.currencyId ?? entry.type) === currencyId)) {
    return { status: "failed", error: "currency-has-staged-loot" };
  }

  const config = getCurrencyConfig(actor);
  const currency = config.custom.find(entry => entry.id === currencyId);
  if (!currency) return { status: "failed", error: "currency-not-found" };
  if (config.referenceCurrencyId === currencyId) {
    return { status: "failed", error: "reference-currency" };
  }
  config.custom = config.custom.filter(entry => entry.id !== currencyId);
  await saveCurrencyConfig(actor, config);
  return { status: "success", currency };
}

export async function applyCurrencyDelta(currencyId, delta, actor = getBackingActor()) {
  if (!actor) return { status: "failed", error: "no-backing-actor" };
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return { status: "failed", error: "invalid-delta", delta };
  }

  const currency = getCurrency(currencyId, actor);
  if (!currency) return { status: "failed", error: "invalid-currency-type", currencyType: currencyId };
  const previousValue = normalizeAmount(currency.value, 0);
  const newValue = roundCurrency(previousValue + delta);
  if (newValue < 0) {
    return {
      status: "failed",
      error: "insufficient-funds",
      currencyType: currencyId,
      currentBalance: previousValue,
      requested: Math.abs(delta)
    };
  }

  if (!currency.isCustom) {
    await actor.update({ [`system.currency.${currencyId}`]: newValue });
  } else {
    const config = getCurrencyConfig(actor);
    const index = config.custom.findIndex(entry => entry.id === currencyId);
    if (index < 0) return { status: "failed", error: "currency-not-found" };
    config.custom[index] = { ...config.custom[index], value: newValue };
    await saveCurrencyConfig(actor, config);
  }

  return { status: "success", currency, previousValue, newValue };
}

export function roundCurrency(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

async function saveCurrencyConfig(actor, config) {
  await actor.setFlag(MODULE_ID, FLAGS.CURRENCY_CONFIG, {
    version: CURRENCY_CONFIG_VERSION,
    referenceCurrencyId: config.referenceCurrencyId,
    standard: config.standard,
    custom: config.custom
  });
}

function normalizeCustomCurrency(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanString(raw.id);
  if (!id) return null;
  const referenceRate = hasOwn(raw, "referenceRate")
    ? positiveNumber(raw.referenceRate)
    : getLegacyCustomGpRate(raw);

  return {
    id,
    name: cleanString(raw.name) || "Custom Currency",
    symbol: cleanSymbol(raw.symbol) || "CUR",
    image: cleanString(raw.image),
    value: normalizeAmount(raw.value, 0),
    hidden: Boolean(raw.hidden),
    referenceRate,
    weightPerUnit: nonNegativeNumber(raw.weightPerUnit, 0),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    order: Number.isFinite(raw.order) ? raw.order : 0
  };
}

function getLegacyCustomGpRate(currency) {
  const denomination = STANDARD_CURRENCIES[currency?.conversionDenomination];
  const rate = positiveNumber(currency?.conversionRate);
  return denomination && rate ? roundRate(rate * denomination.gpRate) : null;
}

function normalizeAmount(raw, fallback = 0) {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? Math.max(0, roundCurrency(value)) : fallback;
}

function nonNegativeNumber(raw, fallback = 0) {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value >= 0 ? roundRate(value) : fallback;
}

function positiveNumber(raw) {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? roundRate(value) : null;
}

function roundRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanSymbol(value) {
  return cleanString(value).slice(0, 12);
}
