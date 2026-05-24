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
    sortedByType: settings.sortOrder === CHOICES.SORT_ORDER.BY_TYPE,
    sortedCustom: settings.sortOrder === CHOICES.SORT_ORDER.CUSTOM,
    itemGroups: settings.sortOrder === CHOICES.SORT_ORDER.BY_TYPE ? groupItemsByType(items) : null,
    totals: {
      itemWeight: round2(raw.itemWeight),
      currencyWeight: round2(currencyWeight),
      totalWeight: round2(totalWeight),
      gpEquivalent: round2(gpEquivalent),
      applyCurrencyWeight: settings.applyCurrencyWeight
    },
    capacity,
    settings: {
      ...settings,
      sortAlpha: settings.sortOrder === CHOICES.SORT_ORDER.ALPHABETICAL || settings.sortOrder === "alphabetical",
      sortCurrFirst: settings.sortOrder === CHOICES.SORT_ORDER.CURRENCY_FIRST || settings.sortOrder === "currencyFirst"
    }
  };
}

function readSettings() {
  return {
    enforceCapacity: game.settings.get(MODULE_ID, SETTINGS.ENFORCE_CAPACITY),
    capacityLimit: game.settings.get(MODULE_ID, SETTINGS.CAPACITY_LIMIT),
    applyCurrencyWeight: game.settings.get(MODULE_ID, SETTINGS.APPLY_CURRENCY_WEIGHT),
    hideZeroBalances: game.settings.get(MODULE_ID, SETTINGS.HIDE_ZERO_BALANCES),
    hideElectrum: game.settings.get(MODULE_ID, SETTINGS.HIDE_ELECTRUM),
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
  if (settings.hideElectrum) {
    rows = rows.filter(r => r.type !== "ep");
  }
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

  // Price/value display
  const priceVal = sys.price?.value ?? 0;
  const priceDenom = sys.price?.denomination ?? "gp";
  const priceDisplay = formatItemPrice(priceVal, priceDenom, quantity);

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
    rawName: item.name,
    qmSortIndex: item.getFlag?.(MODULE_ID, "sortIndex") ?? null,
    priceDisplay,
    hasPrice: !!priceDisplay
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

    case CHOICES.SORT_ORDER.CURRENCY_FIRST:
      // Sort items by a priority tier: loot and consumables first (treasure-like),
      // then everything else alphabetically. The currency rail and resources are
      // already rendered above the items section in the template, so this sort
      // controls item-list ordering only.
      return items.sort((a, b) => {
        const pa = CURRENCY_FIRST_PRIORITY[a.type] ?? 99;
        const pb = CURRENCY_FIRST_PRIORITY[b.type] ?? 99;
        if (pa !== pb) return pa - pb;
        return byName(a, b);
      });

    case CHOICES.SORT_ORDER.CUSTOM:
      // Sort by the qmSortIndex flag (set via manual reorder). Items without
      // an index fall to the end, sorted by name.
      return items.sort((a, b) => {
        const ai = a.qmSortIndex ?? 999999;
        const bi = b.qmSortIndex ?? 999999;
        if (ai !== bi) return ai - bi;
        return byName(a, b);
      });

    case CHOICES.SORT_ORDER.ALPHABETICAL:
    default:
      return items.sort(byName);
  }
}

/**
 * Group sorted items by type for the "By Type" sort mode.
 * Returns an array of {label, type, items} objects.
 */
function groupItemsByType(items) {
  const groups = new Map();
  for (const item of items) {
    const type = item.type || "other";
    if (!groups.has(type)) {
      const label = CONFIG.Item?.typeLabels?.[type]
        ? game.i18n.localize(CONFIG.Item.typeLabels[type])
        : type.charAt(0).toUpperCase() + type.slice(1);
      groups.set(type, { label, type, items: [] });
    }
    groups.get(type).items.push(item);
  }
  return Array.from(groups.values());
}

/**
 * Priority tiers for "Currency First" sort. Lower = higher in the list.
 * Loot and consumables (treasure-like items) sort before equipment and weapons.
 */
const CURRENCY_FIRST_PRIORITY = {
  loot:        0,
  consumable:  1,
  container:   2,
  tool:        3,
  equipment:   4,
  armor:       5,
  weapon:      6,
  feat:        7,
  spell:       8,
  class:       9,
  subclass:    9,
  background:  9
};

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

/**
 * Convert an item's price to a readable display string.
 * Shows total value (price × quantity). Uses GP for values ≥ 1 GP,
 * SP for values ≥ 1 SP, CP otherwise. Never displays as EP.
 */
const DENOM_TO_CP = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };

function formatItemPrice(priceVal, denom, quantity) {
  if (!priceVal || priceVal <= 0) return null;
  const totalCP = priceVal * (DENOM_TO_CP[denom] ?? 100) * quantity;
  if (totalCP <= 0) return null;

  if (totalCP >= 100) {
    const gp = totalCP / 100;
    return Number.isInteger(gp) ? `${gp} GP` : `${round2(gp)} GP`;
  }
  if (totalCP >= 10) {
    const sp = totalCP / 10;
    return Number.isInteger(sp) ? `${sp} SP` : `${round2(sp)} SP`;
  }
  return `${totalCP} CP`;
}
