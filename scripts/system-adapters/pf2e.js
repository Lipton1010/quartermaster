/** Quartermaster built-in adapter for the Pathfinder Second Edition system. */

import { CHOICES, SYSTEM_ADAPTER_API_VERSION } from "../constants.js";
import {
  cleanString,
  cloneData,
  finiteNonNegative,
  getActorTypeLabel,
  getAvailableActorTypes,
  getItemTypeLabel,
  normalizeActorTypes,
  roundLoad,
  supportsEmbeddedItems
} from "./generic.js";

export const PF2E_NATIVE_CURRENCIES = Object.freeze([
  Object.freeze({ id: "pp", name: "Platinum", symbol: "PP", referenceRate: 10 }),
  Object.freeze({ id: "gp", name: "Gold", symbol: "GP", referenceRate: 1 }),
  Object.freeze({ id: "sp", name: "Silver", symbol: "SP", referenceRate: 0.1 }),
  Object.freeze({ id: "cp", name: "Copper", symbol: "CP", referenceRate: 0.01 })
]);

const NATIVE_IDS = new Set(PF2E_NATIVE_CURRENCIES.map(currency => currency.id));
const PHYSICAL_ITEM_TYPES = new Set([
  "armor", "backpack", "book", "consumable", "equipment", "kit",
  "shield", "treasure", "weapon"
]);
const CURRENCY_FIRST_PRIORITY = Object.freeze({
  treasure: 0,
  consumable: 1,
  backpack: 2,
  equipment: 3,
  armor: 4,
  shield: 5,
  weapon: 6,
  book: 7,
  kit: 8
});

export const pf2eAdapter = Object.freeze({
  apiVersion: SYSTEM_ADAPTER_API_VERSION,
  id: "pf2e",
  systemId: "pf2e",
  label: "Pathfinder Second Edition",
  capabilities: Object.freeze({
    nativeCurrencies: true,
    load: true,
    itemValue: true,
    identification: true,
    currencyWeight: true
  }),
  defaultCapacity: Object.freeze({ enforced: false, limit: null }),
  loadUnit: Object.freeze({ id: "bulk", label: "Bulk", longLabel: "Bulk" }),
  nativeCurrencyUnitsPerLoad: 1000,
  defaultReferenceCurrencyId: "gp",

  getRecommendedVaultActorType(availableTypes = getAvailableActorTypes()) {
    const types = normalizeActorTypes(availableTypes);
    return types.includes("loot") ? "loot" : null;
  },

  getCompatibleActorTypes(availableTypes = getAvailableActorTypes()) {
    return normalizeActorTypes(availableTypes);
  },

  isCompatibleActor(actor, { role = "recipient" } = {}) {
    if (!actor || typeof actor !== "object") return false;
    if (role === "vault") return actor.type === "loot";
    return supportsEmbeddedItems(actor);
  },

  canReceiveItem(itemOrData, destinationActor) {
    if (!itemOrData || !this.isCompatibleActor(destinationActor)) return false;
    const type = itemOrData.type;
    const allowed = destinationActor.allowedItemTypes;
    if (!Array.isArray(allowed) || !type) return true;
    return allowed.includes(type) || (allowed.includes("physical") && isPhysicalItem(itemOrData));
  },

  prepareItemForTransfer(sourceData) {
    const data = cloneData(sourceData);
    const system = data.system;
    if (!system || typeof system !== "object") return data;

    // Container, carried, and invested state belongs to the previous Actor.
    if ("containerId" in system) system.containerId = null;
    if (system.equipped && typeof system.equipped === "object") {
      system.equipped.carryType = "worn";
      if ("handsHeld" in system.equipped) system.equipped.handsHeld = 0;
      if ("inSlot" in system.equipped) system.equipped.inSlot = false;
      if ("invested" in system.equipped) system.equipped.invested = false;
    }
    return data;
  },

  normalizeItem(item, { unidentifiedDisplay = CHOICES.UNIDENTIFIED_DISPLAY.UNIDENTIFIED } = {}) {
    const system = item?.system ?? {};
    const physical = isPhysicalItem(item);
    const quantity = physical ? finiteNonNegative(item?.quantity ?? system.quantity, 1) : 1;
    const identificationStatus = physical ? cleanString(item?.identificationStatus ?? system.identification?.status) : "";
    const supportsIdentification = Boolean(identificationStatus);
    const isIdentified = supportsIdentification ? identificationStatus === "identified" : null;
    const identified = system.identification?.identified ?? {};
    const unidentified = system.identification?.unidentified ?? {};
    const rawName = cleanString(identified.name)
      || cleanString(item?._source?.name)
      || cleanString(item?.name)
      || "(unnamed)";
    const showIdentified = isIdentified !== false
      || unidentifiedDisplay === CHOICES.UNIDENTIFIED_DISPLAY.IDENTIFIED;
    const name = showIdentified
      ? rawName
      : cleanString(unidentified.name) || cleanString(item?.name) || "Unidentified Item";
    const img = showIdentified
      ? cleanString(identified.img) || cleanString(item?.img)
      : cleanString(unidentified.img) || cleanString(item?.img);
    const totalLoad = physical ? getPf2eBulkValue(item, quantity) : null;
    const loadDisplay = totalLoad == null ? null : getPf2eBulkDisplay(item, totalLoad);
    const priceDisplay = physical ? formatPf2ePrice(getPf2eAssetValue(item, quantity)) : null;

    return {
      id: item?.id ?? item?._id ?? null,
      uuid: item?.uuid ?? null,
      name,
      rawName,
      img: img || "icons/svg/item-bag.svg",
      type: cleanString(item?.type) || "other",
      typeLabel: getItemTypeLabel(item?.type),
      quantity,
      showQuantity: quantity > 1,
      isIdentified,
      supportsIdentification,
      identificationStatus: identificationStatus || null,
      unitLoad: null,
      totalLoad,
      loadDisplay,
      priceDisplay,
      hasPrice: Boolean(priceDisplay),
      sortPriority: CURRENCY_FIRST_PRIORITY[item?.type] ?? 99
    };
  },

  computeItemLoad(actor, { items = null } = {}) {
    const allNonCurrencyItems = actor?.items
      ? [...actor.items].filter(item => isPhysicalItem(item) && !this.isNativeCurrencyItem(item))
      : [];
    const candidates = (Array.isArray(items) ? items : allNonCurrencyItems)
      .filter(item => isPhysicalItem(item) && !this.isNativeCurrencyItem(item));

    // PF2e groups split stacks and applies container/size rules at the Actor
    // inventory level. Use that native aggregate whenever the caller has not
    // excluded any non-currency Item, then remove coin Bulk so Quartermaster's
    // applyCurrencyWeight setting can add it back independently.
    if (sameItems(candidates, allNonCurrencyItems)) {
      const aggregate = getPf2eInventoryBulkValue(actor);
      if (aggregate != null) {
        const nativeCurrencies = this.listNativeCurrencies(actor)
          .map(currency => ({ ...currency, source: "native" }));
        const currencyLoad = this.computeNativeCurrencyLoad(nativeCurrencies);
        return roundLoad(Math.max(0, aggregate - currencyLoad));
      }
    }

    // The native aggregate helper also accepts a subset. This path preserves
    // Quartermaster visibility filtering when legacy hidden Items remain.
    const nativeBulk = actor?.inventory?.bulk;
    const computeTotalBulk = nativeBulk?.constructor?.computeTotalBulk;
    if (typeof computeTotalBulk === "function") {
      try {
        const topLevel = candidates.filter(item => item?.isInContainer !== true);
        const result = computeTotalBulk.call(nativeBulk.constructor, topLevel, actor);
        const value = finiteBulkValue(result);
        if (value != null) return roundLoad(value);
      } catch { /* fall through to conservative per-Item metadata */ }
    }

    let total = 0;
    for (const item of candidates) {
      const load = getPf2eBulkValue(item, finiteNonNegative(item?.quantity ?? item?.system?.quantity, 1));
      if (Number.isFinite(load) && load > 0) total += load;
    }
    return roundLoad(total);
  },

  listNativeCurrencies(actor) {
    // `currency` is PF2e's current API in both supported releases. Retain the
    // deprecated `coins` alias as a compatibility fallback for integrations.
    const coins = actor?.inventory?.currency ?? actor?.inventory?.coins ?? {};
    return PF2E_NATIVE_CURRENCIES.map(definition => ({
      ...definition,
      value: finiteNonNegative(coins[definition.id], 0)
    }));
  },

  async applyNativeCurrencyDelta(actor, currencyId, delta) {
    if (!actor?.inventory || !NATIVE_IDS.has(currencyId)) {
      return { ok: false, error: "invalid-currency-type" };
    }
    if (!Number.isInteger(delta)) {
      return { ok: false, error: "whole-coins-required" };
    }

    const current = finiteNonNegative(readPf2eCurrency(actor, currencyId), 0);
    const next = current + delta;
    if (next < 0) return { ok: false, error: "insufficient-funds" };

    try {
      if (delta > 0) {
        const addCurrency = actor.inventory.addCurrency ?? actor.inventory.addCoins;
        if (typeof addCurrency !== "function") {
          return { ok: false, error: "native-currency-api-unavailable" };
        }
        await addCurrency.call(
          actor.inventory,
          { [currencyId]: delta },
          { combineStacks: true }
        );
      } else if (delta < 0) {
        const removeCurrency = actor.inventory.removeCurrency ?? actor.inventory.removeCoins;
        if (typeof removeCurrency !== "function") {
          return { ok: false, error: "native-currency-api-unavailable" };
        }
        const removed = await removeCurrency.call(
          actor.inventory,
          { [currencyId]: Math.abs(delta) },
          { byValue: false }
        );
        if (removed === false) {
          const observed = readPf2eCurrency(actor, currencyId);
          if (observed !== next) return { ok: false, error: "insufficient-funds" };
          return {
            ok: true,
            previousValue: current,
            newValue: next,
            committedAfterError: true
          };
        }
      }
    } catch (error) {
      const observed = readPf2eCurrency(actor, currencyId);
      if (observed === next) {
        console.warn("Quartermaster | PF2e currency update reported an error after committing", error);
        return {
          ok: true,
          previousValue: current,
          newValue: next,
          committedAfterError: true
        };
      }
      return {
        ok: false,
        error: "native-currency-update-failed",
        details: errorMessage(error)
      };
    }

    return { ok: true, previousValue: current, newValue: next };
  },

  isNativeCurrencyItem(item) {
    if (!item) return false;
    if (typeof item.isOfType === "function" && item.isOfType("treasure") && item.isCoinage === true) {
      return true;
    }
    return item.type === "treasure"
      && (
        item.isCoinage === true
        || item.system?.category === "coin"
        || item.system?.stackGroup === "coins"
      );
  },

  computeNativeCurrencyLoad(currencies) {
    if (!Array.isArray(currencies)) return 0;
    const totalCoins = currencies
      .filter(currency => currency?.source === "native")
      .reduce((total, currency) => total + finiteNonNegative(currency.value, 0), 0);
    return Math.floor(totalCoins / this.nativeCurrencyUnitsPerLoad);
  },

  formatLoad(value) {
    return formatBulk(value);
  },

  getActorTypeLabel(actorOrType) {
    return getActorTypeLabel(actorOrType);
  }
});

export function isPhysicalItem(itemOrData) {
  if (typeof itemOrData?.isOfType === "function") {
    try {
      if (itemOrData.isOfType("physical")) return true;
    } catch { /* raw data or an older PF2e document */ }
  }
  return PHYSICAL_ITEM_TYPES.has(itemOrData?.type);
}

export function getPf2eBulkValue(item, quantity = 1) {
  const prepared = item?.bulk?.value;
  if (typeof prepared === "number" && Number.isFinite(prepared)) return roundLoad(prepared);

  const bulk = item?.system?.bulk;
  if (!bulk || typeof bulk !== "object") return null;
  const per = Math.max(1, finiteNonNegative(bulk.per, 1));
  const stackCount = Math.floor(finiteNonNegative(quantity, 1) / per);
  return roundLoad(finiteNonNegative(bulk.value, 0) * stackCount);
}

export function formatBulk(value) {
  const bulk = roundLoad(value);
  if (bulk <= 0) return "—";
  const whole = Math.floor(bulk);
  const light = Math.round((bulk - whole) * 10);
  if (whole === 0) return light === 1 ? "L" : `${light}L`;
  if (light === 0) return String(whole);
  return `${whole}; ${light === 1 ? "L" : `${light}L`}`;
}

export function getPf2eAssetValue(item, quantity = 1) {
  const prepared = item?.assetValue;
  if (prepared && typeof prepared === "object") return readCoins(prepared);

  const price = item?.system?.price;
  const unitCoins = readCoins(price?.value);
  const per = Math.max(1, finiteNonNegative(price?.per, 1));
  const multiplier = finiteNonNegative(quantity, 1) / per;
  return Object.fromEntries(
    PF2E_NATIVE_CURRENCIES.map(({ id }) => [id, unitCoins[id] * multiplier])
  );
}

export function formatPf2ePrice(coins) {
  const values = readCoins(coins);
  const parts = PF2E_NATIVE_CURRENCIES
    .map(({ id, symbol }) => ({ value: values[id], symbol }))
    .filter(entry => entry.value > 0)
    .map(entry => `${formatCoinAmount(entry.value)} ${entry.symbol}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function getPf2eBulkDisplay(item, fallbackValue) {
  try {
    const display = item?.bulk?.toString?.();
    if (typeof display === "string" && display.trim()) return display;
  } catch { /* localization may be unavailable in headless diagnostics */ }
  return formatBulk(fallbackValue);
}

function readCoins(raw) {
  const result = { pp: 0, gp: 0, sp: 0, cp: 0 };
  if (typeof raw === "string") {
    for (const match of raw.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(pp|gp|sp|cp)/gi)) {
      result[match[2].toLowerCase()] += finiteNonNegative(match[1], 0);
    }
    return result;
  }
  if (!raw || typeof raw !== "object") return result;
  for (const id of Object.keys(result)) result[id] = finiteNonNegative(raw[id], 0);
  return result;
}

function formatCoinAmount(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return String(rounded);
}

function getPf2eInventoryBulkValue(actor) {
  try {
    const inventoryBulk = actor?.inventory?.bulk;
    return finiteBulkValue(inventoryBulk?.value) ?? finiteBulkValue(inventoryBulk);
  } catch {
    return null;
  }
}

function finiteBulkValue(raw) {
  const value = typeof raw === "number" ? raw : raw?.value;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sameItems(left, right) {
  if (left.length !== right.length) return false;
  const keys = new Set(left.map((item, index) => item?.id ?? item?._id ?? item ?? index));
  return right.every((item, index) => keys.has(item?.id ?? item?._id ?? item ?? index));
}

function readPf2eCurrency(actor, currencyId) {
  try {
    const inventory = actor?.inventory;
    return finiteNonNegative(
      inventory?.currency?.[currencyId] ?? inventory?.coins?.[currencyId],
      Number.NaN
    );
  } catch {
    return Number.NaN;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
