/**
 * Quartermaster — Socket Handler
 *
 * Implements the GM-side relay for player-initiated write operations.
 *
 * Background: players have OBSERVER permission on the backing actor; they
 * cannot write directly. They build a payload describing their intent and
 * submit it through this module. The payload routes to the active GM's
 * client, which validates identity from the connection context, dispatches
 * through the operation coordinator, and returns a result envelope.
 *
 * Transport mechanisms:
 *   - Primary:  CONFIG.queries (Foundry V13+; built-in request/response with
 *               authoritative sender identity)
 *   - Fallback: raw game.socket.emit with manual correlation (older clients)
 *
 * For step 4, the per-operation-type fn bodies are placeholder stubs that
 * return `{ status: "success", resultData: { notImplemented: true, ... } }`.
 * They exercise the dispatch pipeline (validation, coordinator routing,
 * mutex acquisition, idempotency, transaction logging) without yet
 * performing real item/currency mutations. Real implementations land in
 * steps 7 through 13.
 */

import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { executeOperation } from "./operation-coordinator.js";
import { needsApproval } from "./approval-policy.js";
import { promptCurrencyApproval } from "./approval-dialog.js";
import { getCurrency, applyCurrencyDelta } from "./currencies.js";

const QUERY_NAME = "quartermaster.processRequest";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const PAYLOAD_TYPES = {
  ITEM_TRANSFER: "quartermaster.itemTransfer",
  CURRENCY_CHANGE: "quartermaster.currencyChange",
  CUSTOM_RESOURCE_CHANGE: "quartermaster.customResourceChange",
  REQUEST_RESULT: "quartermaster.requestResult"
};

let _registered = false;
let _queryRegistered = false;
let _pendingResults = new Map();  // requestId -> { resolve, reject, timeout }

// ============================================================
// Registration
// ============================================================

/**
 * Register the socket and query handlers. Called once during init.
 * Idempotent on repeat calls.
 */
export function registerSocketHandler() {
  if (_registered) return;
  _registered = true;

  registerQueryHandler();
  registerSocketListener();

  console.log(
    `${MODULE_TITLE} | Socket handler registered ` +
    `(query: ${_queryRegistered ? "yes" : "no"}, socket: yes)`
  );
}

function registerQueryHandler() {
  if (typeof CONFIG !== "object" || !CONFIG.queries) {
    console.warn(
      `${MODULE_TITLE} | CONFIG.queries not available; ` +
      `falling back to raw socket only`
    );
    return;
  }
  CONFIG.queries[QUERY_NAME] = async (data, options = {}) => {
    // options.userId is the authoritative sender ID from Foundry's
    // query framework. Falls back to game.user.id if unavailable
    // (shouldn't happen in practice).
    const senderUserId = options.userId ?? game.user.id;
    return await dispatchPayload(data, senderUserId);
  };
  _queryRegistered = true;
}

function registerSocketListener() {
  game.socket.on(SOCKET_CHANNEL, handleRawSocketMessage);
}

// ============================================================
// Receive side: raw socket fallback path
// ============================================================

/**
 * Handle a raw socket message (used when CONFIG.queries is unavailable
 * or for the REQUEST_RESULT correlation path).
 */
async function handleRawSocketMessage(payload) {
  if (!payload || typeof payload !== "object") return;

  // Result correlation: the active GM has broadcast a result for a
  // pending request we initiated.
  if (payload.type === PAYLOAD_TYPES.REQUEST_RESULT) {
    handleIncomingResult(payload);
    return;
  }

  // Request path: only the active GM processes
  if (!isActiveGM()) return;

  // Raw socket doesn't give us authoritative sender identity; we trust
  // payload.userId here. The CONFIG.queries path is preferred precisely
  // because it provides authoritative identity.
  const senderUserId = payload.userId;
  const result = await dispatchPayload(payload, senderUserId);

  // Broadcast result back; the originator will correlate by requestId
  game.socket.emit(SOCKET_CHANNEL, {
    type: PAYLOAD_TYPES.REQUEST_RESULT,
    requestId: payload.requestId,
    targetUserId: senderUserId,
    result
  });
}

function handleIncomingResult(message) {
  // Only relevant if WE were the originator awaiting this result
  if (message.targetUserId && message.targetUserId !== game.user.id) return;

  const pending = _pendingResults.get(message.requestId);
  if (!pending) return;

  clearTimeout(pending.timeout);
  _pendingResults.delete(message.requestId);
  pending.resolve(message.result);
}

// ============================================================
// Send side
// ============================================================

/**
 * Submit a request payload. Routes appropriately based on whether the
 * current user is the active GM or a player.
 *
 *   - Active GM:    dispatches locally (no network round-trip)
 *   - Other client: queries the active GM via CONFIG.queries, with raw
 *                   socket fallback if queries are unavailable
 *
 * @param {Object} payload  full payload object including type, requestId, etc.
 * @returns {Promise<Object>}  result envelope
 */
export async function submitRequest(payload) {
  if (!payload || typeof payload !== "object") {
    return { status: "failed", error: "malformed-payload" };
  }

  // Auto-populate timestamp if missing
  if (!payload.timestamp) payload.timestamp = Date.now();

  // Auto-populate userId if missing (informational only; ignored on receive)
  if (!payload.userId) payload.userId = game.user.id;

  const activeGM = game.users.activeGM;
  if (!activeGM) {
    return { status: "failed", error: "no-active-gm" };
  }

  // Local dispatch path: we ARE the active GM
  if (activeGM.id === game.user.id) {
    return await dispatchPayload(payload, game.user.id);
  }

  // Remote query path
  if (_queryRegistered && typeof activeGM.query === "function") {
    try {
      return await activeGM.query(QUERY_NAME, payload);
    } catch (err) {
      console.error(`${MODULE_TITLE} | Query to active GM failed`, err);
      return { status: "failed", error: `query-failed: ${err?.message ?? err}` };
    }
  }

  // Raw socket fallback (await result via correlation)
  return await sendViaRawSocket(payload);
}

function sendViaRawSocket(payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      _pendingResults.delete(payload.requestId);
      resolve({ status: "failed", error: "socket-timeout" });
    }, timeoutMs);

    _pendingResults.set(payload.requestId, { resolve, reject, timeout });
    game.socket.emit(SOCKET_CHANNEL, payload);
  });
}

// ============================================================
// Dispatch (the heart of the pipeline)
// ============================================================

/**
 * Type-based dispatch of an incoming payload. Validates shape, derives
 * resource keys, hands off to the operation coordinator with a per-type
 * stub fn (for step 4) or real implementation (steps 7+).
 *
 * @param {Object} payload
 * @param {string} senderUserId  authoritative sender, NOT payload.userId
 * @returns {Promise<Object>}    result envelope
 */
async function dispatchPayload(payload, senderUserId) {
  if (!payload || typeof payload !== "object") {
    return { status: "failed", error: "malformed-payload" };
  }

  // Identity cross-check: warn if payload userId disagrees with the
  // authoritative connection context value.
  if (payload.userId && payload.userId !== senderUserId) {
    console.warn(
      `${MODULE_TITLE} | Socket userId mismatch: payload claims ` +
      `"${payload.userId}", Foundry says "${senderUserId}"; using authoritative value`
    );
  }

  const sender = game.users.get(senderUserId);
  if (!sender) {
    return { status: "failed", error: "unknown-sender" };
  }

  switch (payload.type) {
    case PAYLOAD_TYPES.ITEM_TRANSFER:
      return await dispatchItemTransfer(payload, senderUserId);
    case PAYLOAD_TYPES.CURRENCY_CHANGE:
      return await dispatchCurrencyChange(payload, senderUserId);
    case PAYLOAD_TYPES.CUSTOM_RESOURCE_CHANGE:
      return await dispatchCustomResourceChange(payload, senderUserId);
    default:
      return { status: "failed", error: "unknown-payload-type", receivedType: payload.type };
  }
}

async function dispatchItemTransfer(envelope, senderUserId) {
  const { requestId, action, payload, timestamp } = envelope;

  if (!requestId) return { status: "failed", error: "missing-request-id" };
  if (!action) return { status: "failed", error: "missing-action" };
  if (!payload) return { status: "failed", error: "missing-payload" };
  // Accept either the legacy `itemId` field (from step 4 stub tests) or
  // the step 9 `sourceItemId`/`sourceItemUuid` fields. Validation error
  // code preserved as `missing-item-id` for back-compat with existing tests.
  const hasItemRef = payload.sourceItemId || payload.sourceItemUuid || payload.itemId;
  if (!hasItemRef) {
    return { status: "failed", error: "missing-item-id" };
  }

  // Resource keys: the item itself, plus any actors involved
  const itemKey = payload.sourceItemId ?? payload.itemId ?? "unknown";
  const resourceKeys = [`item:${itemKey}`];
  if (payload.destActorId) resourceKeys.push(`actor:${payload.destActorId}`);
  if (payload.sourceActorId) resourceKeys.push(`actor:${payload.sourceActorId}`);
  if (payload.targetActorId) resourceKeys.push(`actor:${payload.targetActorId}`);

  return await executeOperation({
    resourceKeys,
    requestId,
    operationType: `itemTransfer:${action}`,
    requester: senderUserId,
    timestamp,
    fn: async () => stubItemTransfer(action, payload, { requestId, userId: senderUserId })
  });
}

async function dispatchCurrencyChange(envelope, senderUserId) {
  const { requestId, payload, timestamp } = envelope;

  if (!requestId) return { status: "failed", error: "missing-request-id" };
  if (!payload || !payload.currencyType) {
    return { status: "failed", error: "missing-currency-type" };
  }
  if (typeof payload.delta !== "number") {
    return { status: "failed", error: "invalid-delta" };
  }

  // Custom balances share one flag object, so serialize all currency writes.
  const resourceKeys = ["currency-ledger"];

  return await executeOperation({
    resourceKeys,
    requestId,
    operationType: "currencyChange",
    requester: senderUserId,
    timestamp,
    fn: async () => stubCurrencyChange(payload, { requestId, userId: senderUserId })
  });
}

async function dispatchCustomResourceChange(envelope, senderUserId) {
  const { requestId, payload, timestamp } = envelope;

  if (!requestId) return { status: "failed", error: "missing-request-id" };
  if (!payload || !payload.resourceId) {
    return { status: "failed", error: "missing-resource-id" };
  }
  if (typeof payload.delta !== "number") {
    return { status: "failed", error: "invalid-delta" };
  }

  const resourceKeys = [`customResource:${payload.resourceId}`];

  return await executeOperation({
    resourceKeys,
    requestId,
    operationType: "customResourceChange",
    requester: senderUserId,
    timestamp,
    fn: async () => stubCustomResourceChange(payload, { requestId, userId: senderUserId })
  });
}

// ============================================================
// Step 4 stub implementations
// ============================================================
// These return placeholder success envelopes so the dispatch pipeline can be
// verified end-to-end. Steps 7 through 13 will replace these with real
// Claim-and-Commit, currency mutation, and custom resource logic.

async function stubItemTransfer(action, data, context) {
  // Step 9: replaced with real implementation. Routes to performIngress
  // or performEgress based on action. Returns the result envelope.
  return await realItemTransfer(action, data, context);
}

/**
 * Real item transfer implementation (step 9). Resolves source/destination
 * documents, calls the Claim-and-Commit engine, returns a result envelope
 * shaped to match the socket protocol.
 *
 * @param {string} action  "ingress" or "egress"
 * @param {Object} data    payload from the request envelope
 * @param {Object} context { requestId, userId } from the dispatcher
 * @returns {Promise<Object>}
 */
async function realItemTransfer(action, data, context) {
  const { sourceActorId, sourceItemId, sourceItemUuid, destActorId } = data;
  const { requestId, userId } = context ?? {};

  // Dynamic import to avoid circular dependencies (claim-commit imports
  // transaction-log, which doesn't import socket-handler, but we want to
  // keep the dependency graph clean)
  const { performIngress, performEgress } = await import("./claim-commit.js");

  // Resolve actors
  const sourceActor = game.actors.get(sourceActorId);
  if (!sourceActor) {
    return { status: "failed", error: "source-actor-not-found", sourceActorId };
  }
  const destActor = game.actors.get(destActorId);
  if (!destActor) {
    return { status: "failed", error: "destination-actor-not-found", destActorId };
  }

  // Resolve source item: prefer by-id on the parent actor (fast and
  // guarantees the actor relationship), fall back to UUID
  let sourceItem = sourceItemId ? sourceActor.items.get(sourceItemId) : null;
  if (!sourceItem && sourceItemUuid) {
    sourceItem = await fromUuid(sourceItemUuid);
  }
  if (!sourceItem) {
    return {
      status: "failed",
      error: "source-item-not-found",
      sourceItemId,
      sourceItemUuid
    };
  }

  // Sanity: item is actually on the named source actor (could be stale UUID)
  if (sourceItem.parent?.id !== sourceActor.id) {
    return {
      status: "failed",
      error: "source-item-not-on-source-actor",
      sourceItemActualParent: sourceItem.parent?.id ?? null
    };
  }

  try {
    let result;
    if (action === "ingress") {
      result = await performIngress({ sourceItem, destActor, requestId, userId });
    } else if (action === "egress") {
      result = await performEgress({ sourceItem, destActor, requestId, userId });
    } else {
      return { status: "failed", error: "unknown-action", action };
    }

    if (result?.success) {
      return { status: "success", resultData: result };
    }
    return {
      status: "failed",
      error: result?.error ?? "transfer-failed",
      stage: result?.stage,
      details: result
    };
  } catch (err) {
    console.error(`${MODULE_TITLE} | realItemTransfer threw`, err);
    return { status: "failed", error: err?.message ?? "transfer-exception" };
  }
}

async function stubCurrencyChange(data, context) {
  // Step 10: replaced with real implementation
  return await realCurrencyChange(data, context);
}

/**
 * Real currency change implementation (step 10). Validates the request,
 * checks for negative-balance, writes claim/commit transaction log
 * entries, and updates the backing actor's `system.currency.<type>`.
 *
 * Step 13 added the approval gate: player-initiated requests may need
 * GM approval before mutation. GM-initiated requests auto-approve.
 *
 * Exported for use by the step 13 test helper, which simulates a
 * player-initiated request without going through the socket security
 * override (so a GM can verify approval flow in solo testing).
 *
 * @param {Object} data    payload from the request envelope
 * @param {Object} context { requestId, userId } from the dispatcher
 * @returns {Promise<Object>}
 */
export async function realCurrencyChange(data, context) {
  const { currencyType, delta, reason } = data;
  const { requestId, userId } = context ?? {};

  const backingActor = (await import("./backing-actor.js")).getBackingActor();
  if (!backingActor) {
    return { status: "failed", error: "no-backing-actor" };
  }

  const currency = getCurrency(currencyType, backingActor);
  if (!currency) {
    return { status: "failed", error: "invalid-currency-type", currencyType };
  }

  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return { status: "failed", error: "invalid-delta", delta };
  }

  const currentValue = currency.value ?? 0;

  // Zero delta is a no-op success (idempotency safety: same outcome regardless)
  if (delta === 0) {
    return {
      status: "success",
      resultData: {
        currencyType,
        currencyName: currency.name,
        currencySymbol: currency.symbol,
        delta: 0,
        previousValue: currentValue,
        newValue: currentValue,
        reason: reason ?? null,
        noop: true
      }
    };
  }

  // Approval gate (step 13). Runs on the GM-side, before any mutation.
  // GMs auto-approve their own requests; players hit the configured policy.
  const gpValue = currency.gpRate == null ? 0 : Math.abs(delta * currency.gpRate);
  if (needsApproval({ userId, delta, gpValue })) {
    const decision = await promptCurrencyApproval({
      requestId,
      userId,
      currencyType,
      currencyName: currency.name,
      currencySymbol: currency.symbol,
      delta,
      currentBalance: currentValue,
      reason
    });

    if (decision !== "approve") {
      // Write denial entry so the log captures what was attempted
      const TransactionLog = await import("./transaction-log.js");
      await TransactionLog.writeEntry({
        type: "currency.denied",
        requestId,
        userId,
        timestamp: Date.now(),
        currencyType,
        currencyName: currency.name,
        currencySymbol: currency.symbol,
        delta,
        reason: reason ?? "",
        previousValue: currentValue,
        denialReason: decision  // "deny" or "timeout"
      });

      return {
        status: "denied",
        error: decision === "timeout" ? "approval-timeout" : "denied-by-gm",
        denialReason: decision,
        currencyType,
        delta
      };
    }
    // Decision is "approve"; fall through to execute
  }

  const newValue = currentValue + delta;

  // Negative balance check: can't drain past zero
  if (newValue < 0) {
    return {
      status: "failed",
      error: "insufficient-funds",
      currencyType,
      currentBalance: currentValue,
      requested: Math.abs(delta)
    };
  }

  // Dynamic import to avoid module-level circular dependency
  const TransactionLog = await import("./transaction-log.js");

  // Phase 1: Claim — log the intent BEFORE mutating the actor
  await TransactionLog.writeEntry({
    requestId,
    userId,
    timestamp: Date.now(),
    type: "currency.claim",
    currencyType,
    currencyName: currency.name,
    currencySymbol: currency.symbol,
    delta,
    reason: reason ?? "",
    previousValue: currentValue
  });

  // Phase 2: Commit — apply the update, then log the outcome
  try {
    const applied = await applyCurrencyDelta(currencyType, delta, backingActor);
    if (applied.status !== "success") {
      throw new Error(applied.error ?? "currency-update-failed");
    }
    const committedValue = applied.newValue;

    await TransactionLog.writeEntry({
      requestId,
      userId,
      timestamp: Date.now(),
      type: "currency.commit",
      currencyType,
      currencyName: currency.name,
      currencySymbol: currency.symbol,
      delta,
      previousValue: currentValue,
      newValue: committedValue
    });

    return {
      status: "success",
      resultData: {
        currencyType,
        currencyName: currency.name,
        currencySymbol: currency.symbol,
        delta,
        previousValue: currentValue,
        newValue: committedValue,
        reason: reason ?? null
      }
    };
  } catch (err) {
    await TransactionLog.writeEntry({
      requestId,
      userId,
      timestamp: Date.now(),
      type: "currency.failed",
      currencyType,
      currencyName: currency.name,
      currencySymbol: currency.symbol,
      delta,
      error: err?.message ?? String(err)
    });

    return {
      status: "failed",
      error: err?.message ?? "currency-update-exception"
    };
  }
}

async function stubCustomResourceChange(data, context) {
  // Step 14: replaced with real implementation
  return await realResourceChange(data, context);
}

/**
 * Real custom resource change implementation (step 14). Validates the
 * request, calls resources.applyDelta, writes claim/commit/failed log
 * entries.
 *
 * No approval flow at this stage (resources are GM-curated; the
 * threshold/approval model designed for currency doesn't map cleanly).
 * Could be extended in v1.1 if needed.
 *
 * @param {Object} data    payload: { resourceId, delta, reason }
 * @param {Object} context { requestId, userId } from the dispatcher
 * @returns {Promise<Object>}
 */
async function realResourceChange(data, context) {
  const { resourceId, delta, reason } = data;
  const { requestId, userId } = context ?? {};

  if (typeof resourceId !== "string" || !resourceId) {
    return { status: "failed", error: "missing-resource-id" };
  }
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return { status: "failed", error: "invalid-delta", delta };
  }

  const Resources = await import("./resources.js");
  const TransactionLog = await import("./transaction-log.js");

  // Look up the resource so we can include its name in log entries
  const before = Resources.getResource(resourceId);

  // Zero-delta short-circuit: no log entry written, just acknowledge
  if (delta === 0) {
    return {
      status: "success",
      resultData: {
        resourceId,
        resourceName: before?.name ?? null,
        delta: 0,
        previousValue: before?.value ?? 0,
        newValue: before?.value ?? 0,
        noop: true
      }
    };
  }

  // Phase 1: Claim
  await TransactionLog.writeEntry({
    type: "resource.claim",
    requestId,
    userId,
    timestamp: Date.now(),
    resourceId,
    resourceName: before?.name ?? null,
    delta,
    reason: reason ?? "",
    previousValue: before?.value ?? 0
  });

  // Phase 2: Apply
  const result = await Resources.applyDelta(resourceId, delta);

  // Phase 3: Commit or fail log entry
  if (result.status === "success") {
    await TransactionLog.writeEntry({
      type: "resource.commit",
      requestId,
      userId,
      timestamp: Date.now(),
      resourceId,
      resourceName: result.resultData.resourceName,
      delta,
      previousValue: result.resultData.previousValue,
      newValue: result.resultData.newValue
    });
  } else {
    await TransactionLog.writeEntry({
      type: "resource.failed",
      requestId,
      userId,
      timestamp: Date.now(),
      resourceId,
      resourceName: before?.name ?? null,
      delta,
      error: result.error,
      details: {
        currentValue: result.currentValue,
        max: result.max,
        requested: result.requested
      }
    });
  }

  return result;
}

// ============================================================
// Diagnostics
// ============================================================

export function isActiveGM() {
  if (!game.user.isGM) return false;
  const active = game.users.activeGM;
  return active?.id === game.user.id;
}

export function diagnostics() {
  return {
    registered: _registered,
    queryRegistered: _queryRegistered,
    socketChannel: SOCKET_CHANNEL,
    queryName: QUERY_NAME,
    pendingResultsAwaitingReply: _pendingResults.size,
    weAreActiveGM: isActiveGM(),
    activeGMId: game.users.activeGM?.id ?? null,
    activeGMName: game.users.activeGM?.name ?? null
  };
}

/**
 * Test-only: dispatch directly without going through submitRequest.
 * Lets the harness simulate "as if" a specific user sent the request,
 * which is useful for verifying the userId-mismatch warning path.
 */
export async function _dispatchForTesting(payload, asSenderUserId) {
  return await dispatchPayload(payload, asSenderUserId);
}
