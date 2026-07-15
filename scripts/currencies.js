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
      image: cleanString(saved.image)
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

  return { version: 1, standard, custom };
}

export async function ensureCurrencyConfig(actor = getBackingActor()) {
  if (!game.user.isGM || !actor) return false;
  const existing = actor.getFlag?.(MODULE_ID, FLAGS.CURRENCY_CONFIG);
  if (existing && typeof existing === "object" && !Array.isArray(existing)) return false;
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
      conversionDenomination: "gp",
      conversionRate: definition.gpRate,
      gpRate: definition.gpRate
    };
  });

  const custom = config.custom.map((currency, index) => ({
    ...currency,
    hasImage: Boolean(currency.image),
    isCustom: true,
    order: STANDARD_CURRENCY_ORDER.length + (currency.order ?? index),
    gpRate: getCustomGpRate(currency)
  }));

  return [...standard, ...custom]
    .filter(currency => includeHidden || !currency.hidden)
    .filter(currency => !hideZero || currency.value > 0)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getCurrency(currencyId, actor = getBackingActor()) {
  if (!currencyId) return null;
  return getCurrencies(actor, { includeHidden: true }).find(currency => currency.id === currencyId) ?? null;
}

export function getCurrencyGpRate(currencyOrId, actor = getBackingActor()) {
  const currency = typeof currencyOrId === "string"
    ? getCurrency(currencyOrId, actor)
    : currencyOrId;
  if (!currency) return null;
  if (!currency.isCustom) return STANDARD_CURRENCIES[currency.id]?.gpRate ?? null;
  return getCustomGpRate(currency);
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
    conversionDenomination: input?.conversionDenomination,
    conversionRate: input?.conversionRate,
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
    config.standard[currencyId] = {
      hidden: changes?.hidden === undefined ? current.hidden : Boolean(changes.hidden),
      image: changes?.image === undefined ? current.image : cleanString(changes.image)
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

  config.custom[index] = next;
  await saveCurrencyConfig(actor, config);
  return { status: "success", currency: next };
}

export async function setCurrencyHidden(currencyId, hidden, actor = getBackingActor()) {
  return updateCurrency(currencyId, { hidden: Boolean(hidden) }, actor);
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
    version: 1,
    standard: config.standard,
    custom: config.custom
  });
}

function normalizeCustomCurrency(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanString(raw.id);
  if (!id) return null;
  const conversionDenomination = STANDARD_CURRENCIES[raw.conversionDenomination]
    ? raw.conversionDenomination
    : null;
  const conversionRate = conversionDenomination
    ? positiveNumber(raw.conversionRate)
    : null;

  return {
    id,
    name: cleanString(raw.name) || "Custom Currency",
    symbol: cleanSymbol(raw.symbol) || "CUR",
    image: cleanString(raw.image),
    value: normalizeAmount(raw.value, 0),
    hidden: Boolean(raw.hidden),
    conversionDenomination: conversionRate ? conversionDenomination : null,
    conversionRate,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    order: Number.isFinite(raw.order) ? raw.order : 0
  };
}

function getCustomGpRate(currency) {
  const denomination = STANDARD_CURRENCIES[currency?.conversionDenomination];
  const rate = positiveNumber(currency?.conversionRate);
  return denomination && rate ? roundCurrency(rate * denomination.gpRate) : null;
}

function normalizeAmount(raw, fallback = 0) {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? Math.max(0, roundCurrency(value)) : fallback;
}

function positiveNumber(raw) {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? roundCurrency(value) : null;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanSymbol(value) {
  return cleanString(value).slice(0, 12);
}
