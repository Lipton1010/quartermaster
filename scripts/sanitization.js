/**
 * Quartermaster — Item Sanitization Pipeline
 *
 * Pre-create transformation for item data being transferred between actors.
 * Called BEFORE `createEmbeddedDocuments` so the destination actor receives
 * a clean object with a predictable UUID.
 *
 * The pipeline does three things:
 *
 *   1. Pre-generates a destination `_id` so the caller can compute the
 *      destination UUID before the create operation. This is critical for
 *      the Claim-and-Commit pattern in step 8 (the caller needs to log
 *      the destination UUID in the transaction before the create fires).
 *
 *   2. Delegates all system and integration-specific cleanup to the active
 *      adapter, then clears Quartermaster's own transient transfer flags.
 *
 *   3. Selectively rewrites Active Effect origins. Effects whose origin
 *      points to the source item get their origin rewritten to point to
 *      the destination item. Effects pointing to other entities (an
 *      ambient spell on another character, a scene effect) are left
 *      alone.
 *
 * The function is pure: it returns a new object and never mutates the
 * input. This means the source item document is safe from accidental
 * modification even if the destination create fails.
 *
 * Usage:
 *
 *   const raw = sourceItem.toObject();
 *   const cleaned = sanitizeItemForTransfer(raw, destActor, {
 *     sourceItemUuid: sourceItem.uuid
 *   });
 *   await destActor.createEmbeddedDocuments("Item", [cleaned], {
 *     keepId: true
 *   });
 *
 * The `{ keepId: true }` flag is critical: without it, Foundry will
 * discard our pre-generated `_id` and assign its own, breaking the
 * predictable-UUID guarantee.
 */

import { MODULE_ID, FLAGS } from "./constants.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";

// ============================================================
// Public API
// ============================================================

/**
 * Sanitize a source item's data for transfer to a destination actor.
 *
 * Returns a new object with a pre-generated `_id`, cleaned owner-specific
 * state, and selectively rewritten effect origins. Does not mutate the
 * input.
 *
 * @param {Object} sourceData - Raw item data, typically from `item.toObject()`
 * @param {Actor} destinationActor - The actor that will receive the item
 * @param {Object} [options]
 * @param {string} [options.sourceItemUuid] - Full UUID of the source item.
 *   When provided, Active Effect origins that start with this UUID will
 *   have their prefix rewritten to point to the destination item.
 * @param {boolean} [options.preserveHiddenFlag=true] - When true, the
 *   quartermaster.hidden flag is preserved across sanitization (used by
 *   GM Loot Prep to keep an item hidden during transfers). When false,
 *   the entire quartermaster flag namespace is cleared.
 * @returns {Object} The sanitized data, ready for createEmbeddedDocuments
 *   with `{ keepId: true }`
 */
export function sanitizeItemForTransfer(sourceData, destinationActor, options = {}) {
  if (!sourceData || typeof sourceData !== "object") {
    throw new TypeError("sanitizeItemForTransfer: sourceData must be an object");
  }
  if (!destinationActor?.id) {
    throw new TypeError("sanitizeItemForTransfer: destinationActor must have an id");
  }

  const {
    sourceItemUuid = null,
    sourceItem = null,
    preserveHiddenFlag = true,
    adapter = getActiveSystemAdapter()
  } = options;

  // System-specific ownership state is prepared by the active adapter. The
  // generic adapter only clones, preserving unknown system data verbatim.
  let prepared = sourceData;
  if (typeof adapter?.prepareItemForTransfer === "function") {
    prepared = adapter.prepareItemForTransfer(sourceData, {
      sourceItem,
      sourceItemUuid,
      destinationActor
    });
    if (!prepared || typeof prepared !== "object" || typeof prepared.then === "function") {
      throw new TypeError(
        "sanitizeItemForTransfer: adapter.prepareItemForTransfer must return item data synchronously"
      );
    }
  }

  // Clone again so even a poorly behaved adapter cannot make later core
  // transformations mutate the object it returned.
  const data = foundry.utils.deepClone(prepared);

  // 1. Generate destination _id (overwrites any existing one)
  data._id = generateItemId();
  const destinationItemUuid = buildItemUuid(destinationActor, data._id);

  // 2. Strip Quartermaster's transfer-only flags. System and third-party
  // fields are intentionally not interpreted here; that belongs to adapters.
  stripTransientCaches(data, { preserveHiddenFlag });

  // 3. Rewrite effect origins selectively
  if (Array.isArray(data.effects)) {
    data.effects = data.effects.map(effect =>
      rewriteEffectOrigin(effect, sourceItemUuid, destinationItemUuid)
    );
  }

  return data;
}

/**
 * Generate a fresh 16-character random ID using Foundry's utility.
 * Exposed so callers (the Claim-and-Commit machinery in step 8) can
 * pre-generate IDs for transaction log entries.
 */
export function generateItemId() {
  return foundry.utils.randomID(16);
}

/**
 * Build a world-actor item UUID from an actor reference and an item _id.
 *
 * @param {Actor} actor
 * @param {string} itemId
 * @returns {string}
 */
export function buildItemUuid(actor, itemId) {
  if (!actor?.id) {
    throw new TypeError("buildItemUuid: actor must have an id");
  }
  if (typeof itemId !== "string" || !itemId) {
    throw new TypeError("buildItemUuid: itemId must be a non-empty string");
  }
  // Synthetic Token Actors have scene/token-qualified UUIDs. Building from
  // actor.uuid preserves that scope; world actors retain `Actor.<id>`.
  const actorUuid = typeof actor.uuid === "string" && actor.uuid
    ? actor.uuid
    : `Actor.${actor.id}`;
  return `${actorUuid}.Item.${itemId}`;
}

// ============================================================
// Legacy owner-state facade
// ============================================================

/**
 * Retained for macros and legacy diagnostics. The active adapter owns the
 * transformation; generic systems receive a deep clone with opaque data
 * unchanged.
 */
export function stripOwnerSpecificState(data) {
  return getActiveSystemAdapter().prepareItemForTransfer(data, { legacyFacade: true });
}

// ============================================================
// Module cache stripping
// ============================================================

/**
 * Clear Quartermaster's own transfer-only namespace, except optionally
 * preserving the `hidden` flag for GM Loot Prep. Third-party flags are opaque
 * to core and may only be changed by a system adapter. Mutates the input.
 */
export function stripTransientCaches(data, { preserveHiddenFlag = true } = {}) {
  if (!data.flags || typeof data.flags !== "object") return data;

  // Our own namespace: clear everything except `hidden` (if preserve enabled)
  if (data.flags[MODULE_ID] && typeof data.flags[MODULE_ID] === "object") {
    const ourFlags = data.flags[MODULE_ID];
    if (preserveHiddenFlag && ourFlags[FLAGS.HIDDEN] !== undefined) {
      data.flags[MODULE_ID] = { [FLAGS.HIDDEN]: ourFlags[FLAGS.HIDDEN] };
    } else {
      delete data.flags[MODULE_ID];
    }
  }

  return data;
}

// ============================================================
// Effect origin rewriting
// ============================================================

/**
 * Rewrite the `origin` of a single Active Effect if it points to the
 * source item being transferred. Returns a new object; does not mutate
 * the input.
 *
 * Rewrite rules:
 *   - origin exactly equals sourceItemUuid           → destinationItemUuid
 *   - origin starts with sourceItemUuid + "." (sub-ref like
 *     ".ActiveEffect.X")                             → destinationItemUuid + suffix
 *   - all other origins (different actor, different item, empty, null)
 *                                                     → unchanged
 *
 * Effect _ids are also pre-generated if missing (matches the pattern
 * used for the item itself: predictable IDs throughout the structure).
 *
 * @param {Object} effect - The effect object (typically from item.toObject().effects[i])
 * @param {string|null} sourceItemUuid - Full UUID of the source item, or null
 * @param {string} destinationItemUuid - Full UUID of the destination item
 * @returns {Object} A new effect object with rewritten origin and ensured _id
 */
export function rewriteEffectOrigin(effect, sourceItemUuid, destinationItemUuid) {
  const e = foundry.utils.deepClone(effect);

  // Ensure the effect has an _id; if not, generate one
  if (!e._id) {
    e._id = foundry.utils.randomID(16);
  }

  // Only rewrite when we know what the source UUID is and the effect has an origin
  if (!sourceItemUuid || typeof e.origin !== "string" || e.origin.length === 0) {
    return e;
  }

  // Exact match: replace the whole origin
  if (e.origin === sourceItemUuid) {
    e.origin = destinationItemUuid;
    return e;
  }

  // Sub-reference match: replace the prefix, preserve the suffix
  // (e.g., "Actor.X.Item.Y.ActiveEffect.Z" with prefix "Actor.X.Item.Y")
  const prefixWithDot = sourceItemUuid + ".";
  if (e.origin.startsWith(prefixWithDot)) {
    e.origin = destinationItemUuid + e.origin.slice(sourceItemUuid.length);
    return e;
  }

  // Otherwise leave the origin alone — it points to something unrelated
  return e;
}

/**
 * Batch helper: rewrite all effects in an array. Convenience wrapper
 * around the singular form for callers that have the whole effect list.
 */
export function rewriteEffectOrigins(effects, sourceItemUuid, destinationItemUuid) {
  if (!Array.isArray(effects)) return [];
  return effects.map(e => rewriteEffectOrigin(e, sourceItemUuid, destinationItemUuid));
}
