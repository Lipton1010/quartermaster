import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("all custom-resource requests share the array ledger coordinator key", () => {
  const socket = source("scripts/socket-handler.js");
  assert.match(socket, /const resourceKeys = \["custom-resource-ledger"\]/);
  assert.doesNotMatch(socket, /`customResource:\$\{payload\.resourceId\}`/);
});

test("legacy IDs and UUIDs share one item-transfer coordinator gate", () => {
  const socket = source("scripts/socket-handler.js");
  assert.match(
    socket,
    /const resourceKeys = \["item-transfer-ledger", `item:\$\{itemKey\}`\]/
  );
});

test("resource read-modify-write entry points require the active GM and storage ledger", () => {
  const resources = source("scripts/resources.js");
  for (const name of ["createResource", "updateResource", "deleteResource", "applyDelta"]) {
    const start = resources.indexOf(`export async function ${name}`);
    const nextExport = resources.indexOf("export async function", start + 1);
    const body = resources.slice(start, nextExport < 0 ? undefined : nextExport);
    assert.ok(start >= 0, `${name} export is present`);
    assert.match(body, /isActiveStorageGM\(\)/, `${name} checks the active GM`);
    assert.match(body, /withStorageLedgerLock/, `${name} uses the shared ledger`);
    assert.match(body, /requireActiveStorageGM\(\)/, `${name} rechecks inside the ledger`);
  }
});

test("currency config and balance mutations share the active-GM storage ledger", () => {
  const currencies = source("scripts/currencies.js");
  for (const name of [
    "ensureCurrencyConfig",
    "createCustomCurrency",
    "updateCurrency",
    "setReferenceCurrency",
    "deleteCustomCurrency",
    "applyCurrencyDelta"
  ]) {
    const start = currencies.indexOf(`export async function ${name}`);
    const nextExport = currencies.indexOf("export async function", start + 1);
    const body = currencies.slice(start, nextExport < 0 ? undefined : nextExport);
    assert.ok(start >= 0, `${name} export is present`);
    assert.match(body, /isActiveStorageGM\(\)/, `${name} checks the active GM`);
    assert.match(body, /withStorageLedgerLock/, `${name} uses the shared ledger`);
    assert.match(body, /requireActiveStorageGM\(\)/, `${name} rechecks inside the ledger`);
  }
});

test("storage Item writes recheck active-GM authority at the document boundary", () => {
  const dragDrop = source("scripts/drag-drop.js");
  const inventory = source("scripts/apps/inventory-app.js");
  const backing = source("scripts/backing-actor.js");

  assert.match(
    dragDrop,
    /requireActiveStorageGM\(\);\s*const \[created\] = await backingActor\.createEmbeddedDocuments/
  );
  assert.match(inventory, /async function moveItemInOrder[\s\S]*?if \(!isActiveStorageGM\(\)\) return;/);
  assert.match(inventory, /async function reorderItem[\s\S]*?if \(!isActiveStorageGM\(\)\) return;/);
  assert.match(inventory, /requireActiveStorageGM\(\);\s*await item\.setFlag/g);
  assert.match(backing, /export function preventInactiveGmStorageItemMutation/);
  for (const hook of ["preCreateItem", "preUpdateItem", "preDeleteItem"]) {
    assert.match(backing, new RegExp(`Hooks\\.on\\("${hook}", preventInactiveGmStorageItemMutation\\)`));
  }
  assert.match(backing, /Hooks\.on\("preDeleteActor", preventBackingActorDeletion\)/);
});

test("coordinated terminal results are plain JSON before persistence or replay", () => {
  const coordinator = source("scripts/operation-coordinator.js");
  assert.match(coordinator, /terminalResult = normalizeTerminalResult\(result\)/);
  assert.match(coordinator, /result: terminalResult/);
  assert.match(coordinator, /cacheResult\(requestId, binding, terminalResult\)/);
  assert.match(coordinator, /return terminalResult;/);
  assert.match(
    coordinator,
    /function normalizeTerminalResult[\s\S]*?JSON\.stringify\(result\)[\s\S]*?JSON\.parse\(serialized\)/
  );
});

test("currency approval cannot hold the shared currency mutation lock", () => {
  const socket = source("scripts/socket-handler.js");
  const dispatchStart = socket.indexOf("async function dispatchCurrencyChange");
  const dispatchEnd = socket.indexOf("async function dispatchCustomResourceChange", dispatchStart);
  const dispatch = socket.slice(dispatchStart, dispatchEnd);
  const approvalStart = dispatch.indexOf("coordinateCurrencyApproval");
  const currencyOperationStart = dispatch.indexOf("resourceKeys = [\"currency-ledger\"]");
  assert.ok(approvalStart >= 0 && approvalStart < currencyOperationStart);
  assert.match(dispatch, /resourceKeys: \[`currency-approval:\$\{requestId\}`\]/);
  assert.match(dispatch, /approvalResolved: true/);
  assert.match(dispatch, /mutationTimestamp = Number.isFinite\(approval\.resultData\?\.approvedAt\)/);
  assert.match(dispatch, /timestamp: mutationTimestamp/);
});
