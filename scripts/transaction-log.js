/**
 * Quartermaster — Transaction Log
 *
 * Read/write/search interface for the backing actor's transaction log.
 * Stored at `actor.flags.quartermaster.transactionLog` as an append-mostly
 * array.
 *
 * For step 3 (build sequence), this module provides:
 *   - findByRequestId: idempotency lookup, scans recent N entries
 *   - writeEntry:      append a new entry, enforces the configured cap
 *
 * Filtering, export, undo, and pagination are deferred to later build steps.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS, SETTINGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";

/**
 * How many entries from the tail of the log to scan when looking up a
 * requestId. Tradeoff: larger window catches older replays but costs more.
 * 50 is plenty given typical session activity.
 */
const LOG_LOOKUP_HORIZON = 50;

/**
 * Find a transaction log entry by requestId. Used by the coordinator for
 * the durable layer of idempotency checking.
 *
 * Returns the matching entry, or null if not found within the lookup horizon.
 *
 * @param {string} requestId
 * @returns {Object|null}
 */
export function findByRequestId(requestId) {
  if (!requestId) return null;

  const actor = getBackingActor();
  if (!actor) return null;

  const log = actor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG) ?? [];
  const horizon = log.slice(-LOG_LOOKUP_HORIZON);

  // Scan tail-first because recent matches are more likely
  for (let i = horizon.length - 1; i >= 0; i--) {
    if (horizon[i].requestId === requestId) {
      return horizon[i];
    }
  }
  return null;
}

/**
 * Append an entry to the transaction log. Enforces the configured cap by
 * trimming from the head when exceeded.
 *
 * GM-only; players should never reach this code path because all writes
 * route through the GM-side coordinator.
 *
 * @param {Object} entry  partial entry; id and timestamp auto-filled
 * @returns {Promise<Object|null>}  the full written entry, or null on no-op
 */
export async function writeEntry(entry) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | transaction-log.writeEntry called by non-GM; ignoring`);
    return null;
  }

  const actor = getBackingActor();
  if (!actor) {
    console.warn(`${MODULE_TITLE} | transaction-log.writeEntry called with no backing actor; ignoring`);
    return null;
  }

  const cap = game.settings.get(MODULE_ID, SETTINGS.TRANSACTION_LOG_CAP);
  const currentLog = actor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG) ?? [];

  const fullEntry = {
    id: foundry.utils.randomID(),
    timestamp: Date.now(),
    ...entry
  };

  let newLog = [...currentLog, fullEntry];
  if (cap > 0 && newLog.length > cap) {
    newLog = newLog.slice(-cap);
  }

  await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, newLog);
  return fullEntry;
}

/**
 * Read the full transaction log array. Used by future log UI and diagnostics.
 *
 * @returns {Object[]}
 */
export function readAll() {
  const actor = getBackingActor();
  if (!actor) return [];
  return [...(actor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG) ?? [])];
}

/**
 * Diagnostic: how many entries are currently in the log.
 */
export function count() {
  const actor = getBackingActor();
  if (!actor) return 0;
  return (actor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG) ?? []).length;
}

/**
 * Update an existing transaction log entry, merging in new fields. Used
 * by the Claim-and-Commit pipeline to transition a CLAIMED entry to
 * COMMITTED, FAILED, or ABORTED.
 *
 * The merge is shallow (top-level fields). If the requestId is not found
 * within the lookup horizon, returns null without writing.
 *
 * GM-only.
 *
 * @param {string} requestId
 * @param {Object} updates  fields to merge into the matching entry
 * @returns {Promise<Object|null>}  the updated entry, or null on no-op
 */
export async function updateEntry(requestId, updates) {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | transaction-log.updateEntry called by non-GM; ignoring`);
    return null;
  }
  if (!requestId) return null;

  const actor = getBackingActor();
  if (!actor) {
    console.warn(`${MODULE_TITLE} | transaction-log.updateEntry called with no backing actor; ignoring`);
    return null;
  }

  const log = actor.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG) ?? [];

  // Find the index of the matching entry, scanning tail-first
  let foundIndex = -1;
  const startIndex = Math.max(0, log.length - LOG_LOOKUP_HORIZON);
  for (let i = log.length - 1; i >= startIndex; i--) {
    if (log[i].requestId === requestId) {
      foundIndex = i;
      break;
    }
  }
  if (foundIndex === -1) {
    return null;
  }

  const merged = { ...log[foundIndex], ...updates };
  const newLog = [...log];
  newLog[foundIndex] = merged;

  await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, newLog);
  return merged;
}

/**
 * GM-only: clear all log entries. Used by the future log UI's Clear button
 * and by step 3 verification cleanup.
 */
export async function clear() {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | transaction-log.clear called by non-GM; ignoring`);
    return false;
  }
  const actor = getBackingActor();
  if (!actor) return false;
  await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, []);
  return true;
}
