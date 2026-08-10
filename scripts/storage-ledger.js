/**
 * Single-client serialization for Quartermaster's private storage ledger.
 *
 * Only the elected Foundry active GM is allowed to mutate canonical storage.
 * Foundry routes all mutation requests to that client, so one shared mutex is
 * sufficient to prevent lost updates between transaction-log, recovery, and
 * other private-ledger writers in that client.
 */

import { AsyncLock } from "./async-lock.js";

const STORAGE_LEDGER_KEY = "quartermaster-storage-ledger";
const storageLedgerLock = new AsyncLock();

/** Return true only for Foundry's currently elected active GM. */
export function isActiveStorageGM(
  user = globalThis.game?.user,
  users = globalThis.game?.users
) {
  const activeGM = users?.activeGM;
  return Boolean(user?.isGM && user?.id && activeGM?.id === user.id);
}

/** Throw before a private-ledger mutation can run on any other client. */
export function requireActiveStorageGM() {
  if (!isActiveStorageGM()) throw new Error("active-gm-required");
  return true;
}

/**
 * Serialize one canonical-storage read/modify/write sequence.
 *
 * Authorization deliberately remains explicit at each caller. Keeping this
 * primitive authorization-neutral makes it safe to share with migration and
 * reconciliation helpers which need their own return/error contracts.
 */
export function withStorageLedgerLock(fn) {
  if (typeof fn !== "function") throw new TypeError("storage-ledger-callback-required");
  return storageLedgerLock.acquire(STORAGE_LEDGER_KEY, fn);
}

/** Test/diagnostic visibility without exposing the lock implementation. */
export function storageLedgerDiagnostics() {
  return {
    activeGM: isActiveStorageGM(),
    pendingKeys: storageLedgerLock.size()
  };
}
