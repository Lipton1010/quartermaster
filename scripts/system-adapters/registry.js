/**
 * Quartermaster system-adapter registry.
 *
 * Adapters are synchronous presentation/validation services except for native
 * currency mutation. The registry always returns the conservative generic
 * adapter, including during early startup and in headless tests.
 */

import { HOOKS, SYSTEM_ADAPTER_API_VERSION } from "../constants.js";
import { dnd5eAdapter } from "./dnd5e.js";
import { genericAdapter } from "./generic.js";
import { pf2eAdapter } from "./pf2e.js";

export const REQUIRED_ADAPTER_METHODS = Object.freeze([
  "getRecommendedVaultActorType",
  "getCompatibleActorTypes",
  "isCompatibleActor",
  "canReceiveItem",
  "prepareItemForTransfer",
  "normalizeItem",
  "computeItemLoad",
  "listNativeCurrencies",
  "applyNativeCurrencyDelta",
  "isNativeCurrencyItem",
  "computeNativeCurrencyLoad",
  "formatLoad",
  "getActorTypeLabel"
]);

const adapters = new Map([
  [dnd5eAdapter.systemId, dnd5eAdapter],
  [pf2eAdapter.systemId, pf2eAdapter]
]);
let initialized = false;

/**
 * Register an adapter for a Foundry system ID.
 *
 * This accepts either `(systemId, adapter, options)` or `(adapter, options)`.
 * The latter reads `adapter.systemId`. Duplicate registration is rejected
 * unless `{ replace: true }` is explicit.
 */
export function registerSystemAdapter(systemIdOrAdapter, adapterOrOptions, maybeOptions = {}) {
  const shorthand = systemIdOrAdapter && typeof systemIdOrAdapter === "object";
  const adapter = shorthand ? systemIdOrAdapter : adapterOrOptions;
  const options = shorthand ? (adapterOrOptions ?? {}) : maybeOptions;
  const systemId = cleanId(shorthand ? adapter?.systemId : systemIdOrAdapter);

  if (!systemId || systemId === "*") {
    throw new TypeError("Quartermaster system adapters require a concrete systemId");
  }
  validateAdapter(adapter, systemId);
  if (adapters.has(systemId) && options?.replace !== true) {
    throw new Error(`Quartermaster already has a system adapter for \"${systemId}\"`);
  }
  adapters.set(systemId, adapter);
  return adapter;
}

export const registerAdapter = registerSystemAdapter;

/** Fire the public registration hook once, after built-ins are available. */
export function initializeSystemAdapters() {
  if (initialized) return getActiveSystemAdapter();
  initialized = true;

  const hookApi = Object.freeze({
    apiVersion: SYSTEM_ADAPTER_API_VERSION,
    register: registerSystemAdapter,
    registerAdapter: registerSystemAdapter,
    registerSystemAdapter,
    get: getSystemAdapter,
    getActive: getActiveSystemAdapter
  });
  if (globalThis.Hooks?.callAll) {
    Hooks.callAll(HOOKS.REGISTER_SYSTEM_ADAPTERS, hookApi);
  }
  return getActiveSystemAdapter();
}

export function getSystemAdapter(systemId) {
  return adapters.get(cleanId(systemId)) ?? genericAdapter;
}

export function getActiveSystemAdapter() {
  return getSystemAdapter(globalThis.game?.system?.id);
}

export function getSystemAdapterDiagnostics() {
  const systemId = cleanId(globalThis.game?.system?.id) || null;
  const adapter = getSystemAdapter(systemId);
  return {
    apiVersion: SYSTEM_ADAPTER_API_VERSION,
    initialized,
    systemId,
    adapterId: adapter.id,
    adapterSystemId: adapter.systemId,
    adapterLabel: adapter.label,
    usingFallback: !systemId || !adapters.has(systemId),
    capabilities: { ...adapter.capabilities },
    loadUnit: adapter.loadUnit ?? null,
    nativeCurrencyUnitsPerLoad: adapter.nativeCurrencyUnitsPerLoad ?? null,
    registered: [...adapters.entries()].map(([id, registered]) => ({
      systemId: id,
      adapterId: registered.id,
      label: registered.label,
      apiVersion: registered.apiVersion
    }))
  };
}

// Small delegation helpers keep callers independent of registry bookkeeping.
export function isCompatibleActor(actor, options) {
  return getActiveSystemAdapter().isCompatibleActor(actor, options);
}

export function canReceiveItem(itemOrData, destinationActor) {
  return getActiveSystemAdapter().canReceiveItem(itemOrData, destinationActor);
}

export function prepareItemForTransfer(data, context) {
  return getActiveSystemAdapter().prepareItemForTransfer(data, context);
}

export function normalizeItem(item, options) {
  return getActiveSystemAdapter().normalizeItem(item, options);
}

export function listNativeCurrencies(actor) {
  return getActiveSystemAdapter().listNativeCurrencies(actor);
}

export function validateAdapter(adapter, expectedSystemId = null) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new TypeError("Quartermaster system adapter must be an object");
  }
  if (Number(adapter.apiVersion) !== SYSTEM_ADAPTER_API_VERSION) {
    throw new TypeError(
      `Quartermaster adapter \"${adapter.id ?? "unknown"}\" uses API version `
      + `${adapter.apiVersion ?? "missing"}; expected ${SYSTEM_ADAPTER_API_VERSION}`
    );
  }
  if (!cleanId(adapter.id)) throw new TypeError("Quartermaster system adapter requires an id");
  const systemId = cleanId(adapter.systemId);
  if (!systemId) throw new TypeError("Quartermaster system adapter requires a systemId");
  if (expectedSystemId && systemId !== expectedSystemId) {
    throw new TypeError(
      `Quartermaster adapter systemId \"${systemId}\" does not match registration key \"${expectedSystemId}\"`
    );
  }
  if (!adapter.capabilities || typeof adapter.capabilities !== "object") {
    throw new TypeError(`Quartermaster adapter \"${adapter.id}\" requires capabilities`);
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new TypeError(`Quartermaster adapter \"${adapter.id}\" is missing ${method}()`);
    }
  }
  return true;
}

function cleanId(value) {
  return typeof value === "string" ? value.trim() : "";
}
