/**
 * Quartermaster — Step 18 Test Harness
 *
 * Tests for compendium import: importCompendiumItem function for both
 * visible and hidden paths, plus transaction log entries.
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep18Tests();
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { importCompendiumItem } from "./drag-drop.js";
import { getHiddenItems } from "./hidden-items.js";
import * as TransactionLog from "./transaction-log.js";

// ============================================================
// Helpers
// ============================================================

let _pass = 0;
let _fail = 0;

function pass(label) { _pass++; console.log(`%c  ✓ ${label}`, "color:#4caf50"); }
function fail(label, detail) { _fail++; console.error(`  ✗ ${label}`, detail ?? ""); }
function assert(cond, label, detail) { cond ? pass(label) : fail(label, detail); }

function snapshotLog() {
  return TransactionLog.readAll().map(e => ({ ...e }));
}

async function restoreLog(snapshot) {
  const actor = getBackingActor();
  if (actor) await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, snapshot);
}

/**
 * Create a minimal synthetic item to simulate a compendium item.
 * We can't easily pull from an actual compendium in tests (pack may not
 * exist), so we create a fake Item-like object with toObject().
 */
function makeFakeCompendiumItem(name) {
  return {
    name,
    type: "loot",
    img: "icons/svg/item-bag.svg",
    documentName: "Item",
    uuid: `Compendium.test.items.Item.fake-${Date.now()}`,
    toObject() {
      return {
        name: this.name,
        type: this.type,
        img: this.img,
        system: {}
      };
    }
  };
}

async function cleanupTestItems() {
  const actor = getBackingActor();
  if (!actor) return 0;
  const items = actor.items
    .filter(i => (i.name ?? "").startsWith("QM-TEST-STEP18-"))
    .map(i => i.id);
  if (items.length) await actor.deleteEmbeddedDocuments("Item", items);
  return items.length;
}

export async function cleanupStep18Fixtures() {
  if (!game.user.isGM) return 0;
  const logSnap = snapshotLog();
  const filtered = logSnap.filter(e =>
    typeof e.requestId !== "string" || !e.requestId.startsWith("qm-import-")
  );
  const logRemoved = logSnap.length - filtered.length;
  if (logRemoved > 0) {
    const actor = getBackingActor();
    if (actor) await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, filtered);
  }
  const itemsRemoved = await cleanupTestItems();
  console.log(`${MODULE_TITLE} | Step 18 cleanup: ${logRemoved} log entries, ${itemsRemoved} items`);
  return logRemoved + itemsRemoved;
}

// ============================================================
// Tests
// ============================================================

async function testImportVisible() {
  const logSnap = snapshotLog();
  let createdId = null;
  try {
    const actor = getBackingActor();
    const fakeItem = makeFakeCompendiumItem("QM-TEST-STEP18-visible");

    const result = await importCompendiumItem(fakeItem, actor, { hidden: false });
    assert(result.status === "success", "import visible: status success", result);
    assert(!!result.item, "import visible: returned created item");
    createdId = result.item?.id;

    // Item should be on the actor, NOT hidden
    const doc = actor.items.get(createdId);
    assert(!!doc, "import visible: item exists on actor");
    const hiddenFlag = doc?.getFlag(MODULE_ID, FLAGS.HIDDEN);
    assert(!hiddenFlag, "import visible: not hidden");

    // Should appear in inventory context
    const { buildInventoryContext } = await import("./inventory-rendering.js");
    const ctx = buildInventoryContext(actor);
    const found = (ctx.items ?? []).find(i => i.id === createdId);
    assert(!!found, "import visible: appears in inventory context");

    // Log entry should be import.direct
    const log = TransactionLog.readAll();
    const entry = log.find(e => e.type === "import.direct" && e.itemId === createdId);
    assert(!!entry, "import visible: import.direct log entry written");

  } finally {
    if (createdId) {
      try { await getBackingActor()?.deleteEmbeddedDocuments("Item", [createdId]); } catch {}
    }
    await restoreLog(logSnap);
  }
}

async function testImportHidden() {
  const logSnap = snapshotLog();
  let createdId = null;
  try {
    const actor = getBackingActor();
    const fakeItem = makeFakeCompendiumItem("QM-TEST-STEP18-hidden");

    const result = await importCompendiumItem(fakeItem, actor, { hidden: true });
    assert(result.status === "success", "import hidden: status success", result);
    createdId = result.item?.id;

    // Item should be on the actor WITH hidden flag
    const doc = actor.items.get(createdId);
    assert(!!doc, "import hidden: item exists on actor");
    const hiddenFlag = doc?.getFlag(MODULE_ID, FLAGS.HIDDEN);
    assert(hiddenFlag === true, "import hidden: hidden flag set");

    // Should appear in getHiddenItems
    const hidden = getHiddenItems(actor);
    const inHidden = hidden.find(i => i.id === createdId);
    assert(!!inHidden, "import hidden: appears in getHiddenItems");

    // Should NOT appear in inventory context
    const { buildInventoryContext } = await import("./inventory-rendering.js");
    const ctx = buildInventoryContext(actor);
    const inVisible = (ctx.items ?? []).find(i => i.id === createdId);
    assert(!inVisible, "import hidden: excluded from inventory context");

    // Log entry should be hidden.staged
    const log = TransactionLog.readAll();
    const entry = log.find(e => e.type === "hidden.staged" && e.itemId === createdId);
    assert(!!entry, "import hidden: hidden.staged log entry written");

  } finally {
    if (createdId) {
      try { await getBackingActor()?.deleteEmbeddedDocuments("Item", [createdId]); } catch {}
    }
    await restoreLog(logSnap);
  }
}

async function testImportMissingArgs() {
  const r1 = await importCompendiumItem(null, getBackingActor(), {});
  assert(r1.status === "failed", "import null item: status failed");
  assert(r1.error === "missing-arguments", "import null item: correct error");

  const fakeItem = makeFakeCompendiumItem("QM-TEST-STEP18-no-actor");
  const r2 = await importCompendiumItem(fakeItem, null, {});
  assert(r2.status === "failed", "import null actor: status failed");
  assert(r2.error === "missing-arguments", "import null actor: correct error");
}

// ============================================================
// Runner
// ============================================================

export async function runStep18Tests() {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | Step 18 tests require GM.`);
    return;
  }
  const actor = getBackingActor();
  if (!actor) {
    console.error(`${MODULE_TITLE} | Step 18 tests: no backing actor.`);
    return;
  }

  _pass = 0;
  _fail = 0;

  console.group(`${MODULE_TITLE} | Step 18 Tests`);

  try {
    console.group("import visible");
    await testImportVisible();
    console.groupEnd();

    console.group("import hidden");
    await testImportHidden();
    console.groupEnd();

    console.group("error paths");
    await testImportMissingArgs();
    console.groupEnd();

  } catch (err) {
    console.error(`${MODULE_TITLE} | Step 18: unexpected error`, err);
    _fail++;
  }

  const total = _pass + _fail;
  const color = _fail === 0 ? "color:#4caf50;font-weight:bold" : "color:#f44336;font-weight:bold";
  console.log(`%c${_pass}/${total} passed`, color);
  console.groupEnd();

  return { pass: _pass, fail: _fail, total };
}
