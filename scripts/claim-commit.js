/**
 * Quartermaster — Claim-and-Commit Transfer Engine
 *
 * Durable transaction pattern for item moves across actors. Writes
 * intent to the transaction log BEFORE mutating, then writes commit
 * (or failure) entries AFTER. If a crash or error interrupts the move
 * partway, the claim entry provides enough information to reconstruct
 * what happened.
 *
 * Both directions use create-first semantics. The source is never removed
 * until the destination has accepted a sanitized copy. If source deletion
 * then fails, the destination copy is deleted as compensation; a private
 * recovery record is written only if that compensation also fails.
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

import { MODULE_TITLE } from "./constants.js";
import { sanitizeItemForTransfer, buildItemUuid } from "./sanitization.js";
import * as TransactionLog from "./transaction-log.js";
import { isActiveStorageGM, requireActiveStorageGM } from "./storage-ledger.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";

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
  if (!isActiveStorageGM()) return { status: "failed", requestId, error: "active-gm-only" };
  return performTransfer({
    direction: "egress",
    sourceItem,
    destActor,
    requestId,
    userId,
    claimType: LOG_TYPES.EGRESS_CLAIM,
    commitType: LOG_TYPES.EGRESS_COMMIT,
    failedType: LOG_TYPES.EGRESS_FAILED
  });
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
  if (!isActiveStorageGM()) return { status: "failed", requestId, error: "active-gm-only" };
  return performTransfer({
    direction: "ingress",
    sourceItem,
    destActor,
    requestId,
    userId,
    claimType: LOG_TYPES.INGRESS_CLAIM,
    commitType: LOG_TYPES.INGRESS_COMMIT,
    failedType: LOG_TYPES.INGRESS_FAILED
  });
}

async function performTransfer({
  direction,
  sourceItem,
  destActor,
  requestId,
  userId,
  claimType,
  commitType,
  failedType
}) {
  if (!isActiveStorageGM()) return { status: "failed", requestId, error: "active-gm-only" };
  validatePerformInputs(`perform${direction === "egress" ? "Egress" : "Ingress"}`, {
    sourceItem,
    destActor,
    requestId
  });

  const sourceActor = sourceItem.parent;
  if (!sourceActor) {
    throw new Error(`${MODULE_TITLE} | transfer: sourceItem has no parent actor`);
  }

  const rawData = sourceItem.toObject();
  const adapter = getActiveSystemAdapter();

  try {
    if (typeof adapter?.canReceiveItem === "function"
        && !adapter.canReceiveItem(sourceItem, destActor)) {
      return failureResult(requestId, "preflight", "incompatible-destination-item");
    }
  } catch (err) {
    return failureResult(requestId, "preflight", err, {
      errorCode: "adapter-preflight-failed"
    });
  }

  let sanitized;
  try {
    sanitized = sanitizeItemForTransfer(rawData, destActor, {
      sourceItem,
      sourceItemUuid: sourceItem.uuid,
      preserveHiddenFlag: false,
      adapter
    });
  } catch (err) {
    return failureResult(requestId, "preflight", err);
  }
  const predictedDestItemUuid = buildItemUuid(destActor, sanitized._id);
  let itemQuantity = null;
  try {
    const normalized = adapter.normalizeItem(sourceItem);
    if (Number.isFinite(normalized?.quantity)) itemQuantity = normalized.quantity;
  } catch { /* metadata is optional; transfer safety does not depend on it */ }

  // The canonical claim is written before mutation. Private-storage builds
  // keep the full snapshot GM-only and project only a redacted public entry.
  const claimEntry = await TransactionLog.writeEntry({
    type: claimType,
    requestId,
    userId,
    sourceActorId: sourceActor.id,
    sourceActorUuid: sourceActor.uuid ?? null,
    sourceActorName: sourceActor.name,
    sourceItemId: sourceItem.id,
    sourceItemUuid: sourceItem.uuid,
    sourceItemName: sourceItem.name,
    itemQuantity,
    destActorId: destActor.id,
    destActorUuid: destActor.uuid ?? null,
    destActorName: destActor.name,
    destItemId: sanitized._id,
    destItemUuid: predictedDestItemUuid,
    itemData: rawData
  });
  if (!claimEntry) {
    return failureResult(requestId, "claim", "claim-log-unavailable", {
      sourcePreserved: true
    });
  }

  // Create first for both directions so a destination failure never removes
  // the source. The operation coordinator serializes on source UUID.
  let created;
  try {
    requireActiveStorageGM();
    const result = await destActor.createEmbeddedDocuments("Item", [sanitized], { keepId: true });
    created = Array.isArray(result) ? result[0] : result;
    created ??= destActor.items?.get?.(sanitized._id) ?? null;
    if (!created) throw new Error("destination-create-returned-empty");
  } catch (err) {
    await writeFailure({
      failedType,
      requestId,
      userId,
      sourceActor,
      sourceItem,
      destActor,
      stage: "create",
      error: err
    });
    await releaseTerminalSnapshot(requestId);
    return failureResult(requestId, "create", err, {
      sourcePreserved: true
    });
  }

  const actualDestItemId = created.id ?? sanitized._id;
  let deleteWarning = null;
  try {
    requireActiveStorageGM();
    await sourceActor.deleteEmbeddedDocuments("Item", [sourceItem.id]);
    if (sourceActor.items?.get?.(sourceItem.id)) {
      throw new Error("source-delete-did-not-remove-item");
    }
  } catch (deleteError) {
    const canInspectSource = typeof sourceActor.items?.get === "function";
    const sourceStillExists = canInspectSource
      ? Boolean(sourceActor.items.get(sourceItem.id))
      : null;

    // A Foundry hook can throw after the embedded collection has already been
    // updated. In that case the move itself completed; compensating would
    // delete the only remaining copy.
    if (canInspectSource && !sourceStillExists) {
      deleteWarning = errToString(deleteError);
      console.warn(
        `${MODULE_TITLE} | source delete reported an error after removal; preserving destination`,
        deleteError
      );
    } else {
      const compensation = await compensateDestinationItem(destActor, actualDestItemId);
      const recoveryRecorded = compensation.success
        ? false
        : await writePrivateRecovery({
            direction,
            requestId,
            userId,
            sourceActor,
            sourceItem,
            destActor,
            destItemId: actualDestItemId,
            rawData,
            sanitized,
            deleteError,
            compensationError: compensation.error
          });

      await writeFailure({
        failedType,
        requestId,
        userId,
        sourceActor,
        sourceItem,
        destActor,
        stage: compensation.success ? "delete-compensated" : "compensation",
        error: deleteError,
        extras: {
          destItemId: actualDestItemId,
          compensated: compensation.success,
          compensationError: compensation.error ? errToString(compensation.error) : null,
          recoveryRecorded
        }
      });

      // If automatic compensation failed, only release the claim snapshot
      // after the private recovery record was durably written. Otherwise the
      // canonical claim remains the recovery source.
      if (compensation.success || recoveryRecorded) {
        await releaseTerminalSnapshot(requestId);
      }

      return failureResult(requestId, "delete", deleteError, {
        destItemId: actualDestItemId,
        compensated: compensation.success,
        compensationError: compensation.error ? errToString(compensation.error) : null,
        recoveryRecorded,
        sourcePreserved: sourceStillExists,
        recoveryAdvice: compensation.success
          ? "Destination copy removed; source item was preserved."
          : "Item may exist on both actors; a GM must reconcile the private recovery record."
      });
    }
  }

  let finalizationWarning = null;
  let finalizationRecoveryRecorded = false;
  try {
    const commitEntry = await TransactionLog.writeEntry({
      type: commitType,
      requestId,
      userId,
      sourceActorName: sourceActor.name,
      sourceActorUuid: sourceActor.uuid ?? null,
      sourceItemName: sourceItem.name,
      destActorName: destActor.name,
      destActorUuid: destActor.uuid ?? null,
      actualDestItemId,
      actualDestItemUuid: buildItemUuid(destActor, actualDestItemId),
      matchesPredictedId: actualDestItemId === sanitized._id,
      deleteWarning
    });
    if (!commitEntry) throw new Error("commit-log-unavailable");
  } catch (commitError) {
    // The document move is already complete. Never report it as failed and
    // invite a duplicate retry merely because audit finalization failed.
    finalizationWarning = errToString(commitError);
    finalizationRecoveryRecorded = await writePrivateRecovery({
      type: "transfer.finalization-failed",
      status: "move-complete-audit-incomplete",
      direction,
      requestId,
      userId,
      sourceActor,
      sourceItem,
      destActor,
      destItemId: actualDestItemId,
      rawData,
      sanitized,
      finalizationError: commitError
    });
    console.error(`${MODULE_TITLE} | transfer completed but commit logging failed`, commitError);
  }
  const snapshotReleased = await releaseTerminalSnapshot(requestId);
  if (!snapshotReleased && !finalizationWarning) {
    finalizationWarning = "terminal-snapshot-release-failed";
  }

  return {
    success: true,
    direction,
    requestId,
    sourceItemId: sourceItem.id,
    sourceItemUuid: sourceItem.uuid,
    destItemId: actualDestItemId,
    destItemUuid: buildItemUuid(destActor, actualDestItemId),
    deleteWarning,
    finalizationWarning,
    finalizationRecoveryRecorded
  };
}

// ============================================================
// Helpers
// ============================================================

export async function compensateDestinationItem(destActor, destItemId) {
  try {
    requireActiveStorageGM();
    await destActor.deleteEmbeddedDocuments("Item", [destItemId]);
    if (destActor.items?.get?.(destItemId)) {
      throw new Error("compensation-delete-did-not-remove-item");
    }
    return { success: true, error: null };
  } catch (error) {
    if (typeof destActor.items?.get === "function" && !destActor.items.get(destItemId)) {
      console.warn(
        `${MODULE_TITLE} | compensation delete reported an error after removal`,
        error
      );
      return { success: true, error: null, warning: errToString(error) };
    }
    console.error(
      `${MODULE_TITLE} | destination compensation failed for ${destItemId}`,
      error
    );
    return { success: false, error };
  }
}

async function writeFailure({
  failedType,
  requestId,
  userId,
  sourceActor,
  sourceItem,
  destActor,
  stage,
  error,
  extras = {}
}) {
  await TransactionLog.writeEntry({
    type: failedType,
    requestId,
    userId,
    sourceActorName: sourceActor.name,
    sourceActorUuid: sourceActor.uuid ?? null,
    sourceItemName: sourceItem.name,
    sourceItemUuid: sourceItem.uuid ?? null,
    destActorName: destActor.name,
    destActorUuid: destActor.uuid ?? null,
    stage,
    error: errToString(error),
    ...extras
  });
}

/**
 * Persist full recovery material only when automatic compensation fails.
 * The helper is loaded lazily so transfer safety still works during startup
 * recovery or if private storage could not be initialized.
 */
async function writePrivateRecovery(record) {
  try {
    const recovery = await import("./recovery-records.js");
    if (typeof recovery.writeRecoveryRecord !== "function") return false;
    const written = await recovery.writeRecoveryRecord({
      type: "transfer.compensation-failed",
      status: "needs-reconciliation",
      timestamp: Date.now(),
      ...record,
      sourceActor: {
        id: record.sourceActor?.id ?? null,
        uuid: record.sourceActor?.uuid ?? null,
        name: record.sourceActor?.name ?? null
      },
      sourceItem: {
        id: record.sourceItem?.id ?? null,
        uuid: record.sourceItem?.uuid ?? null,
        name: record.sourceItem?.name ?? null
      },
      destActor: {
        id: record.destActor?.id ?? null,
        uuid: record.destActor?.uuid ?? null,
        name: record.destActor?.name ?? null
      },
      ...(record.deleteError ? { deleteError: errToString(record.deleteError) } : {}),
      ...(record.compensationError
        ? { compensationError: errToString(record.compensationError) }
        : {}),
      ...(record.finalizationError
        ? { finalizationError: errToString(record.finalizationError) }
        : {})
    });
    return Boolean(written);
  } catch (err) {
    console.error(`${MODULE_TITLE} | could not write private recovery record`, err);
    return false;
  }
}

async function releaseTerminalSnapshot(requestId) {
  try {
    await TransactionLog.releaseItemSnapshot(requestId);
    return true;
  } catch (err) {
    // Snapshot retention is safer than changing an already terminal transfer
    // result. A later maintenance pass can release it.
    console.warn(`${MODULE_TITLE} | could not release terminal Item snapshot`, err);
    return false;
  }
}

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
  if (!isActiveStorageGM()) {
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
