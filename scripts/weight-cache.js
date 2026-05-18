/**
 * Quartermaster — Weight Cache
 *
 * In-memory cache of expensive aggregate values computed from an actor's
 * items and currency. The cached values are raw (settings-independent);
 * settings-derived values like "capacity percent" or "currency weight"
 * are computed by callers at read time using these raw inputs.
 *
 * Cached per actor:
 *   - itemWeight:    sum of (item.weight × item.quantity) across all items
 *   - coinSum:       sum of all 5 currency values
 *   - coinValues:    { pp, gp, ep, sp, cp } snapshot
 *
 * The cache exists primarily for two reasons:
 *
 *   1. Centralization. The weight-extraction logic that handles both
 *      dnd5e v3 scalar and v5 object weight schemas should live in one
 *      place, not be duplicated between the inventory rendering pipeline
 *      and the future "can this fit?" check used by drag-drop.
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

const _cache = new Map(); // actorId → { itemWeight, coinSum, coinValues }

// ============================================================
// Public read API
// ============================================================

/**
 * Get the raw weight/currency totals for an actor. Computes on first
 * access, returns the cached value on subsequent calls until invalidation.
 *
 * @param {Actor} actor
 * @returns {{ itemWeight: number, coinSum: number, coinValues: Object } | null}
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
 * @returns {{ itemWeight: number, coinSum: number, coinValues: Object } | null}
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
    if (changes?.system?.currency !== undefined) {
      invalidateActor(actor.id);
    }
  });
}

// ============================================================
// Compute helpers (private)
// ============================================================

function computeRawTotals(actor) {
  const itemWeight = computeItemWeight(actor);
  const { coinSum, coinValues } = computeCurrencyTotals(actor);
  return { itemWeight, coinSum, coinValues };
}

function computeItemWeight(actor) {
  if (!actor?.items) return 0;
  let total = 0;
  for (const item of actor.items) {
    const w = extractItemWeight(item);
    const qty = item.system?.quantity ?? 1;
    total += w * qty;
  }
  return total;
}

function extractItemWeight(item) {
  const w = item?.system?.weight;
  if (typeof w === "number") return w;
  if (w !== null && typeof w === "object") return w.value ?? 0;
  return 0;
}

function computeCurrencyTotals(actor) {
  const c = actor?.system?.currency ?? {};
  const coinValues = {
    pp: c.pp ?? 0,
    gp: c.gp ?? 0,
    ep: c.ep ?? 0,
    sp: c.sp ?? 0,
    cp: c.cp ?? 0
  };
  const coinSum =
    coinValues.pp + coinValues.gp + coinValues.ep + coinValues.sp + coinValues.cp;
  return { coinSum, coinValues };
}
