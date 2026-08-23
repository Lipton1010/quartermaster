/** Staged currency stored exclusively on the GM-only staging actor. */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor, getStagingActor } from "./backing-actor.js";
import { writeEntry } from "./transaction-log.js";
import { getCurrency, applyCurrencyDelta, roundCurrency } from "./currencies.js";
import { readRecoveryRecords, writeRecoveryRecord } from "./recovery-records.js";
import {
  executeOperation,
  getRequestAgeMaxMs,
  inspectRequestReplay
} from "./operation-coordinator.js";
import { requireActiveStorageGM, withStorageLedgerLock } from "./storage-ledger.js";

const REVEAL_OPERATION_TYPE = "hiddenCurrencyReveal";
const REVEAL_REQUEST_PREFIX = "qm-hc-reveal";

export function getHiddenCurrency(actor = getStagingActor()) {
  const storage = getStagingActor() ?? actor;
  if (!storage) return [];
  const entries = storage.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY);
  if (!Array.isArray(entries)) return [];
  return [...entries].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export async function addHiddenCurrency(type, amount, folderId = null) {
  if (!game.user?.isGM) return { status: "failed", error: "gm-only" };
  const staging = getStagingActor();
  const backing = getBackingActor();
  if (!staging || !backing) return { status: "failed", error: "storage-unavailable" };

  const normalizedAmount = roundCurrency(Number(amount));
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return { status: "failed", error: "invalid-amount" };
  }
  const currency = getCurrency(type, backing);
  if (!currency) return { status: "failed", error: "invalid-type" };
  if (currency.wholeUnitsOnly && !Number.isInteger(normalizedAmount)) {
    return { status: "failed", error: "whole-coins-required" };
  }

  const entry = {
    id: `qm-hc-${foundry.utils.randomID()}`,
    type,
    currencyId: type,
    currencyName: currency.name,
    currencySymbol: currency.symbol,
    amount: normalizedAmount,
    folderId: folderId || null,
    createdAt: Date.now()
  };
  try {
    await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      await staging.setFlag(
        MODULE_ID,
        FLAGS.HIDDEN_CURRENCY,
        [...getHiddenCurrency(staging), entry]
      );
    });
  } catch (error) {
    // A Foundry hook can throw after the flag update has already committed.
    const persisted = getHiddenCurrency(staging).some(candidate => candidate.id === entry.id);
    if (!persisted) {
      return {
        status: "failed",
        error: storageMutationError(error, "staged-currency-create-failed"),
        details: errorMessage(error)
      };
    }
    console.warn(`${MODULE_TITLE} | staged currency creation reported an error after commit`, error);
  }
  console.debug(`${MODULE_TITLE} | addHiddenCurrency: ${normalizedAmount} ${currency.symbol}`);
  return { status: "success", entry };
}

export async function deleteHiddenCurrency(entryId) {
  if (!game.user?.isGM) return { status: "failed", error: "gm-only" };
  const staging = getStagingActor();
  if (!staging) return { status: "failed", error: "no-staging-actor" };
  try {
    return await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      const existing = getHiddenCurrency(staging);
      const entry = existing.find(candidate => candidate.id === entryId);
      if (!entry) return { status: "failed", error: "not-found" };
      await staging.setFlag(
        MODULE_ID,
        FLAGS.HIDDEN_CURRENCY,
        existing.filter(candidate => candidate.id !== entryId)
      );
      return { status: "success", entry };
    });
  } catch (error) {
    // As with reveal finalization, verify the live flag before deciding that
    // a thrown hook means the deletion failed.
    const stillPresent = getHiddenCurrency(staging).some(entry => entry.id === entryId);
    if (!stillPresent) {
      console.warn(`${MODULE_TITLE} | staged currency deletion reported an error after commit`, error);
      return { status: "success", warning: errorMessage(error) };
    }
    return {
      status: "failed",
      error: storageMutationError(error, "staged-currency-delete-failed"),
      details: errorMessage(error)
    };
  }
}

export async function revealHiddenCurrency(entryId, { notify = true } = {}) {
  if (!game.user?.isGM) return { status: "failed", error: "gm-only" };
  const staging = getStagingActor();
  const backing = getBackingActor();
  if (!staging || !backing) return { status: "failed", error: "storage-unavailable" };

  const prepared = await prepareRevealRequest(staging, entryId);
  if (prepared.status !== "success") return prepared;
  const entry = prepared.entry;
  const requestId = entry.revealRequestId;
  if (hasPendingRecovery(requestId)) {
    return { status: "failed", error: "recovery-reconciliation-required", requestId };
  }
  const currencyId = entry.currencyId ?? entry.type;
  const currency = getCurrency(currencyId, backing);
  if (!currency) {
    const replay = inspectRequestReplay({
      requestId,
      requester: game.user.id,
      operationType: REVEAL_OPERATION_TYPE,
      timestamp: entry.revealRequestedAt,
      requestData: buildRevealRequestData(entry)
    });
    if (isUnsafeRevealReplay(replay)) {
      return { status: "failed", error: "recovery-reconciliation-required", requestId };
    }
    await clearRevealRequestStamp(staging, new Set([entry.id]), entry.revealRequestId);
    return { status: "failed", error: "currency-not-found" };
  }

  const requestData = buildRevealRequestData(entry);
  const result = await executeOperation({
    resourceKeys: ["currency-ledger", `staged-currency:${entry.id}`],
    requestId,
    operationType: REVEAL_OPERATION_TYPE,
    requester: game.user.id,
    timestamp: entry.revealRequestedAt,
    requestData,
    fn: async () => performCurrencyReveal({
      requestId,
      requestData,
      entry,
      currency,
      backing,
      staging
    })
  });
  if (notify && result.status === "success") {
    const label = `${entry.amount} ${currency.symbol}`;
    ui.notifications?.info?.(`${label} added to vault.`);
  }
  if (result.status !== "success" && isSafelyRetryableRevealFailure(result)) {
    const retryReady = await clearRevealRequestStamp(
      staging,
      new Set([entry.id]),
      entry.revealRequestId
    );
    return { ...result, retryReady };
  }
  return result;
}

export async function revealAllHiddenCurrency() {
  if (!game.user?.isGM) return { status: "failed", error: "gm-only" };
  const staging = getStagingActor();
  if (!staging || !getBackingActor()) {
    return { status: "failed", error: "storage-unavailable" };
  }

  // Each entry gets its own durable request identity and coordinator claim.
  // Serial iteration keeps "reveal all" restartable: completed entries are
  // gone, while the first interrupted entry fails closed on its stable claim.
  const entryIds = getHiddenCurrency(staging).map(entry => entry.id);
  if (entryIds.length === 0) return { status: "success", count: 0 };
  let count = 0;
  for (const entryId of entryIds) {
    const result = await revealHiddenCurrency(entryId, { notify: false });
    if (result.status !== "success") return { ...result, count };
    count += 1;
  }

  ui.notifications?.info?.(`${count} currency entry(s) revealed to vault.`);
  return { status: "success", count };
}

async function prepareRevealRequest(staging, entryId) {
  try {
    return await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      const existing = getHiddenCurrency(staging);
      const index = existing.findIndex(candidate => candidate.id === entryId);
      if (index < 0) return { status: "failed", error: "not-found" };

      const current = existing[index];
      const persistedRequestId = cleanRequestId(current.revealRequestId);
      const persistedTimestamp = validTimestamp(current.revealRequestedAt)
        ? current.revealRequestedAt
        : null;
      let revealRequestId = persistedRequestId;
      let revealRequestedAt = persistedTimestamp;

      if (persistedRequestId && persistedTimestamp
          && Date.now() - persistedTimestamp > getRequestAgeMaxMs()) {
        const replay = inspectRequestReplay({
          requestId: persistedRequestId,
          requester: game.user.id,
          operationType: REVEAL_OPERATION_TYPE,
          timestamp: persistedTimestamp,
          requestData: buildRevealRequestData(current)
        });
        // An expired stamp may be rotated only when there is no pending,
        // unverifiable, colliding, successful, or recovery-required record.
        // Interrupted credits must continue to fail closed.
        if (hasPendingRecovery(persistedRequestId) || isUnsafeRevealReplay(replay)) {
          return {
            status: "failed",
            error: "recovery-reconciliation-required",
            requestId: persistedRequestId
          };
        }
        revealRequestId = null;
        revealRequestedAt = null;
      }

      revealRequestId ??= `${REVEAL_REQUEST_PREFIX}-${current.id}-${foundry.utils.randomID()}`;
      revealRequestedAt ??= Date.now();
      const entry = { ...current, revealRequestId, revealRequestedAt };

      if (current.revealRequestId !== revealRequestId
          || current.revealRequestedAt !== revealRequestedAt) {
        const updated = [...existing];
        updated[index] = entry;
        try {
          await staging.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, updated);
        } catch (error) {
          const persisted = getHiddenCurrency(staging).find(candidate => candidate.id === entryId);
          if (persisted?.revealRequestId !== revealRequestId
              || persisted?.revealRequestedAt !== revealRequestedAt) {
            return {
              status: "failed",
              error: "reveal-request-persist-failed",
              details: errorMessage(error)
            };
          }
          console.warn(`${MODULE_TITLE} | reveal request stamp reported an error after commit`, error);
        }
      }
      return { status: "success", entry };
    });
  } catch (error) {
    return {
      status: "failed",
      error: storageMutationError(error, "reveal-request-persist-failed"),
      details: errorMessage(error)
    };
  }
}

function isSafelyRetryableRevealFailure(result) {
  return new Set([
    "currency-not-found",
    "invalid-currency-type",
    "invalid-delta",
    "whole-coins-required",
    "insufficient-funds",
    "not-found",
    "staged-entry-changed",
    "claim-log-unavailable",
    "request-too-old",
    "request-too-far-in-future"
  ]).has(result?.error);
}

function isUnsafeRevealReplay(replay) {
  if (!replay || typeof replay !== "object") return true;
  if (replay.state === "pending"
      || replay.state === "unverifiable"
      || replay.state === "collision") {
    return true;
  }
  if (replay.state !== "replay") return false;
  return replay.result?.status === "success"
    || isRecoveryRequiredRevealResult(replay.result);
}

function isRecoveryRequiredRevealResult(result) {
  return result?.error === "recovery-reconciliation-required"
    || result?.error === "currency-reconciliation-required"
    || result?.error === "request-recovery-required"
    || result?.error === "operation-reconciliation-required";
}

async function performCurrencyReveal({
  requestId,
  requestData,
  entry,
  currency,
  backing,
  staging
}) {
  if (hasPendingRecovery(requestId)) {
    return { status: "failed", error: "recovery-reconciliation-required", requestId };
  }

  // Recheck the staged value after coordinator serialization. A rapid local
  // edit must not mutate currency using a stale amount or denomination.
  const currentEntry = await withStorageLedgerLock(async () => {
    requireActiveStorageGM();
    return getHiddenCurrency(staging).find(candidate => candidate.id === entry.id) ?? null;
  });
  if (!currentEntry) return { status: "failed", error: "not-found" };
  if (!sameRevealRequest(currentEntry, entry, requestData)) {
    return { status: "failed", error: "staged-entry-changed", requestId };
  }

  const claim = await writeRevealClaim({ requestId, entries: [entry], currency });
  if (!claim) return { status: "failed", error: "claim-log-unavailable", requestId };

  const applied = await safeApplyCurrencyDelta(currency.id, entry.amount, backing);
  if (applied.status !== "success") return applied;
  const finalized = await finalizeCurrencyReveal({
    requestId,
    entries: [entry],
    applied,
    currency,
    backing,
    staging
  });
  if (finalized.status !== "success") return finalized;
  await logReveal(entry, currency, applied, backing, requestId);

  return {
    status: "success",
    entry,
    newValue: applied.newValue,
    resultData: {
      entryId: entry.id,
      currencyId: currency.id,
      currencySymbol: currency.symbol,
      amount: entry.amount,
      previousValue: applied.previousValue,
      newValue: applied.newValue
    }
  };
}

async function writeRevealClaim({ requestId, entries, currency, amount = null }) {
  return writeEntry({
    type: "currency.claim",
    visibility: "gm",
    operationType: "hiddenCurrencyReveal",
    requestId,
    userId: game.user.id,
    currencyType: currency.id,
    currencyName: currency.name,
    currencySymbol: currency.symbol,
    amount: amount ?? entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
    stagedEntryIds: entries.map(entry => entry.id)
  });
}

async function finalizeCurrencyReveal({
  requestId,
  entries,
  applied,
  currency,
  backing,
  staging
}) {
  const ids = new Set(entries.map(entry => entry.id));
  try {
    await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      const current = getHiddenCurrency(staging);
      const remaining = current.filter(entry => !ids.has(entry.id));
      await staging.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, remaining);
      const stillPresent = getHiddenCurrency(staging).some(entry => ids.has(entry.id));
      if (stillPresent) throw new Error("staged-currency-delete-did-not-remove-entry");
    });
    return { status: "success" };
  } catch (error) {
    // A hook can throw after the flag update has already committed.
    const stillPresent = await withStorageLedgerLock(async () =>
      getHiddenCurrency(staging).some(entry => ids.has(entry.id))
    );
    if (!stillPresent) {
      console.warn(`${MODULE_TITLE} | staged currency removal reported an error after commit`, error);
      return { status: "success", warning: String(error?.message ?? error) };
    }

    const total = roundCurrency(entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0));
    const compensation = await safeApplyCurrencyDelta(currency.id, -total, backing);
    const retryReady = compensation.status === "success"
      ? await clearRevealRequestStamp(staging, ids, requestId)
      : false;
    let recoveryRecorded = false;
    if (compensation.status !== "success") {
      try {
        recoveryRecorded = Boolean(await writeRecoveryRecord({
          requestId,
          type: "currency.reveal.compensation-failed",
          operation: "currency.reveal",
          status: "needs-reconciliation",
          currencyId: currency.id,
          currencyName: currency.name,
          currencySymbol: currency.symbol,
          amount: total,
          previousValue: applied.previousValue,
          creditedValue: applied.newValue,
          stagedEntries: entries,
          error: String(error?.message ?? error),
          compensationError: compensation.error ?? "currency-compensation-failed"
        }));
      } catch (recoveryError) {
        console.error(`${MODULE_TITLE} | currency recovery record failed`, recoveryError);
      }
    }

    await writeEntry({
      type: "currency.failed",
      visibility: "gm",
      operationType: "hiddenCurrencyReveal",
      requestId,
      userId: game.user.id,
      currencyType: currency.id,
      currencyName: currency.name,
      currencySymbol: currency.symbol,
      amount: total,
      error: String(error?.message ?? error),
      compensated: compensation.status === "success",
      retryReady,
      recoveryRecorded
    });

    return {
      status: "failed",
      error: compensation.status === "success"
        ? "staged-currency-delete-failed-compensated"
        : "currency-reconciliation-required",
      requestId,
      compensated: compensation.status === "success",
      retryReady,
      recoveryRecorded
    };
  }
}

async function clearRevealRequestStamp(staging, ids, requestId) {
  try {
    return await withStorageLedgerLock(async () => {
      requireActiveStorageGM();
      const current = getHiddenCurrency(staging);
      let changed = false;
      const updated = current.map(entry => {
        if (!ids.has(entry.id) || entry.revealRequestId !== requestId) return entry;
        const reset = { ...entry };
        delete reset.revealRequestId;
        delete reset.revealRequestedAt;
        changed = true;
        return reset;
      });
      if (!changed) return true;
      try {
        await staging.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, updated);
      } catch (error) {
        const stillStamped = getHiddenCurrency(staging).some(entry =>
          ids.has(entry.id) && entry.revealRequestId === requestId
        );
        if (stillStamped) {
          console.error(`${MODULE_TITLE} | unable to reset compensated reveal request`, error);
          return false;
        }
        console.warn(`${MODULE_TITLE} | reveal request reset reported an error after commit`, error);
      }
      return true;
    });
  } catch (error) {
    console.error(`${MODULE_TITLE} | unable to reset compensated reveal request`, error);
    return false;
  }
}

function hasPendingRecovery(requestId) {
  return readRecoveryRecords().some(record =>
    record.requestId === requestId
      && record.operation === "currency.reveal"
      && record.status !== "resolved"
  );
}

async function safeApplyCurrencyDelta(currencyId, delta, actor) {
  try {
    // Recheck the active-GM election immediately before either the credit or
    // its compensation. A former active GM must never continue mutating the
    // shared balance after another client has been elected.
    requireActiveStorageGM();
    return await applyCurrencyDelta(currencyId, delta, actor);
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error) };
  }
}

async function logReveal(entry, currency, applied, backing, requestId = null) {
  await writeEntry({
    type: "currency.revealed",
    requestId: requestId ?? `qm-hc-reveal-${entry.id}-${currency.id}-${Date.now()}`,
    userId: game.user.id,
    currencyType: currency.id,
    currencyName: currency.name,
    currencySymbol: currency.symbol,
    delta: entry.amount,
    amount: entry.amount,
    previousValue: applied.previousValue,
    newValue: applied.newValue,
    backingActorId: backing.id
  });
}

function buildRevealRequestData(entry) {
  return {
    type: "quartermaster.hiddenCurrencyReveal",
    action: "reveal",
    payload: {
      stagedEntryId: entry.id,
      currencyId: entry.currencyId ?? entry.type,
      amount: entry.amount,
      revealRequestId: entry.revealRequestId,
      revealRequestedAt: entry.revealRequestedAt
    }
  };
}

function sameRevealRequest(entry, preparedEntry, requestData) {
  const payload = requestData?.payload;
  return entry.revealRequestId === preparedEntry.revealRequestId
    && entry.revealRequestId === payload?.revealRequestId
    && entry.id === payload?.stagedEntryId
    && (entry.currencyId ?? entry.type) === payload?.currencyId
    && Number(entry.amount) === Number(payload?.amount)
    && entry.revealRequestedAt === payload?.revealRequestedAt;
}

function cleanRequestId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function storageMutationError(error, fallback) {
  return errorMessage(error) === "active-gm-required" ? "active-gm-required" : fallback;
}
