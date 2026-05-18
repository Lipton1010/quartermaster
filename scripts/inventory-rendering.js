/**
 * Quartermaster — Inventory Rendering Helpers
 *
 * Pure data preparation for the Shared Party Inventory popup. Given the
 * backing actor, returns a rendering context with currencies, custom
 * resources, items, weight totals, capacity state, and per-item display
 * fields.
 *
 * Kept separate from the InventoryApp class so the same logic is reusable
 * for tests, headless diagnostics, and future export features.
 */

import { MODULE_ID, FLAGS, SETTINGS, CHOICES } from "./constants.js";
import { getRawTotals } from "./weight-cache.js";

const CURRENCY_ORDER = ["pp", "gp", "ep", "sp", "cp"];
const CURRENCY_SYMBOLS = {
  pp: "PP",
  gp: "GP",
  ep: "EP",
  sp: "SP",
  cp: "CP"
};
const CURRENCY_NAMES = {
  pp: "Platinum",
  gp: "Gold",
  ep: "Electrum",
  sp: "Silver",
  cp: "Copper"
};

// dnd5e conversion table to gp equivalent
const TO_GP = {
  pp: 10,
  gp: 1,
  ep: 0.5,
  sp: 0.1,
  cp: 0.01
};

const COINS_PER_POUND = 50;  // dnd5e standard

/**
 * Build the full rendering context for an inventory popup render.
 *
 * @param {Actor|null} actor  the backing actor; pass null to get the
 *                            "not initialized" stub context
 * @returns {Object}
 */
export function buildInventoryContext(actor) {
  if (!actor) {
    return {
      backingActorPresent: false,
      backingActorName: null,
      backingActorId: null
    };
  }

  const settings = readSettings();
  const currencies = buildCurrencies(actor, settings);
  const resources = buildResources(actor);
  const items = buildItems(actor, settings);

  // Pull raw aggregate totals from the cache (computed once and reused
  // until item or currency changes invalidate it via weight-cache hooks).
  const raw = getRawTotals(actor) ?? { itemWeight: 0, coinSum: 0, coinValues: {} };

  // Settings-derived values are computed at read time so toggling
  // applyCurrencyWeight or capacityLimit doesn't require cache invalidation.
  const currencyWeight = settings.applyCurrencyWeight
    ? raw.coinSum / COINS_PER_POUND
    : 0;
  const totalWeight = raw.itemWeight + currencyWeight;

  const gpEquivalent =
    (raw.coinValues.pp ?? 0) * TO_GP.pp +
    (raw.coinValues.gp ?? 0) * TO_GP.gp +
    (raw.coinValues.ep ?? 0) * TO_GP.ep +
    (raw.coinValues.sp ?? 0) * TO_GP.sp +
    (raw.coinValues.cp ?? 0) * TO_GP.cp;

  // Capacity state
  const capacity = buildCapacity(totalWeight, settings);

  return {
    backingActorPresent: true,
    backingActorName: actor.name,
    backingActorId: actor.id,
    isGM: game.user.isGM,
    currencies,
    hasCurrencies: currencies.length > 0,
    resources,
    hasResources: resources.length > 0,
    items,
    hasItems: items.length > 0,
    itemCount: items.length,
    totals: {
      itemWeight: round2(raw.itemWeight),
      currencyWeight: round2(currencyWeight),
      totalWeight: round2(totalWeight),
      gpEquivalent: round2(gpEquivalent),
      applyCurrencyWeight: settings.applyCurrencyWeight
    },
    capacity,
    settings
  };
}

function readSettings() {
  return {
    enforceCapacity: game.settings.get(MODULE_ID, SETTINGS.ENFORCE_CAPACITY),
    capacityLimit: game.settings.get(MODULE_ID, SETTINGS.CAPACITY_LIMIT),
    applyCurrencyWeight: game.settings.get(MODULE_ID, SETTINGS.APPLY_CURRENCY_WEIGHT),
    hideZeroBalances: game.settings.get(MODULE_ID, SETTINGS.HIDE_ZERO_BALANCES),
    sortOrder: game.settings.get(MODULE_ID, SETTINGS.SORT_ORDER),
    entrySize: game.settings.get(MODULE_ID, SETTINGS.DEFAULT_ENTRY_SIZE),
    unidentifiedDisplay: game.settings.get(MODULE_ID, SETTINGS.UNIDENTIFIED_DISPLAY)
  };
}

function buildCurrencies(actor, settings) {
  const source = actor.system?.currency ?? {};
  let rows = CURRENCY_ORDER.map(type => ({
    type,
    symbol: CURRENCY_SYMBOLS[type],
    name: CURRENCY_NAMES[type],
    value: source[type] ?? 0
  }));
  if (settings.hideZeroBalances) {
    rows = rows.filter(r => r.value > 0);
  }
  return rows;
}

function buildResources(actor) {
  const source = actor.getFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES) ?? [];
  if (!Array.isArray(source)) return [];
  return source
    .map(r => ({
      id: r.id,
      name: r.name ?? "(unnamed)",
      icon: r.icon || "icons/svg/coins.svg",
      value: r.value ?? 0,
      max: r.max ?? null,
      hasMax: r.max != null,
      displayValue: r.max != null ? `${r.value ?? 0} / ${r.max}` : String(r.value ?? 0),
      atMax: r.max != null && (r.value ?? 0) >= r.max,
      atZero: (r.value ?? 0) <= 0,
      description: r.description ?? "",
      order: typeof r.order === "number" ? r.order : 0,
      createdAt: r.createdAt ?? 0
    }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.createdAt - b.createdAt;
    });
}

function buildItems(actor, settings) {
  const items = [...actor.items]
    .filter(i => !i.getFlag(MODULE_ID, FLAGS.HIDDEN))
    .map(i => prepareItemDisplay(i, settings));

  return sortItems(items, settings.sortOrder);
}

/**
 * Compute display-ready fields for one item.
 */
function prepareItemDisplay(item, settings) {
  const sys = item.system ?? {};
  const isIdentified = sys.identified !== false;

  const displayName = resolveDisplayName(item, sys, isIdentified, settings);
  const weight = resolveWeight(sys);
  const quantity = sys.quantity ?? 1;

  return {
    id: item.id,
    name: displayName,
    img: item.img || "icons/svg/item-bag.svg",
    quantity,
    weight: round2(weight),
    totalWeight: round2(weight * quantity),
    showQuantity: quantity > 1,
    isIdentified,
    type: item.type ?? "other",
    rawName: item.name
  };
}

/**
 * Apply the unidentifiedDisplay setting to determine what name to show.
 */
function resolveDisplayName(item, sys, isIdentified, settings) {
  if (isIdentified) return item.name;

  switch (settings.unidentifiedDisplay) {
    case CHOICES.UNIDENTIFIED_DISPLAY.IDENTIFIED:
      return item.name;
    case CHOICES.UNIDENTIFIED_DISPLAY.UNIDENTIFIED:
    case CHOICES.UNIDENTIFIED_DISPLAY.PER_ITEM:
    default:
      return sys.unidentified?.name ?? "Unidentified Item";
  }
}

/**
 * Weight extraction that survives dnd5e v3 (scalar) and v5 (object) schemas.
 */
function resolveWeight(sys) {
  const w = sys.weight;
  if (typeof w === "number") return w;
  if (w !== null && typeof w === "object") return w.value ?? 0;
  return 0;
}

function sortItems(items, sortOrder) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

  switch (sortOrder) {
    case CHOICES.SORT_ORDER.BY_TYPE:
      return items.sort((a, b) => {
        const t = (a.type || "").localeCompare(b.type || "");
        return t !== 0 ? t : byName(a, b);
      });
    case CHOICES.SORT_ORDER.CUSTOM:
      // Manual ordering is a v1.1 feature; until then, fall through to alpha
    case CHOICES.SORT_ORDER.ALPHABETICAL:
    case CHOICES.SORT_ORDER.CURRENCY_FIRST:
    default:
      return items.sort(byName);
  }
}

function buildCapacity(totalWeight, settings) {
  if (!settings.enforceCapacity) {
    return {
      enforced: false,
      current: round2(totalWeight),
      limit: null,
      remaining: null,
      percent: 0,
      over: false
    };
  }

  const limit = settings.capacityLimit;
  const percent = limit > 0 ? Math.min(100, (totalWeight / limit) * 100) : 0;

  return {
    enforced: true,
    current: round2(totalWeight),
    limit,
    remaining: Math.max(0, round2(limit - totalWeight)),
    percent: round2(percent),
    over: totalWeight > limit
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
