/**
 * Quartermaster — Claim-and-Commit Transfer Engine
 *
 * Durable transaction pattern for item moves across actors. Writes
 * intent to the transaction log BEFORE mutating, then writes commit
 * (or failure) entries AFTER. If a crash or error interrupts the move
 * partway, the claim entry provides enough information to reconstruct
 * what happened.
 *
 * Two directions, intentionally asymmetric:
 *
 * EGRESS (bag → player):
 *   Order: delete from bag, then create on player.
 *   Rationale: the bag is the contended resource. Players race to claim
 *     the same item. Delete-first on the bag ensures atomic ownership:
 *     only one delete succeeds, the loser gets a clean error.
 *   Failure mode if step 4 (create) fails: item is gone from bag but
 *     not on player. The claim log entry holds the full item data so
 *     the GM can recreate the item on either side.
 *
 * INGRESS (player → bag):
 *   Order: create on bag, then delete from player.
 *   Rationale: the bag is the durable accumulator. Create-first ensures
 *     the bag has the item before the player loses theirs. If the
 *     delete fails, the item briefly duplicates and the GM can resolve
 *     manually.
 *   Failure mode if step 4 (delete) fails: item exists in both places.
 *     Detected by inspecting the player's inventory after the operation.
 *
 * Both directions:
 *   - Sanitization runs BEFORE the claim write. The destination _id is
 *     known up front so it can be embedded in the claim entry.
 *   - The claim entry is the recovery anchor. A scrub utility (step 11
 *     transaction log window) will surface orphaned claims for manual
 *     resolution.
 *
 * This module exposes the inner transfer logic. It does NOT acquire
 * mutexes, deduplicate by requestId, or validate request age — those
 * concerns belong to the Operation Coordinator (step 3), which will
 * wrap calls to these functions in step 9 when the dispatchers get
 * their real implementations.
 *
 * GM-only: writes to both actors require GM authority. Player clients
 * route through the socket pipeline (step 4) which forwards to the
 * active GM.
 */

import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { sanitizeItemForTransfer, buildItemUuid } from "./sanitization.js";
import * as TransactionLog from "./transaction-log.js";

export const LOG_TYPES = {
  EGRESS_CLAIM:  "transfer.egress.claim",
  EGRESS_COMMIT: "transfer.egress.commit",
  EGRESS_FAILED: "transfer.egress.failed",
  INGRESS_CLAIM:  "transfer.ingress.claim",
  INGRESS_COMMIT: "transfer.ingress.commit",
  INGRESS_FAILED: "transfer.ingress.failed"
};

// ============================================================
// Egress: bag → player
// ============================================================

/**
 * Execute a bag → player transfer.
 *
 * @param {Object} params
 * @param {Item} params.sourceItem - The item on the bag actor
 * @param {Actor} params.destActor - The receiving (player-owned) actor
 * @param {string} params.requestId - Unique ID for this transfer (caller-supplied)
 * @param {string} [params.userId] - Originating user (for log attribution)
 * @returns {Promise<Object>} Result describing what happened
 */
export async function performEgress({ sourceItem, destActor, requestId, userId = game.user?.id }) {
  validatePerformInputs("performEgress", { sourceItem, destActor, requestId });

  const sourceActor = sourceItem.parent;
  if (!sourceActor) {
    throw new Error(`${MODULE_TITLE} | performEgress: sourceItem has no parent actor`);
  }

  // Capture full item data BEFORE sanitization mutates anything. The
  // raw data goes into the claim entry for potential recovery.
  const rawData = sourceItem.toObject();

  // Sanitize, pre-generate destination _id
  const sanitized = sanitizeItemForTransfer(rawData, destActor, {
    sourceItemUuid: sourceItem.uuid
  });
  const destItemUuid = buildItemUuid(destActor, sanitized._id);

  // 1. Write claim entry FIRST — this is the recovery anchor.
  const claim = {
    type: LOG_TYPES.EGRESS_CLAIM,
    requestId,
    userId,
    sourceActorId: sourceActor.id,
    sourceActorName: sourceActor.name,
    sourceItemId: sourceItem.id,
    sourceItemUuid: sourceItem.uuid,
    sourceItemName: sourceItem.name,
    destActorId: destActor.id,
    destActorName: destActor.name,
    destItemId: sanitized._id,
    destItemUuid,
    itemData: rawData
  };
  await TransactionLog.writeEntry(claim);

  // 2. Delete from source (atomic ownership on the contended bag side)
  try {
    await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
  } catch (err) {
    await TransactionLog.writeEntry({
      type: LOG_TYPES.EGRESS_FAILED,
      requestId,
      userId,
      sourceActorName: sourceActor.name,
      sourceItemName: sourceItem.name,
      destActorName: destActor.name,
      stage: "delete",
      error: errToString(err)
    });
    return failureResult(requestId, "delete", err, { itemData: rawData });
  }

  // 3. Create on destination with keepId so the predicted UUID holds
  let created = null;
  try {
    const result = await destActor.createEmbeddedDocuments("Item", [sanitized], { keepId: true });
    created = Array.isArray(result) ? result[0] : result;
  } catch (err) {
    await TransactionLog.writeEntry({
      type: LOG_TYPES.EGRESS_FAILED,
      requestId,
      userId,
      sourceActorName: sourceActor.name,
      sourceItemName: sourceItem.name,
      destActorName: destActor.name,
      stage: "create",
      error: errToString(err),
      itemData: rawData,
      note: "Source delete already succeeded; item data preserved here for recovery."
    });
    return failureResult(requestId, "create", err, {
      itemData: rawData,
      recoveryAdvice: "Source item already deleted; recreate from itemData on either side."
    });
  }

  // 4. Commit
  const actualDestItemId = created?.id ?? sanitized._id;
  await TransactionLog.writeEntry({
    type: LOG_TYPES.EGRESS_COMMIT,
    requestId,
    userId,
    sourceActorName: sourceActor.name,
    sourceItemName: sourceItem.name,
    destActorName: destActor.name,
    actualDestItemId,
    matchesPredictedId: actualDestItemId === sanitized._id
  });

  return {
    success: true,
    direction: "egress",
    requestId,
    sourceItemId: sourceItem.id,
    destItemId: actualDestItemId,
    destItemUuid: buildItemUuid(destActor, actualDestItemId),
    sanitized
  };
}

// ============================================================
// Ingress: player → bag
// ============================================================

/**
 * Execute a player → bag transfer.
 *
 * @param {Object} params
 * @param {Item} params.sourceItem - The item on the player actor
 * @param {Actor} params.destActor - The receiving bag actor (backing actor)
 * @param {string} params.requestId
 * @param {string} [params.userId]
 * @returns {Promise<Object>}
 */
export async function performIngress({ sourceItem, destActor, requestId, userId = game.user?.id }) {
  validatePerformInputs("performIngress", { sourceItem, destActor, requestId });

  const sourceActor = sourceItem.parent;
  if (!sourceActor) {
    throw new Error(`${MODULE_TITLE} | performIngress: sourceItem has no parent actor`);
  }

  const rawData = sourceItem.toObject();

  const sanitized = sanitizeItemForTransfer(rawData, destActor, {
    sourceItemUuid: sourceItem.uuid
  });
  const destItemUuid = buildItemUuid(destActor, sanitized._id);

  // 1. Claim
  await TransactionLog.writeEntry({
    type: LOG_TYPES.INGRESS_CLAIM,
    requestId,
    userId,
    sourceActorId: sourceActor.id,
    sourceActorName: sourceActor.name,
    sourceItemId: sourceItem.id,
    sourceItemUuid: sourceItem.uuid,
    sourceItemName: sourceItem.name,
    destActorId: destActor.id,
    destActorName: destActor.name,
    destItemId: sanitized._id,
    destItemUuid,
    itemData: rawData
  });

  // 2. Create on destination FIRST (the bag accumulates safely before
  //    the player loses their copy)
  let created = null;
  try {
    const result = await destActor.createEmbeddedDocuments("Item", [sanitized], { keepId: true });
    created = Array.isArray(result) ? result[0] : result;
  } catch (err) {
    await TransactionLog.writeEntry({
      type: LOG_TYPES.INGRESS_FAILED,
      requestId,
      userId,
      sourceActorName: sourceActor.name,
      sourceItemName: sourceItem.name,
      destActorName: destActor.name,
      stage: "create",
      error: errToString(err)
    });
    return failureResult(requestId, "create", err, { itemData: rawData });
  }

  // 3. Delete from source (player side)
  try {
    await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
  } catch (err) {
    await TransactionLog.writeEntry({
      type: LOG_TYPES.INGRESS_FAILED,
      requestId,
      userId,
      sourceActorName: sourceActor.name,
      sourceItemName: sourceItem.name,
      destActorName: destActor.name,
      stage: "delete",
      error: errToString(err),
      destItemId: created?.id ?? sanitized._id,
      note: "Bag create already succeeded; player still holds the source. Manual reconciliation."
    });
    return failureResult(requestId, "delete", err, {
      destItemId: created?.id ?? sanitized._id,
      recoveryAdvice: "Item now exists on both bag and source; GM should delete one copy."
    });
  }

  // 4. Commit
  const actualDestItemId = created?.id ?? sanitized._id;
  await TransactionLog.writeEntry({
    type: LOG_TYPES.INGRESS_COMMIT,
    requestId,
    userId,
    sourceActorName: sourceActor.name,
    sourceItemName: sourceItem.name,
    destActorName: destActor.name,
    actualDestItemId,
    matchesPredictedId: actualDestItemId === sanitized._id
  });

  return {
    success: true,
    direction: "ingress",
    requestId,
    sourceItemId: sourceItem.id,
    destItemId: actualDestItemId,
    destItemUuid: buildItemUuid(destActor, actualDestItemId),
    sanitized
  };
}

// ============================================================
// Helpers
// ============================================================

function validatePerformInputs(label, { sourceItem, destActor, requestId }) {
  if (!sourceItem) {
    throw new TypeError(`${MODULE_TITLE} | ${label}: sourceItem required`);
  }
  if (!destActor?.id) {
    throw new TypeError(`${MODULE_TITLE} | ${label}: destActor with id required`);
  }
  if (typeof requestId !== "string" || !requestId) {
    throw new TypeError(`${MODULE_TITLE} | ${label}: requestId (non-empty string) required`);
  }
  if (!game.user?.isGM) {
    throw new Error(`${MODULE_TITLE} | ${label}: must be called by a GM client`);
  }
}

function errToString(err) {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function failureResult(requestId, stage, err, extras = {}) {
  return {
    success: false,
    requestId,
    stage,
    error: errToString(err),
    ...extras
  };
}

// ============================================================
// Diagnostic helpers
// ============================================================

/**
 * Look up the most recent transfer entries for a given requestId,
 * returning the claim, commit, and any failure rows together. Used by
 * test verifications and by the future transaction log window.
 *
 * @param {string} requestId
 * @returns {{ claim: Object|null, commit: Object|null, failures: Object[] }}
 */
export function getTransferTrace(requestId) {
  const all = TransactionLog.readAll();
  const matches = all.filter(e => e.requestId === requestId);
  const types = new Set(Object.values(LOG_TYPES));
  const transfer = matches.filter(e => types.has(e.type));

  const claim = transfer.find(e => e.type.endsWith(".claim")) ?? null;
  const commit = transfer.find(e => e.type.endsWith(".commit")) ?? null;
  const failures = transfer.filter(e => e.type.endsWith(".failed"));

  return { claim, commit, failures };
}
