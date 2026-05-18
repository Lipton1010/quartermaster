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
 *   2. Strips owner-specific state (equipped, attuned, prepared) that
 *      doesn't make sense on the backing actor, and clears transient
 *      module caches (midi-qol runtime flags, dae caches) that could
 *      carry stale data from the source actor's context.
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
    preserveHiddenFlag = true
  } = options;

  // Clone first to avoid mutating the caller's data
  const data = foundry.utils.deepClone(sourceData);

  // 1. Generate destination _id (overwrites any existing one)
  data._id = generateItemId();
  const destinationItemUuid = buildItemUuid(destinationActor, data._id);

  // 2. Strip owner-specific state
  stripOwnerSpecificState(data);

  // 3. Strip transient module caches
  stripTransientCaches(data, { preserveHiddenFlag });

  // 4. Rewrite effect origins selectively
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
  return `Actor.${actor.id}.Item.${itemId}`;
}

// ============================================================
// Owner-specific state stripping
// ============================================================

/**
 * Reset fields whose meaning is tied to a specific owner: equipped,
 * attuned (current owner is attuned), prepared spells. Mutates the input
 * (called only on the deep-cloned working copy inside sanitize).
 *
 * Field handling:
 *   - system.equipped: true → false
 *   - system.attuned: true → false (dnd5e v5 boolean state; v3 also had this)
 *   - system.attunement: 2 → 1 (dnd5e v3 numeric: 0=none, 1=required, 2=attuned).
 *                       In v5+, attunement is a STRING describing the
 *                       requirement (`""`, `"optional"`, `"required"`), not
 *                       the state; this code path is a no-op on v5 data
 *                       and is preserved only for legacy v3 compat.
 *   - system.preparation.prepared: true → false
 *
 * Fields explicitly preserved:
 *   - quantity, weight, price, rarity, description
 *   - identified, unidentified.name
 *   - uses.value (current charges should persist)
 *   - damage, armor, range, properties
 *   - proficient (item-category dependent, not strictly owner-bound)
 */
export function stripOwnerSpecificState(data) {
  const sys = data.system;
  if (!sys || typeof sys !== "object") return data;

  // Equipped state
  if ("equipped" in sys) {
    sys.equipped = false;
  }

  // Legacy boolean attunement field
  if ("attuned" in sys) {
    sys.attuned = false;
  }

  // Modern numeric attunement: 0 = none, 1 = required, 2 = attuned-by-owner
  // We want to reset "attuned by current owner" back to "required" since
  // the destination will need to attune itself
  if (typeof sys.attunement === "number" && sys.attunement === 2) {
    sys.attunement = 1;
  }

  // Prepared spell state
  if (sys.preparation && typeof sys.preparation === "object") {
    if ("prepared" in sys.preparation) {
      sys.preparation.prepared = false;
    }
  }

  return data;
}

// ============================================================
// Module cache stripping
// ============================================================

/**
 * Remove runtime caches from third-party modules and clear our own flag
 * namespace (except optionally preserving the `hidden` flag for GM Loot
 * Prep). Mutates the input.
 */
export function stripTransientCaches(data, { preserveHiddenFlag = true } = {}) {
  if (!data.flags || typeof data.flags !== "object") return data;

  // midi-qol runtime cache
  if (data.flags["midi-qol"] && typeof data.flags["midi-qol"] === "object") {
    const midi = data.flags["midi-qol"];
    // These keys store transient roll/decision data
    delete midi.advantage;
    delete midi.disadvantage;
    delete midi.lastSelectedTokenIds;
    delete midi.macroCalls;
    delete midi.cached;
    // If the namespace ends up empty, drop it entirely
    if (Object.keys(midi).length === 0) {
      delete data.flags["midi-qol"];
    }
  }

  // Dynamic Active Effects (dae) cached state
  if (data.flags.dae && typeof data.flags.dae === "object") {
    delete data.flags.dae.cached;
    if (Object.keys(data.flags.dae).length === 0) {
      delete data.flags.dae;
    }
  }

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
