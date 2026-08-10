/** Quartermaster built-in adapter for the dnd5e system. */

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

export const DND5E_NATIVE_CURRENCIES = Object.freeze([
  Object.freeze({ id: "pp", name: "Platinum", symbol: "PP", referenceRate: 10 }),
  Object.freeze({ id: "gp", name: "Gold", symbol: "GP", referenceRate: 1 }),
  Object.freeze({ id: "ep", name: "Electrum", symbol: "EP", referenceRate: 0.5 }),
  Object.freeze({ id: "sp", name: "Silver", symbol: "SP", referenceRate: 0.1 }),
  Object.freeze({ id: "cp", name: "Copper", symbol: "CP", referenceRate: 0.01 })
]);

const NATIVE_IDS = new Set(DND5E_NATIVE_CURRENCIES.map(currency => currency.id));
const CURRENCY_FIRST_PRIORITY = Object.freeze({
  loot: 0,
  consumable: 1,
  container: 2,
  tool: 3,
  equipment: 4,
  armor: 5,
  weapon: 6,
  feat: 7,
  spell: 8,
  class: 9,
  subclass: 9,
  background: 9
});

export const dnd5eAdapter = Object.freeze({
  apiVersion: SYSTEM_ADAPTER_API_VERSION,
  id: "dnd5e",
  systemId: "dnd5e",
  label: "D&D Fifth Edition",
  capabilities: Object.freeze({
    nativeCurrencies: true,
    load: true,
    itemValue: true,
    identification: true,
    currencyWeight: true
  }),
  defaultCapacity: Object.freeze({ enforced: true, limit: 500 }),
  loadUnit: Object.freeze({ id: "lb", label: "lb", longLabel: "pounds" }),
  nativeCurrencyUnitsPerLoad: 50,
  defaultReferenceCurrencyId: "gp",

  getRecommendedVaultActorType(availableTypes = getAvailableActorTypes()) {
    const types = normalizeActorTypes(availableTypes);
    return types.includes("npc") ? "npc" : null;
  },

  getCompatibleActorTypes(availableTypes = getAvailableActorTypes()) {
    return normalizeActorTypes(availableTypes);
  },

  isCompatibleActor(actor, { role = "recipient" } = {}) {
    if (!actor || typeof actor !== "object") return false;
    if (role === "vault") return actor.type === "npc";
    return supportsEmbeddedItems(actor);
  },

  canReceiveItem(itemOrData, destinationActor) {
    return Boolean(itemOrData && this.isCompatibleActor(destinationActor));
  },

  prepareItemForTransfer(sourceData) {
    const data = cloneData(sourceData);
    const system = data.system;
    if (!system || typeof system !== "object") return data;
    if ("equipped" in system) system.equipped = false;
    if ("attuned" in system) system.attuned = false;
    if (typeof system.attunement === "number" && system.attunement === 2) {
      system.attunement = 1;
    }
    if (system.preparation && typeof system.preparation === "object"
        && "prepared" in system.preparation) {
      system.preparation.prepared = false;
    }
    stripDnd5eIntegrationCaches(data);
    return data;
  },

  normalizeItem(item, { unidentifiedDisplay = CHOICES.UNIDENTIFIED_DISPLAY.UNIDENTIFIED } = {}) {
    const system = item?.system ?? {};
    const quantity = finiteNonNegative(system.quantity, 1);
    const unitLoad = getDnd5eUnitWeight(system.weight);
    const totalLoad = roundLoad(unitLoad * quantity);
    const isIdentified = system.identified !== false;
    const rawName = cleanString(item?.name) || "(unnamed)";
    const unidentifiedName = cleanString(system.unidentified?.name) || "Unidentified Item";
    const name = !isIdentified && unidentifiedDisplay !== CHOICES.UNIDENTIFIED_DISPLAY.IDENTIFIED
      ? unidentifiedName
      : rawName;
    const priceDisplay = formatDnd5ePrice(system.price, quantity);

    return {
      id: item?.id ?? item?._id ?? null,
      uuid: item?.uuid ?? null,
      name,
      rawName,
      img: cleanString(item?.img) || "icons/svg/item-bag.svg",
      type: cleanString(item?.type) || "other",
      typeLabel: getItemTypeLabel(item?.type),
      quantity,
      showQuantity: quantity > 1,
      isIdentified,
      supportsIdentification: true,
      unitLoad: roundLoad(unitLoad),
      totalLoad,
      loadDisplay: this.formatLoad(totalLoad),
      priceDisplay,
      hasPrice: Boolean(priceDisplay),
      sortPriority: CURRENCY_FIRST_PRIORITY[item?.type] ?? 99
    };
  },

  computeItemLoad(actor, { items = null } = {}) {
    const candidates = Array.isArray(items)
      ? items
      : actor?.items ? [...actor.items] : [];
    let total = 0;
    for (const item of candidates) {
      try {
        const load = Number(this.normalizeItem(item)?.totalLoad);
        if (Number.isFinite(load) && load > 0) total += load;
      } catch { /* one malformed Item must not erase the remaining total */ }
    }
    return roundLoad(total);
  },

  listNativeCurrencies(actor) {
    const balances = actor?.system?.currency ?? {};
    return DND5E_NATIVE_CURRENCIES.map(definition => ({
      ...definition,
      value: finiteNonNegative(balances[definition.id], 0)
    }));
  },

  async applyNativeCurrencyDelta(actor, currencyId, delta) {
    if (!actor || !NATIVE_IDS.has(currencyId)) {
      return { ok: false, error: "invalid-currency-type" };
    }
    // D&D5e's native currency fields are non-negative integer fields. Reject
    // fractional deltas before update() so a system validation failure cannot
    // be mistaken for a transient write error and retried.
    if (!Number.isInteger(delta)) {
      return { ok: false, error: "whole-coins-required" };
    }
    const current = finiteNonNegative(actor.system?.currency?.[currencyId], 0);
    const next = current + delta;
    if (!Number.isFinite(next) || next < 0) {
      return { ok: false, error: "insufficient-funds" };
    }
    try {
      await actor.update({ [`system.currency.${currencyId}`]: next });
    } catch (error) {
      const observed = finiteNonNegative(actor.system?.currency?.[currencyId], Number.NaN);
      if (observed === next) {
        console.warn("Quartermaster | D&D currency update reported an error after committing", error);
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

  isNativeCurrencyItem() {
    return false;
  },

  computeNativeCurrencyLoad(currencies) {
    const count = Array.isArray(currencies)
      ? currencies.filter(currency => currency?.source === "native")
          .reduce((sum, currency) => sum + finiteNonNegative(currency.value, 0), 0)
      : 0;
    return roundLoad(count / this.nativeCurrencyUnitsPerLoad);
  },

  formatLoad(value) {
    return `${formatNumber(value)} lb`;
  },

  getActorTypeLabel(actorOrType) {
    return getActorTypeLabel(actorOrType);
  }
});

export function getDnd5eUnitWeight(rawWeight) {
  if (typeof rawWeight === "number") return finiteNonNegative(rawWeight, 0);
  if (rawWeight && typeof rawWeight === "object") {
    return finiteNonNegative(rawWeight.value, 0);
  }
  return 0;
}

export function formatDnd5ePrice(price, quantity = 1) {
  const amount = finiteNonNegative(price?.value, 0);
  if (amount <= 0) return null;
  const denomination = NATIVE_IDS.has(price?.denomination) ? price.denomination : "gp";
  const copperPerUnit = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 }[denomination];
  const totalCopper = amount * copperPerUnit * finiteNonNegative(quantity, 1);
  if (!(totalCopper > 0)) return null;
  if (totalCopper >= 100) return `${formatNumber(totalCopper / 100)} GP`;
  if (totalCopper >= 10) return `${formatNumber(totalCopper / 10)} SP`;
  return `${formatNumber(totalCopper)} CP`;
}

function formatNumber(value) {
  const rounded = roundLoad(value);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function stripDnd5eIntegrationCaches(data) {
  const flags = data.flags;
  if (!flags || typeof flags !== "object") return;
  const midi = flags["midi-qol"];
  if (midi && typeof midi === "object") {
    for (const key of ["advantage", "disadvantage", "lastSelectedTokenIds", "macroCalls", "cached"]) {
      delete midi[key];
    }
    if (Object.keys(midi).length === 0) delete flags["midi-qol"];
  }
  if (flags.dae && typeof flags.dae === "object") {
    delete flags.dae.cached;
    if (Object.keys(flags.dae).length === 0) delete flags.dae;
  }
}
