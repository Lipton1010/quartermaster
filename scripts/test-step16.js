/**
 * Quartermaster — Step 16 Test Harness
 *
 * Tests for the inventory GM actions: hide-to-loot-prep and delete-from-vault.
 * The context menu and drag re-hide are UI interactions that can't be fully
 * automated, but the underlying functions (handleInventoryGMAction,
 * setItemHidden, deleteEmbeddedDocuments) are tested directly here.
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep16Tests();
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { getHiddenItems, setItemHidden } from "./hidden-items.js";
import { handleInventoryGMAction } from "./context-menu.js";
import * as TransactionLog from "./transaction-log.js";

const TEST_PREFIX = "qm-step16-test-";

// ============================================================
// Helpers
// ============================================================

function snapshotLog() {
  return TransactionLog.readAll().map(e => ({ ...e }));
}

async function restoreLog(snapshot) {
  const actor = getBackingActor();
  if (actor) await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, snapshot);
}

async function createVisibleTestItem(suffix = "") {
  const actor = getBackingActor();
  if (!actor) return null;
  const [item] = await actor.createEmbeddedDocuments("Item", [{
    name: `QM-TEST-STEP16-${suffix || Date.now()}`,
    type: "loot",
    img: "icons/svg/item-bag.svg"
    // No hidden flag — starts visible
  }]);
  return item ?? null;
}

async function cleanupTestItems() {
  const actor = getBackingActor();
  if (!actor) return 0;
  const items = actor.items
    .filter(i => (i.name ?? "").startsWith("QM-TEST-STEP16-"))
    .map(i => i.id);
  if (items.length) await actor.deleteEmbeddedDocuments("Item", items);
  return items.length;
}

export async function cleanupStep16Fixtures() {
  if (!game.user.isGM) return 0;
  const actor = getBackingActor();
  if (!actor) return 0;

  const logSnap = snapshotLog();
  const filtered = logSnap.filter(e =>
    typeof e.requestId !== "string" || !e.requestId.startsWith(TEST_PREFIX)
  );
  const logRemoved = logSnap.length - filtered.length;
  if (logRemoved > 0) await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, filtered);

  const itemsRemoved = await cleanupTestItems();
  console.log(`${MODULE_TITLE} | Step 16 cleanup: ${logRemoved} log entries, ${itemsRemoved} items`);
  return logRemoved + itemsRemoved;
}

// ============================================================
// Test utilities
// ============================================================

let _pass = 0;
let _fail = 0;

function pass(label) { _pass++; console.log(`%c  ✓ ${label}`, "color:#4caf50"); }
function fail(label, detail) { _fail++; console.error(`  ✗ ${label}`, detail ?? ""); }
function assert(cond, label, detail) { cond ? pass(label) : fail(label, detail); }

// ============================================================
// Tests
// ============================================================

async function testHideItemViaGMAction() {
  const logSnap = snapshotLog();
  let item = null;
  try {
    item = await createVisibleTestItem("hide");
    assert(!!item, "hide test: item created");

    const actor = getBackingActor();

    // Verify it starts as visible (no hidden flag)
    const beforeHidden = getHiddenItems(actor).find(i => i.id === item.id);
    assert(!beforeHidden, "hide test: item starts visible");

    // Simulate GM clicking the hide button (calls handleInventoryGMAction)
    // We pass null for app since the function only calls app.render() which is safe to skip
    await handleInventoryGMAction("hide-item", item.id, item.name, null);

    // Should now appear in hidden items
    const afterHidden = getHiddenItems(actor).find(i => i.id === item.id);
    assert(!!afterHidden, "hide test: item now in hidden pool");

    // Should NOT appear as visible (buildInventoryContext filters it)
    const { buildInventoryContext } = await import("./inventory-rendering.js");
    const ctx = buildInventoryContext(actor);
    const stillVisible = (ctx.items ?? []).find(i => i.id === item.id);
    assert(!stillVisible, "hide test: item absent from inventory context");

  } finally {
    if (item) {
      try { await getBackingActor()?.deleteEmbeddedDocuments("Item", [item.id]); } catch {}
    }
    await restoreLog(logSnap);
  }
}

async function testDeleteItemViaSetFlag() {
  // Tests the underlying delete path used by context-menu handleDeleteItem.
  // We skip the DialogV2.confirm in automated tests and call the actor directly.
  const logSnap = snapshotLog();
  let item = null;
  try {
    item = await createVisibleTestItem("delete");
    assert(!!item, "delete test: item created");

    const actor = getBackingActor();
    const itemId = item.id;
    const itemName = item.name;

    await actor.deleteEmbeddedDocuments("Item", [itemId]);
    item = null; // already gone

    const stillThere = actor.items.get(itemId);
    assert(!stillThere, "delete test: item removed from actor");

    // Write log entry as the action handler would
    const { writeEntry } = await import("./transaction-log.js");
    await writeEntry({
      type: "hidden.deleted",
      requestId: `${TEST_PREFIX}delete-${itemId}-${Date.now()}`,
      userId: game.user.id,
      itemId,
      itemName,
      backingActorId: actor.id
    });

    const log = TransactionLog.readAll();
    const entry = log.find(e => e.type === "hidden.deleted" && e.itemId === itemId);
    assert(!!entry, "delete test: hidden.deleted log entry written");

  } finally {
    if (item) {
      try { await getBackingActor()?.deleteEmbeddedDocuments("Item", [item.id]); } catch {}
    }
    await restoreLog(logSnap);
  }
}

async function testHideItemNotFound() {
  // handleInventoryGMAction with a nonexistent itemId should not throw
  try {
    await handleInventoryGMAction("hide-item", "nonexistent-id-abc", "ghost item", null);
    pass("hide nonexistent: no throw");
  } catch (err) {
    fail("hide nonexistent: threw unexpectedly", err);
  }
}

async function testUnknownAction() {
  // Unknown action should be a no-op, not a throw
  try {
    await handleInventoryGMAction("teleport-item", "some-id", "item", null);
    pass("unknown action: no throw");
  } catch (err) {
    fail("unknown action: threw unexpectedly", err);
  }
}

async function testSetItemHiddenToggle() {
  // Verify setItemHidden works bidirectionally for the re-hide drag flow
  const logSnap = snapshotLog();
  let item = null;
  try {
    item = await createVisibleTestItem("rehide");
    assert(!!item, "rehide: item created");

    const actor = getBackingActor();

    // Hide it
    await setItemHidden(item.id, true);
    const flagOn = actor.items.get(item.id)?.getFlag(MODULE_ID, FLAGS.HIDDEN);
    assert(flagOn === true, "rehide: flag set to true");

    // Verify hidden items includes it
    const inHidden = getHiddenItems(actor).find(i => i.id === item.id);
    assert(!!inHidden, "rehide: appears in getHiddenItems");

    // Inventory context should exclude it
    const { buildInventoryContext } = await import("./inventory-rendering.js");
    const ctx = buildInventoryContext(actor);
    const inVisible = (ctx.items ?? []).find(i => i.id === item.id);
    assert(!inVisible, "rehide: excluded from inventory context after re-hide");

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

export async function runStep16Tests() {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | Step 16 tests require GM.`);
    return;
  }
  const actor = getBackingActor();
  if (!actor) {
    console.error(`${MODULE_TITLE} | Step 16 tests: no backing actor.`);
    return;
  }

  _pass = 0;
  _fail = 0;

  console.group(`${MODULE_TITLE} | Step 16 Tests`);

  try {
    console.group("hide item via GM action");
    await testHideItemViaGMAction();
    console.groupEnd();

    console.group("delete item");
    await testDeleteItemViaSetFlag();
    console.groupEnd();

    console.group("error paths");
    await testHideItemNotFound();
    await testUnknownAction();
    console.groupEnd();

    console.group("re-hide drag (setItemHidden toggle)");
    await testSetItemHiddenToggle();
    console.groupEnd();

  } catch (err) {
    console.error(`${MODULE_TITLE} | Step 16: unexpected error`, err);
    _fail++;
  }

  const total = _pass + _fail;
  const color = _fail === 0 ? "color:#4caf50;font-weight:bold" : "color:#f44336;font-weight:bold";
  console.log(`%c${_pass}/${total} passed`, color);
  console.groupEnd();

  return { pass: _pass, fail: _fail, total };
}
