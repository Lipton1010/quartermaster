/**
 * Quartermaster — Weight Cache
 *
 * In-memory cache of expensive aggregate load values computed from an actor's
 * items and native currency. The cached values are raw (settings-independent);
 * settings-derived values like "capacity percent" or "currency weight"
 * are computed by callers at read time using these raw inputs.
 *
 * Cached per actor:
 *   - itemLoad:      adapter-normalized total load across visible items
 *   - itemWeight:    compatibility alias for itemLoad
 *   - coinSum:       sum of native currency values
 *   - coinValues:    adapter-native balance snapshot
 *
 * The cache exists primarily for two reasons:
 *
 *   1. Centralization. System-specific load extraction belongs to adapters,
 *      not the inventory rendering or drag/drop layers.
 *
 *   2. Read amortization. Drag-drop and capacity-check operations need
 *      to query total weight without forcing a full re-render. The cache
 *      provides a cheap synchronous read.
 *
 * Invalidation is conservative: any item CRUD or currency change on the
 * cached actor drops its entry. The next read recomputes. We do NOT
 * attempt incremental updates (e.g., subtracting the removed item's
 * weight from the cached total); the failure modes there are subtle
 * (item schema changes mid-flight, stale references) and the
 * recomputation cost is bounded by item count, which is small.
 */

import { MODULE_ID, FLAGS } from "./constants.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";

const _cache = new Map();

// ============================================================
// Public read API
// ============================================================

/**
 * Get the raw weight/currency totals for an actor. Computes on first
 * access, returns the cached value on subsequent calls until invalidation.
 *
 * @param {Actor} actor
 * @returns {{ itemLoad: number, itemWeight: number, loadSupported: boolean,
 *   loadUnit: Object|null, coinSum: number, coinValues: Object } | null}
 */
export function getRawTotals(actor) {
  if (!actor?.id) return null;

  const cached = _cache.get(actor.id);
  if (cached) return cached;

  const fresh = computeRawTotals(actor);
  _cache.set(actor.id, fresh);
  return fresh;
}

/**
 * Force a recomputation without using the cache. Returns the same shape
 * as `getRawTotals` but writes the fresh value into the cache as a
 * side effect.
 *
 * Used by tests and by future "verify cache integrity" diagnostics.
 *
 * @param {Actor} actor
 * @returns {{ itemLoad: number, itemWeight: number, loadSupported: boolean,
 *   loadUnit: Object|null, coinSum: number, coinValues: Object } | null}
 */
export function recomputeTotals(actor) {
  if (!actor?.id) return null;
  const fresh = computeRawTotals(actor);
  _cache.set(actor.id, fresh);
  return fresh;
}

// ============================================================
// Invalidation
// ============================================================

/**
 * Drop the cache entry for one actor. The next read will recompute.
 */
export function invalidateActor(actorId) {
  if (!actorId) return false;
  return _cache.delete(actorId);
}

/**
 * Clear every cache entry. Used at module unload or by tests.
 */
export function invalidateAll() {
  _cache.clear();
}

// ============================================================
// Diagnostics
// ============================================================

/**
 * Number of actors currently in the cache.
 */
export function size() {
  return _cache.size;
}

/**
 * Inspect a single cache entry without forcing a compute. Returns null
 * if not cached. Used by tests to distinguish hit from miss.
 */
export function peek(actorId) {
  return _cache.get(actorId) ?? null;
}

/**
 * Snapshot of which actor IDs are currently cached. Used by diagnostics.
 */
export function cachedActorIds() {
  return [...(_cache.keys())];
}

// ============================================================
// Hook registration (called once at module ready)
// ============================================================

/**
 * Register the invalidation hooks. Called once from module.js ready
 * after the backing actor is in place. The handlers run cheaply on
 * every document update because the cache lookup is O(1).
 */
export function registerWeightCacheHooks() {
  Hooks.on("createItem", (item) => {
    if (item?.parent?.documentName === "Actor") {
      invalidateActor(item.parent.id);
    }
  });
  Hooks.on("updateItem", (item) => {
    if (item?.parent?.documentName === "Actor") {
      invalidateActor(item.parent.id);
    }
  });
  Hooks.on("deleteItem", (item, options, userId) => {
    // On delete, item.parent may be detached by the time the hook fires.
    // Use the actor reference if still present; fall back to options.
    const parentId = item?.parent?.id ?? options?.parent?.id;
    if (parentId) invalidateActor(parentId);
  });
  Hooks.on("updateActor", (actor, changes) => {
    // Native currency may be stored anywhere in a system schema. Invalidating
    // on all Actor updates is intentionally conservative and remains O(1).
    if (changes && actor?.id) invalidateActor(actor.id);
  });
}

// ============================================================
// Compute helpers (private)
// ============================================================

function computeRawTotals(actor) {
  const adapter = getActiveSystemAdapter();
  const itemLoad = computeItemLoad(actor, adapter);
  const { coinSum, coinValues } = computeCurrencyTotals(actor);
  return {
    itemLoad,
    // v0.1 compatibility for callers and console diagnostics.
    itemWeight: itemLoad,
    loadSupported: adapter.capabilities.load === true,
    loadUnit: adapter.loadUnit ?? null,
    coinSum,
    coinValues
  };
}

function computeItemLoad(actor, adapter) {
  if (adapter.capabilities.load !== true) return 0;
  if (!actor?.items) return 0;
  const items = [];
  for (const item of actor.items) {
    if (item.getFlag?.(MODULE_ID, FLAGS.HIDDEN) === true) continue;
    if (adapter.isNativeCurrencyItem(item)) continue;
    items.push(item);
  }
  try {
    const total = Number(adapter.computeItemLoad(actor, { items }));
    return Number.isFinite(total) && total >= 0
      ? Math.round((total + Number.EPSILON) * 100) / 100
      : 0;
  } catch (err) {
    console.warn("Quartermaster | Could not compute Actor Item load", actor?.uuid ?? actor?.id, err);
    return 0;
  }
}

function computeCurrencyTotals(actor) {
  let currencies = [];
  try {
    currencies = getActiveSystemAdapter().listNativeCurrencies(actor);
  } catch { /* a malformed third-party adapter should not break rendering */ }
  const coinValues = {};
  let coinSum = 0;
  for (const currency of Array.isArray(currencies) ? currencies : []) {
    const id = typeof currency?.id === "string" ? currency.id : null;
    const value = Number(currency?.value);
    if (!id || !Number.isFinite(value) || value < 0) continue;
    coinValues[id] = value;
    coinSum += value;
  }
  return { coinSum, coinValues };
}
