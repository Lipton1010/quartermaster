/**
 * Quartermaster — Custom Resources (step 14)
 *
 * Counter-based party resources stored as a flag array on the backing
 * actor. Use cases: charges on shared magic items, mission tokens,
 * faction reputation, downtime activities, etc.
 *
 * Schema (one entry per resource):
 *   {
 *     id:          "qm-res-<random>",  // stable identifier
 *     name:        string,              // display name
 *     icon:        string,              // image path or FA class
 *     value:       number,              // current count (>= 0)
 *     max:         number | null,       // optional ceiling (null = unbounded)
 *     description: string,              // free-text note shown in tooltip
 *     createdAt:   number,              // timestamp ms
 *     order:       number               // display order (smaller first)
 *   }
 *
 * All mutations require GM. Players go through the socket pipeline,
 * which routes increments / decrements to the active GM and runs
 * `applyDelta` here.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";

export const DEFAULT_RESOURCE_ICON = "icons/svg/coins.svg";

// ============================================================
// Read
// ============================================================

/**
 * Get all resources from the backing actor's flag, sorted by `order`
 * then `createdAt`. Returns an empty array if the actor isn't ready.
 */
export function getResources() {
  const actor = getBackingActor();
  if (!actor) return [];
  const raw = actor.getFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES) ?? [];
  if (!Array.isArray(raw)) return [];
  // Sort by order ascending, then createdAt ascending
  return [...raw].sort((a, b) => {
    const oa = typeof a.order === "number" ? a.order : 0;
    const ob = typeof b.order === "number" ? b.order : 0;
    if (oa !== ob) return oa - ob;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

/**
 * Get a single resource by id, or null if not found.
 */
export function getResource(id) {
  if (!id) return null;
  return getResources().find(r => r.id === id) ?? null;
}

// ============================================================
// Write (GM only)
// ============================================================

/**
 * Create a new resource. GM only.
 *
 * @param {Object} input
 * @param {string} input.name - display name (required, non-empty after trim)
 * @param {string} [input.icon] - image path or FA class
 * @param {number} [input.value] - initial value (default 0)
 * @param {number|null} [input.max] - optional ceiling (default null = unbounded)
 * @param {string} [input.description]
 * @returns {Promise<Object|null>} the created resource, or null on failure
 */
export async function createResource(input) {
  if (!isActiveStorageGM()) {
    console.warn(`${MODULE_TITLE} | createResource: active GM only`);
    return null;
  }
  return withStorageLedgerLock(async () => {
    requireActiveStorageGM();
    return createResourceUnlocked(input);
  });
}

async function createResourceUnlocked(input) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | createResource: GM only`);
    return null;
  }
  const actor = getBackingActor();
  if (!actor) {
    console.warn(`${MODULE_TITLE} | createResource: no backing actor`);
    return null;
  }

  const name = (input?.name ?? "").toString().trim();
  if (!name) {
    console.warn(`${MODULE_TITLE} | createResource: name required`);
    return null;
  }

  const value = sanitizeValue(input?.value, 0);
  const max = sanitizeMax(input?.max);
  // If max is set and value > max, clamp value down to max
  const finalValue = (max != null && value > max) ? max : value;

  const list = getResources();
  const nextOrder = list.length > 0
    ? Math.max(...list.map(r => r.order ?? 0)) + 10
    : 10;

  const resource = {
    id: `qm-res-${foundry.utils.randomID()}`,
    name,
    icon: (input?.icon ?? "").toString().trim() || DEFAULT_RESOURCE_ICON,
    value: finalValue,
    max,
    description: (input?.description ?? "").toString().trim(),
    createdAt: Date.now(),
    order: nextOrder
  };

  await actor.setFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES, [...list, resource]);
  return resource;
}

/**
 * Update a resource by id. GM only.
 *
 * Accepts partial changes; only specified fields are modified. Numeric
 * value is clamped to [0, max] (or [0, ∞) if max is null). If the new
 * `max` is below the current `value`, value is clamped down.
 *
 * @param {string} id
 * @param {Object} changes
 * @returns {Promise<Object|null>} the updated resource, or null on failure
 */
export async function updateResource(id, changes) {
  if (!isActiveStorageGM()) {
    console.warn(`${MODULE_TITLE} | updateResource: active GM only`);
    return null;
  }
  return withStorageLedgerLock(async () => {
    requireActiveStorageGM();
    return updateResourceUnlocked(id, changes);
  });
}

async function updateResourceUnlocked(id, changes) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | updateResource: GM only`);
    return null;
  }
  const actor = getBackingActor();
  if (!actor) return null;

  const list = getResources();
  const idx = list.findIndex(r => r.id === id);
  if (idx < 0) return null;

  const current = list[idx];
  const next = { ...current };

  if (typeof changes.name === "string") {
    const name = changes.name.trim();
    if (name) next.name = name;
  }
  if (typeof changes.icon === "string") {
    next.icon = changes.icon.trim() || DEFAULT_RESOURCE_ICON;
  }
  if (typeof changes.description === "string") {
    next.description = changes.description.trim();
  }
  if (changes.max !== undefined) {
    next.max = sanitizeMax(changes.max);
  }
  if (changes.value !== undefined) {
    next.value = sanitizeValue(changes.value, current.value);
  }
  if (typeof changes.order === "number") {
    next.order = changes.order;
  }

  // Clamp value into [0, max]
  if (next.max != null && next.value > next.max) {
    next.value = next.max;
  }
  if (next.value < 0) next.value = 0;

  const updated = [...list];
  updated[idx] = next;
  await actor.setFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES, updated);
  return next;
}

/**
 * Delete a resource by id. GM only.
 *
 * @param {string} id
 * @returns {Promise<boolean>} true if a resource was removed
 */
export async function deleteResource(id) {
  if (!isActiveStorageGM()) {
    console.warn(`${MODULE_TITLE} | deleteResource: active GM only`);
    return false;
  }
  return withStorageLedgerLock(async () => {
    requireActiveStorageGM();
    return deleteResourceUnlocked(id);
  });
}

async function deleteResourceUnlocked(id) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | deleteResource: GM only`);
    return false;
  }
  const actor = getBackingActor();
  if (!actor) return false;

  const list = getResources();
  const filtered = list.filter(r => r.id !== id);
  if (filtered.length === list.length) return false;

  await actor.setFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES, filtered);
  return true;
}

// ============================================================
// Delta application (called from dispatcher)
// ============================================================

/**
 * Apply a signed delta to a resource. Validates bounds, returns
 * structured success/failure. Does NOT write transaction log entries;
 * the dispatcher in socket-handler.js handles that.
 *
 * @param {string} resourceId
 * @param {number} delta - signed; positive=add, negative=remove
 * @returns {Promise<Object>} result envelope
 */
export async function applyDelta(resourceId, delta) {
  if (!isActiveStorageGM()) {
    return { status: "failed", error: "active-gm-required" };
  }
  return withStorageLedgerLock(async () => {
    requireActiveStorageGM();
    return applyDeltaUnlocked(resourceId, delta);
  });
}

async function applyDeltaUnlocked(resourceId, delta) {
  if (!game.user.isGM) {
    return { status: "failed", error: "gm-only" };
  }
  const actor = getBackingActor();
  if (!actor) return { status: "failed", error: "no-backing-actor" };

  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return { status: "failed", error: "invalid-delta", delta };
  }

  const list = getResources();
  const idx = list.findIndex(r => r.id === resourceId);
  if (idx < 0) {
    return { status: "failed", error: "resource-not-found", resourceId };
  }

  const current = list[idx];
  const currentValue = current.value ?? 0;

  if (delta === 0) {
    return {
      status: "success",
      resultData: {
        resourceId,
        resourceName: current.name,
        delta: 0,
        previousValue: currentValue,
        newValue: currentValue,
        noop: true
      }
    };
  }

  const projected = currentValue + delta;

  if (projected < 0) {
    return {
      status: "failed",
      error: "insufficient-resource",
      resourceId,
      resourceName: current.name,
      currentValue,
      requested: Math.abs(delta)
    };
  }
  if (current.max != null && projected > current.max) {
    return {
      status: "failed",
      error: "max-exceeded",
      resourceId,
      resourceName: current.name,
      currentValue,
      max: current.max,
      requested: delta
    };
  }

  const updated = [...list];
  updated[idx] = { ...current, value: projected };
  await actor.setFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES, updated);

  return {
    status: "success",
    resultData: {
      resourceId,
      resourceName: current.name,
      delta,
      previousValue: currentValue,
      newValue: projected
    }
  };
}

// ============================================================
// Helpers
// ============================================================

function sanitizeValue(raw, fallback) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return typeof fallback === "number" ? fallback : 0;
  }
  return Math.max(0, Math.floor(raw));
}

function sanitizeMax(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw <= 0) return null;
  return Math.floor(raw);
}
import {
  isActiveStorageGM,
  requireActiveStorageGM,
  withStorageLedgerLock
} from "./storage-ledger.js";
