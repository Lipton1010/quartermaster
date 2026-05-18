/**
 * Quartermaster — Step 15 Test Harness
 *
 * Tests for the hidden-items lifecycle: staging, reveal, bulk-reveal,
 * delete, and transaction log entry shape.
 *
 * Each test snapshots the backing actor's item list (specifically any
 * existing hidden-flagged items) and the transaction log before mutating,
 * restoring both in a `finally` block.
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep15Tests();
 *
 * No items are left behind on the backing actor; all created test items
 * are deleted in cleanup.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import {
  getHiddenItems,
  setItemHidden,
  revealItem,
  revealItems,
  deleteHiddenItem,
  stageHiddenItem
} from "./hidden-items.js";
import * as TransactionLog from "./transaction-log.js";

const TEST_PREFIX = "qm-step15-test-";

// ============================================================
// Snapshot / restore helpers
// ============================================================

function snapshotLog() {
  return TransactionLog.readAll().map(e => ({ ...e }));
}

async function restoreLog(snapshot) {
  const actor = getBackingActor();
  if (!actor) return;
  await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, snapshot);
}

/** Return the ids of items currently hidden on the backing actor. */
function snapshotHiddenIds() {
  const actor = getBackingActor();
  if (!actor) return [];
  return getHiddenItems(actor).map(i => i.id);
}

/**
 * Remove any items created by our tests that remain on the backing actor.
 * Keyed by the name prefix "QM-TEST-HIDDEN-".
 */
async function cleanupTestItems() {
  const actor = getBackingActor();
  if (!actor) return 0;
  const testItems = actor.items
    .filter(i => (i.name ?? "").startsWith("QM-TEST-HIDDEN-"))
    .map(i => i.id);
  if (testItems.length === 0) return 0;
  await actor.deleteEmbeddedDocuments("Item", testItems);
  return testItems.length;
}

export async function cleanupStep15Fixtures() {
  if (!game.user.isGM) return 0;
  const actor = getBackingActor();
  if (!actor) return 0;

  const logSnap = snapshotLog();
  const filtered = logSnap.filter(e =>
    typeof e.requestId !== "string" || !e.requestId.startsWith(TEST_PREFIX)
  );
  const logRemoved = logSnap.length - filtered.length;
  if (logRemoved > 0) {
    await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, filtered);
  }

  const itemsRemoved = await cleanupTestItems();
  console.log(
    `${MODULE_TITLE} | Step 15 cleanup: removed ${logRemoved} log entries, ${itemsRemoved} test items`
  );
  return logRemoved + itemsRemoved;
}

// ============================================================
// Minimal synthetic item creator (no compendium needed)
// ============================================================

/**
 * Create a minimal test item on the backing actor with the hidden flag set.
 * Returns the created item, or null on failure.
 */
async function createTestHiddenItem(nameSuffix = "") {
  const actor = getBackingActor();
  if (!actor) return null;
  const itemData = {
    name: `QM-TEST-HIDDEN-${nameSuffix || Date.now()}`,
    type: "loot",
    img: "icons/svg/item-bag.svg",
    flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } }
  };
  const [item] = await actor.createEmbeddedDocuments("Item", [itemData]);
  return item ?? null;
}

// ============================================================
// Test utilities
// ============================================================

let _pass = 0;
let _fail = 0;

function pass(label) {
  _pass++;
  console.log(`%c  ✓ ${label}`, "color: #4caf50");
}

function fail(label, detail) {
  _fail++;
  console.error(`  ✗ ${label}`, detail ?? "");
}

function assert(condition, label, detail) {
  condition ? pass(label) : fail(label, detail);
}

// ============================================================
// Individual tests
// ============================================================

async function testGetHiddenItemsEmpty() {
  // Before we add anything, getHiddenItems should return [] for a fresh snapshot.
  // (Prior hidden items may exist, so we only check return type.)
  const actor = getBackingActor();
  const items = getHiddenItems(actor);
  assert(Array.isArray(items), "getHiddenItems returns an array");
}

async function testStageAndReveal() {
  const logSnap = snapshotLog();
  let item = null;
  try {
    item = await createTestHiddenItem("stage-reveal");
    assert(!!item, "test item created on backing actor");

    // Verify it appears in getHiddenItems
    const actor = getBackingActor();
    const hidden = getHiddenItems(actor);
    const found = hidden.find(i => i.id === item.id);
    assert(!!found, "staged item appears in getHiddenItems");

    // Reveal it
    const result = await revealItem(item.id);
    assert(result.status === "success", "revealItem: status success", result);
    assert(result.itemId === item.id,   "revealItem: correct itemId");
    assert(typeof result.itemName === "string", "revealItem: itemName is string");

    // Should no longer be in hidden list
    const hiddenAfter = getHiddenItems(actor);
    const stillHidden = hiddenAfter.find(i => i.id === item.id);
    assert(!stillHidden, "revealed item absent from getHiddenItems");

    // Verify item still exists on actor (just no hidden flag)
    const itemDoc = actor.items.get(item.id);
    assert(!!itemDoc, "item still exists on actor after reveal");
    const flagVal = itemDoc.getFlag(MODULE_ID, FLAGS.HIDDEN);
    assert(!flagVal, "hidden flag cleared after reveal");

    // Log entry should exist
    const log = TransactionLog.readAll();
    const entry = log.find(e => e.type === "hidden.revealed" && e.itemId === item.id);
    assert(!!entry, "hidden.revealed log entry written");
    assert(entry.userId === game.user.id, "log entry has correct userId");

  } finally {
    if (item) {
      try { await getBackingActor()?.deleteEmbeddedDocuments("Item", [item.id]); } catch {}
    }
    await restoreLog(logSnap);
  }
}

async function testDeleteHiddenItem() {
  const logSnap = snapshotLog();
  let item = null;
  try {
    item = await createTestHiddenItem("delete");
    assert(!!item, "test item created for delete test");

    const result = await deleteHiddenItem(item.id);
    assert(result.status === "success", "deleteHiddenItem: status success", result);

    // Item should be gone from the actor
    const actor = getBackingActor();
    const stillThere = actor.items.get(item.id);
    assert(!stillThere, "deleted item absent from backing actor");
    item = null; // no cleanup needed

    // Log entry
    const log = TransactionLog.readAll();
    const entry = log.find(e => e.type === "hidden.deleted" && e.itemId === result.itemId);
    assert(!!entry, "hidden.deleted log entry written");

  } finally {
    if (item) {
      try { await getBackingActor()?.deleteEmbeddedDocuments("Item", [item.id]); } catch {}
    }
    await restoreLog(logSnap);
  }
}

async function testRevealNotFound() {
  const result = await revealItem("nonexistent-id-12345");
  assert(result.status === "failed", "revealItem non-existent: status failed");
  assert(result.error === "item-not-found", "revealItem non-existent: correct error code", result);
}

async function testDeleteNotFound() {
  const result = await deleteHiddenItem("nonexistent-id-99999");
  assert(result.status === "failed", "deleteHiddenItem non-existent: status failed");
  assert(result.error === "item-not-found", "deleteHiddenItem non-existent: correct error code", result);
}

async function testBulkReveal() {
  const logSnap = snapshotLog();
  const createdIds = [];
  try {
    // Create 3 test hidden items
    for (let i = 0; i < 3; i++) {
      const item = await createTestHiddenItem(`bulk-${i}`);
      if (item) createdIds.push(item.id);
    }
    assert(createdIds.length === 3, `bulk: created 3 test items (got ${createdIds.length})`);

    const { results, successCount, failCount } = await revealItems(createdIds);
    assert(successCount === 3, `bulk reveal: successCount=3 (got ${successCount})`);
    assert(failCount === 0,    `bulk reveal: failCount=0 (got ${failCount})`);

    // None should remain hidden
    const actor = getBackingActor();
    const stillHidden = createdIds.filter(id => {
      const doc = actor.items.get(id);
      return doc?.getFlag(MODULE_ID, FLAGS.HIDDEN) === true;
    });
    assert(stillHidden.length === 0, "bulk reveal: no items remain hidden");

  } finally {
    // Cleanup revealed (now visible) items
    const actor = getBackingActor();
    const toDelete = createdIds.filter(id => actor.items.get(id));
    if (toDelete.length > 0) {
      try { await actor.deleteEmbeddedDocuments("Item", toDelete); } catch {}
    }
    await restoreLog(logSnap);
  }
}

async function testSetItemHidden() {
  const logSnap = snapshotLog();
  let item = null;
  try {
    // Start visible (no hidden flag)
    const actor = getBackingActor();
    const [created] = await actor.createEmbeddedDocuments("Item", [{
      name: "QM-TEST-HIDDEN-setflag",
      type: "loot",
      img: "icons/svg/item-bag.svg"
    }]);
    item = created;
    assert(!!item, "setItemHidden: test item created");

    // Mark hidden
    const r1 = await setItemHidden(item.id, true);
    assert(!!r1, "setItemHidden(true): returned item");
    const flagAfterHide = actor.items.get(item.id)?.getFlag(MODULE_ID, FLAGS.HIDDEN);
    assert(flagAfterHide === true, "setItemHidden(true): flag is true");

    // Unmark hidden
    const r2 = await setItemHidden(item.id, false);
    assert(!!r2, "setItemHidden(false): returned item");
    const flagAfterUnhide = actor.items.get(item.id)?.getFlag(MODULE_ID, FLAGS.HIDDEN);
    assert(!flagAfterUnhide, "setItemHidden(false): flag cleared");

  } finally {
    if (item) {
      try { await getBackingActor()?.deleteEmbeddedDocuments("Item", [item.id]); } catch {}
    }
    await restoreLog(logSnap);
  }
}

async function testRevealItems_emptyArray() {
  const { results, successCount, failCount } = await revealItems([]);
  assert(Array.isArray(results) && results.length === 0, "revealItems([]): empty results");
  assert(successCount === 0, "revealItems([]): successCount=0");
  assert(failCount === 0,    "revealItems([]): failCount=0");
}

async function testInventoryFilterUnaffected() {
  // Verify that buildInventoryContext (imported indirectly via the api) still
  // filters hidden items. We do this by checking that an item with the hidden
  // flag does NOT appear in the items array of the context.
  const logSnap = snapshotLog();
  let item = null;
  try {
    item = await createTestHiddenItem("inv-filter");
    assert(!!item, "inv-filter: test hidden item created");

    // Import buildInventoryContext dynamically to avoid circular deps in test
    const { buildInventoryContext } = await import("./inventory-rendering.js");
    const actor = getBackingActor();
    const ctx = buildInventoryContext(actor);
    const found = (ctx.items ?? []).find(i => i.id === item.id);
    assert(!found, "buildInventoryContext excludes hidden item from items array");

  } finally {
    if (item) {
      try { await getBackingActor()?.deleteEmbeddedDocuments("Item", [item.id]); } catch {}
    }
    await restoreLog(logSnap);
  }
}

// ============================================================
// Runner
// ============================================================

export async function runStep15Tests() {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | Step 15 tests require GM.`);
    return;
  }
  const actor = getBackingActor();
  if (!actor) {
    console.error(`${MODULE_TITLE} | Step 15 tests: no backing actor.`);
    return;
  }

  _pass = 0;
  _fail = 0;

  console.group(`${MODULE_TITLE} | Step 15 Tests`);

  try {
    console.group("getHiddenItems");
    await testGetHiddenItemsEmpty();
    console.groupEnd();

    console.group("setItemHidden");
    await testSetItemHidden();
    console.groupEnd();

    console.group("stage + reveal");
    await testStageAndReveal();
    console.groupEnd();

    console.group("deleteHiddenItem");
    await testDeleteHiddenItem();
    console.groupEnd();

    console.group("error paths");
    await testRevealNotFound();
    await testDeleteNotFound();
    console.groupEnd();

    console.group("bulk reveal");
    await testBulkReveal();
    console.groupEnd();

    console.group("revealItems([])");
    await testRevealItems_emptyArray();
    console.groupEnd();

    console.group("inventory filter");
    await testInventoryFilterUnaffected();
    console.groupEnd();

  } catch (unexpectedErr) {
    console.error(`${MODULE_TITLE} | Step 15: unexpected error`, unexpectedErr);
    _fail++;
  }

  const total = _pass + _fail;
  const summaryColor = _fail === 0 ? "color: #4caf50; font-weight:bold" : "color: #f44336; font-weight:bold";
  console.log(`%c${_pass}/${total} passed`, summaryColor);
  console.groupEnd();

  return { pass: _pass, fail: _fail, total };
}
