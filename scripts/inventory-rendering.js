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
import { getCurrencies, getReferenceCurrency } from "./currencies.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";
import { isActiveStorageGM } from "./storage-ledger.js";

/**
 * Build the full rendering context for an inventory popup render.
 *
 * @param {Actor|null} actor  the backing actor; pass null to get the
 *                            "not initialized" stub context
 * @returns {Object}
 */
export function buildInventoryContext(actor) {
  const adapter = getActiveSystemAdapter();
  if (!actor) {
    return {
      backingActorPresent: false,
      backingActorName: null,
      backingActorId: null,
      systemAdapter: buildAdapterContext(adapter)
    };
  }

  const settings = readSettings(adapter);
  const currencies = getCurrencies(actor, {
    includeHidden: false,
    hideZero: settings.hideZeroBalances
  }).map(currency => ({ ...currency, type: currency.id }));
  // Visibility is presentation-only. Hidden balances still exist and must
  // contribute to load/capacity calculations.
  const loadCurrencies = settings.applyCurrencyWeight
    ? getCurrencies(actor, { includeHidden: true, hideZero: false })
    : currencies;
  const referenceCurrency = getReferenceCurrency(actor);
  const resources = buildResources(actor);
  const items = buildItems(actor, settings, adapter);

  // Pull raw visible inventory totals from the cache (computed once and reused
  // until item or currency changes invalidate it via weight-cache hooks).
  const raw = getRawTotals(actor) ?? {
    itemLoad: 0,
    itemWeight: 0,
    loadSupported: adapter.capabilities.load === true,
    loadUnit: adapter.loadUnit ?? null,
    coinSum: 0,
    coinValues: {}
  };

  // Settings-derived values are computed at read time so toggling
  // applyCurrencyWeight or capacityLimit doesn't require cache invalidation.
  const nativeCurrencyLoad = adapter.capabilities.currencyWeight
    ? adapter.computeNativeCurrencyLoad(loadCurrencies, actor)
    : 0;
  const customCurrencyLoad = loadCurrencies
    .filter(currency => currency.isCustom)
    .reduce((sum, currency) => {
      const weightPerUnit = Number(currency.weightPerUnit) || 0;
      return sum + currency.value * weightPerUnit;
    }, 0);
  const currencyLoad = settings.applyCurrencyWeight && adapter.capabilities.load
    ? Number(nativeCurrencyLoad || 0) + customCurrencyLoad
    : 0;
  const itemLoad = Number(raw.itemLoad ?? raw.itemWeight) || 0;
  const totalLoad = itemLoad + currencyLoad;

  const gpEquivalent = currencies.reduce((sum, currency) => {
    return sum + (currency.gpRate == null ? 0 : currency.value * currency.gpRate);
  }, 0);
  const referenceEquivalent = currencies.reduce((sum, currency) => {
    return sum + (currency.referenceRate == null ? 0 : currency.value * currency.referenceRate);
  }, 0);

  // Capacity state
  const capacity = buildCapacity(totalLoad, settings, adapter);

  return {
    backingActorPresent: true,
    backingActorName: actor.name,
    backingActorId: actor.id,
    systemAdapter: buildAdapterContext(adapter),
    capabilities: { ...adapter.capabilities },
    hasLoad: adapter.capabilities.load === true,
    loadUnit: adapter.loadUnit ?? null,
    loadUnitLabel: adapter.loadUnit?.label ?? null,
    isGM: isActiveStorageGM(),
    inventoryLabel: settings.inventoryButtonLabel,
    hasBackgroundImage: Boolean(settings.inventoryBackgroundImage),
    backgroundImageSrc: settings.inventoryBackgroundImage,
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
      itemLoad: round2(itemLoad),
      currencyLoad: round2(currencyLoad),
      totalLoad: round2(totalLoad),
      itemLoadDisplay: adapter.formatLoad(itemLoad),
      currencyLoadDisplay: adapter.formatLoad(currencyLoad),
      totalLoadDisplay: adapter.formatLoad(totalLoad),
      // v0.1 compatibility fields consumed by existing templates/macros.
      itemWeight: round2(itemLoad),
      currencyWeight: round2(currencyLoad),
      totalWeight: round2(totalLoad),
      gpEquivalent: round2(gpEquivalent),
      referenceEquivalent: round2(referenceEquivalent),
      referenceCurrencyName: referenceCurrency?.name ?? "Currency",
      referenceCurrencySymbol: referenceCurrency?.symbol ?? "CUR",
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

function readSettings(adapter) {
  const supportsLoad = adapter.capabilities.load === true;
  const configuredCapacity = Boolean(game.settings.get(MODULE_ID, SETTINGS.ENFORCE_CAPACITY));
  const hasStoredCapacity = hasStoredWorldSetting(SETTINGS.ENFORCE_CAPACITY);
  return {
    enforceCapacity: supportsLoad && (hasStoredCapacity
      ? configuredCapacity
      : adapter.defaultCapacity?.enforced === true),
    capacityLimit: game.settings.get(MODULE_ID, SETTINGS.CAPACITY_LIMIT),
    applyCurrencyWeight: supportsLoad && adapter.capabilities.currencyWeight === true
      && Boolean(game.settings.get(MODULE_ID, SETTINGS.APPLY_CURRENCY_WEIGHT)),
    hideZeroBalances: game.settings.get(MODULE_ID, SETTINGS.HIDE_ZERO_BALANCES),
    sortOrder: game.settings.get(MODULE_ID, SETTINGS.SORT_ORDER),
    entrySize: game.settings.get(MODULE_ID, SETTINGS.DEFAULT_ENTRY_SIZE),
    unidentifiedDisplay: game.settings.get(MODULE_ID, SETTINGS.UNIDENTIFIED_DISPLAY),
    inventoryButtonLabel: getInventoryButtonLabel(),
    inventoryBackgroundImage: String(game.settings.get(MODULE_ID, SETTINGS.INVENTORY_BACKGROUND_IMAGE) ?? "").trim(),
    showItemPrices: adapter.capabilities.itemValue === true
      && (game.user.isGM || !game.settings.get(MODULE_ID, SETTINGS.HIDE_PRICES_FROM_PLAYERS))
  };
}

function hasStoredWorldSetting(settingKey) {
  try {
    return game.settings.storage?.get("world")?.has?.(`${MODULE_ID}.${settingKey}`) === true;
  } catch {
    return false;
  }
}

export function getInventoryButtonLabel() {
  const configured = game.settings.get(MODULE_ID, SETTINGS.INVENTORY_BUTTON_LABEL);
  return configured?.trim() || game.i18n.localize("quartermaster.buttons.sharedPartyInventory");
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

function buildItems(actor, settings, adapter) {
  const items = [...actor.items]
    .filter(i => !i.getFlag(MODULE_ID, FLAGS.HIDDEN))
    .filter(i => !adapter.isNativeCurrencyItem(i))
    .map(i => prepareItemDisplay(i, settings, adapter));

  return sortItems(items, settings.sortOrder);
}

/**
 * Compute display-ready fields for one item.
 */
export function prepareItemDisplay(item, settings, adapter = getActiveSystemAdapter()) {
  const normalized = adapter.normalizeItem(item, {
    unidentifiedDisplay: settings.unidentifiedDisplay
  });
  const priceDisplay = settings.showItemPrices ? normalized.priceDisplay : null;

  return {
    ...normalized,
    // Compatibility fields for the current inventory template. System-aware
    // templates should use hasLoad/loadDisplay/totalLoad instead.
    weight: normalized.unitLoad == null ? null : round2(normalized.unitLoad),
    totalWeight: normalized.totalLoad == null ? null : round2(normalized.totalLoad),
    hasLoad: normalized.totalLoad != null,
    qmSortIndex: item.getFlag?.(MODULE_ID, "sortIndex") ?? null,
    priceDisplay,
    hasPrice: settings.showItemPrices && !!priceDisplay
  };
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
      // Adapters assign system-appropriate treasure/item priority tiers.
      return items.sort((a, b) => {
        const pa = a.sortPriority ?? 99;
        const pb = b.sortPriority ?? 99;
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
      const label = item.typeLabel || type.charAt(0).toUpperCase() + type.slice(1);
      groups.set(type, { label, type, items: [] });
    }
    groups.get(type).items.push(item);
  }
  return Array.from(groups.values());
}

function buildCapacity(totalLoad, settings, adapter) {
  const supported = adapter.capabilities.load === true;
  if (!supported || !settings.enforceCapacity) {
    return {
      supported,
      enforced: false,
      current: round2(totalLoad),
      currentDisplay: supported ? adapter.formatLoad(totalLoad) : null,
      unit: adapter.loadUnit ?? null,
      limit: null,
      remaining: null,
      percent: 0,
      over: false
    };
  }

  const limit = settings.capacityLimit;
  const percent = limit > 0 ? Math.min(100, (totalLoad / limit) * 100) : 0;

  return {
    supported: true,
    enforced: true,
    current: round2(totalLoad),
    currentDisplay: adapter.formatLoad(totalLoad),
    unit: adapter.loadUnit ?? null,
    limit,
    limitDisplay: adapter.formatLoad(limit),
    remaining: Math.max(0, round2(limit - totalLoad)),
    percent: round2(percent),
    over: totalLoad > limit
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function buildAdapterContext(adapter) {
  return {
    id: adapter.id,
    systemId: adapter.systemId === "*" ? (game.system?.id ?? null) : adapter.systemId,
    label: adapter.label,
    capabilities: { ...adapter.capabilities },
    loadUnit: adapter.loadUnit ?? null,
    nativeCurrencyUnitsPerLoad: adapter.nativeCurrencyUnitsPerLoad ?? null
  };
}
