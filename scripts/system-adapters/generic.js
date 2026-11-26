/**
 * Quartermaster system adapter: conservative Foundry-core fallback.
 *
 * The generic adapter deliberately does not interpret `item.system`. Unknown
 * system data is carried through transfers unchanged, while the inventory UI
 * is limited to Foundry-core Item fields (name, image, and type).
 */

import { SYSTEM_ADAPTER_API_VERSION } from "../constants.js";

export const GENERIC_CURRENCY_ID = "qm-cur-default";

export const genericAdapter = Object.freeze({
  apiVersion: SYSTEM_ADAPTER_API_VERSION,
  id: "generic",
  systemId: "*",
  label: "Generic Foundry System",
  capabilities: Object.freeze({
    nativeCurrencies: false,
    load: false,
    itemValue: false,
    identification: false,
    currencyWeight: false
  }),
  defaultCapacity: Object.freeze({ enforced: false, limit: null }),
  loadUnit: null,
  nativeCurrencyUnitsPerLoad: null,
  defaultReferenceCurrencyId: GENERIC_CURRENCY_ID,

  getRecommendedVaultActorType(availableTypes = getAvailableActorTypes()) {
    return normalizeActorTypes(availableTypes)[0] ?? null;
  },

  getCompatibleActorTypes(availableTypes = getAvailableActorTypes()) {
    return normalizeActorTypes(availableTypes);
  },

  isCompatibleActor(actor, { role = "recipient" } = {}) {
    if (!isActorLike(actor)) return false;
    if (role === "vault") {
      const available = getAvailableActorTypes();
      return available.length === 0 || available.includes(actor.type);
    }
    return supportsEmbeddedItems(actor);
  },

  canReceiveItem(itemOrData, destinationActor) {
    return Boolean(itemOrData && this.isCompatibleActor(destinationActor));
  },

  prepareItemForTransfer(data) {
    return cloneData(data);
  },

  normalizeItem(item) {
    return normalizeCoreItem(item);
  },

  computeItemLoad() {
    return 0;
  },

  listNativeCurrencies() {
    return [];
  },

  async applyNativeCurrencyDelta() {
    return { ok: false, error: "native-currency-unsupported" };
  },

  isNativeCurrencyItem() {
    return false;
  },

  computeNativeCurrencyLoad() {
    return 0;
  },

  formatLoad() {
    return null;
  },

  getActorTypeLabel(actorOrType) {
    return getActorTypeLabel(actorOrType);
  }
});

export function normalizeCoreItem(item) {
  return {
    id: item?.id ?? item?._id ?? null,
    uuid: item?.uuid ?? null,
    name: cleanString(item?.name) || "(unnamed)",
    rawName: cleanString(item?.name) || "(unnamed)",
    img: cleanString(item?.img) || "icons/svg/item-bag.svg",
    type: cleanString(item?.type) || "other",
    typeLabel: getItemTypeLabel(item?.type),
    quantity: 1,
    showQuantity: false,
    isIdentified: null,
    supportsIdentification: false,
    unitLoad: null,
    totalLoad: null,
    loadDisplay: null,
    priceDisplay: null,
    hasPrice: false
  };
}

export function getAvailableActorTypes() {
  const dataModels = globalThis.CONFIG?.Actor?.dataModels;
  if (dataModels && typeof dataModels === "object") return Object.keys(dataModels);
  const typeLabels = globalThis.CONFIG?.Actor?.typeLabels;
  if (typeLabels && typeof typeLabels === "object") return Object.keys(typeLabels);
  const templateTypes = globalThis.game?.system?.template?.Actor?.types;
  return Array.isArray(templateTypes) ? templateTypes.filter(type => typeof type === "string") : [];
}

export function normalizeActorTypes(types) {
  const values = Array.isArray(types)
    ? types
    : types && typeof types === "object" ? Object.keys(types) : [];
  return [...new Set(values.filter(type => typeof type === "string" && type.trim()).map(type => type.trim()))];
}

export function isActorLike(actor) {
  return Boolean(actor && typeof actor === "object" && actor.type && (actor.documentName === "Actor" || actor.items));
}

export function supportsEmbeddedItems(actor) {
  return isActorLike(actor)
    && actor.items != null
    && typeof actor.createEmbeddedDocuments === "function";
}

export function cloneData(data) {
  if (!data || typeof data !== "object") {
    throw new TypeError("Quartermaster adapter expected Item data to be an object");
  }
  const deepClone = globalThis.foundry?.utils?.deepClone;
  if (typeof deepClone === "function") return deepClone(data);
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(data);
  return JSON.parse(JSON.stringify(data));
}

export function getActorTypeLabel(actorOrType) {
  const type = typeof actorOrType === "string" ? actorOrType : actorOrType?.type;
  if (!type) return "Actor";
  const key = globalThis.CONFIG?.Actor?.typeLabels?.[type];
  if (key && globalThis.game?.i18n?.localize) return game.i18n.localize(key);
  return titleCase(type);
}

export function getItemTypeLabel(type) {
  const safeType = cleanString(type) || "other";
  const key = globalThis.CONFIG?.Item?.typeLabels?.[safeType];
  if (key && globalThis.game?.i18n?.localize) return game.i18n.localize(key);
  return titleCase(safeType);
}

export function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function finiteNonNegative(value, fallback = 0) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

export function roundLoad(value) {
  const numeric = finiteNonNegative(value, 0);
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/[-_]+/g, " ");
}
