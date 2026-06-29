/**
 * Quartermaster — Step 8 Test Harness
 *
 * Tests for the weight cache and the claim-and-commit transfer engine.
 *
 * Unlike step 7's pure-function tests, step 8 mutates real Foundry actors.
 * The harness creates two temporary test actors, runs operations, and
 * cleans up after itself. Test fixtures are marked with a flag so the
 * cleanup helper can find them.
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep8Tests();
 *
 * If a test run is interrupted and leaves fixtures behind, run:
 *   await game.modules.get("quartermaster").api.test.cleanupStep8Fixtures();
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import * as WeightCache from "./weight-cache.js";
import * as ClaimCommit from "./claim-commit.js";
import * as TransactionLog from "./transaction-log.js";

const TEST_FIXTURE_FLAG = "step8TestFixture";
const TEST_REQUEST_PREFIX = "qm-step8-test-";

// ============================================================
// Test fixture creation and teardown
// ============================================================

async function createTestActor(name) {
  const actorData = {
    name,
    type: "character",
    flags: { [MODULE_ID]: { [TEST_FIXTURE_FLAG]: true } }
  };
  return await Actor.create(actorData);
}

async function addTestItem(actor, overrides = {}) {
  const itemData = {
    name: "Test Sword +1",
    type: "weapon",
    img: "icons/weapons/swords/sword-broad-steel.webp",
    system: {
      quantity: 1,
      weight: { value: 3, units: "lb" },
      equipped: true,
      // dnd5e v5 schema: attunement is a string requirement, attuned is
      // the boolean state. v3 used a single numeric attunement (0/1/2).
      // We set both so the test exercises sanitization regardless of which
      // system version is active.
      attuned: true,
      attunement: "required",
      damage: { parts: [["1d8 + 1", "slashing"]] },
      rarity: "uncommon"
    },
    ...overrides
  };
  const [created] = await actor.createEmbeddedDocuments("Item", [itemData]);
  return created;
}

export async function cleanupStep8Fixtures() {
  // Remove temp actors
  const testActors = game.actors.filter(a => a.getFlag(MODULE_ID, TEST_FIXTURE_FLAG));
  if (testActors.length > 0) {
    await Actor.deleteDocuments(testActors.map(a => a.id));
  }

  // Remove test entries from transaction log
  const log = TransactionLog.readAll();
  const filtered = log.filter(e =>
    typeof e.requestId !== "string" || !e.requestId.startsWith(TEST_REQUEST_PREFIX)
  );
  if (filtered.length !== log.length) {
    const actor = getBackingActor();
    if (actor && game.user.isGM) {
      await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, filtered);
    }
  }

  console.log(
    `${MODULE_TITLE} | Step 8 cleanup: removed ${testActors.length} test actors`
  );
  return testActors.length;
}

// ============================================================
// Test runner infrastructure
// ============================================================

function makeTestContext() {
  const results = [];
  return {
    results,
    assert(name, condition, details = null) {
      results.push({ name, pass: Boolean(condition), details });
    },
    assertEq(name, actual, expected) {
      const pass = JSON.stringify(actual) === JSON.stringify(expected);
      results.push({
        name,
        pass,
        details: pass ? null : { actual, expected }
      });
    }
  };
}

function printResults(label, results) {
  console.group(`%c${label}`, "font-weight: bold; color: #c9a96e;");
  for (const r of results) {
    if (r.pass) {
      console.log(`%c✓%c ${r.name}`, "color: #4caf50;", "color: inherit;");
    } else {
      console.error(`✗ ${r.name}`, r.details ?? "");
    }
  }
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const all = passed === total;
  console.log(
    `%c${passed}/${total} ${all ? "passed" : "PASSED, " + (total - passed) + " FAILED"}`,
    `font-weight: bold; color: ${all ? "#4caf50" : "#c0392b"};`
  );
  console.groupEnd();
}

// ============================================================
// Weight cache tests
// ============================================================

async function runWeightCacheTests(t) {
  // Clean slate
  WeightCache.invalidateAll();
  t.assertEq("Cache starts empty after invalidateAll", WeightCache.size(), 0);

  // Create test actor with two items
  const actor = await createTestActor("QM_WeightCache_Test");
  try {
    await actor.createEmbeddedDocuments("Item", [
      {
        name: "Heavy Anvil",
        type: "loot",
        system: { quantity: 2, weight: { value: 50, units: "lb" } }
      },
      {
        name: "Light Feather",
        type: "loot",
        system: { quantity: 10, weight: { value: 0.01, units: "lb" } }
      }
    ]);
    await actor.update({
      "system.currency.gp": 100,
      "system.currency.sp": 50
    });

    // Test 1: cache miss → compute → populate
    t.assertEq(
      "Cache empty before first read",
      WeightCache.peek(actor.id),
      null
    );

    const totals = WeightCache.getRawTotals(actor);
    t.assertEq("First read computes itemWeight correctly",
      totals.itemWeight,
      (50 * 2) + (0.01 * 10)  // 100 + 0.1 = 100.1
    );
    t.assertEq("First read computes coinSum correctly",
      totals.coinSum, 150
    );
    t.assertEq("First read computes coinValues correctly",
      totals.coinValues,
      { pp: 0, gp: 100, ep: 0, sp: 50, cp: 0 }
    );

    // Test 2: cache hit returns same reference
    const second = WeightCache.getRawTotals(actor);
    t.assert("Second read returns cached object (same reference)",
      second === totals
    );
    t.assertEq("Cache size is 1 after reading one actor",
      WeightCache.size(), 1
    );

    // Test 3: invalidation on item create
    await actor.createEmbeddedDocuments("Item", [{
      name: "Extra Anvil",
      type: "loot",
      system: { quantity: 1, weight: { value: 50, units: "lb" } }
    }]);
    t.assertEq("Cache invalidated after createItem",
      WeightCache.peek(actor.id), null
    );

    const afterCreate = WeightCache.getRawTotals(actor);
    t.assertEq("itemWeight recomputed after create",
      afterCreate.itemWeight,
      (50 * 2) + (0.01 * 10) + 50  // 150.1
    );

    // Test 4: hidden/staged items do not count toward shared inventory weight
    const [hiddenAnvil] = await actor.createEmbeddedDocuments("Item", [{
      name: "Hidden Platinum Anvil",
      type: "loot",
      system: { quantity: 4, weight: { value: 200, units: "lb" } },
      flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } }
    }]);
    t.assertEq("Cache invalidated after hidden item create",
      WeightCache.peek(actor.id), null
    );
    const withHidden = WeightCache.getRawTotals(actor);
    t.assertEq("Hidden items are excluded from itemWeight",
      withHidden.itemWeight,
      (50 * 2) + (0.01 * 10) + 50
    );

    await hiddenAnvil.unsetFlag(MODULE_ID, FLAGS.HIDDEN);
    t.assertEq("Cache invalidated after revealing hidden item",
      WeightCache.peek(actor.id), null
    );
    const afterReveal = WeightCache.getRawTotals(actor);
    t.assertEq("Revealed item is included in itemWeight",
      afterReveal.itemWeight,
      (50 * 2) + (0.01 * 10) + 50 + (200 * 4)
    );

    await actor.deleteEmbeddedDocuments("Item", [hiddenAnvil.id]);
    WeightCache.getRawTotals(actor);

    // Test 5: invalidation on item update
    const anItem = actor.items.find(i => i.name === "Heavy Anvil");
    await anItem.update({ "system.quantity": 3 });
    t.assertEq("Cache invalidated after updateItem",
      WeightCache.peek(actor.id), null
    );

    // Test 6: invalidation on item delete
    WeightCache.getRawTotals(actor);  // re-populate
    const toDelete = actor.items.find(i => i.name === "Light Feather");
    await actor.deleteEmbeddedDocuments("Item", [toDelete.id]);
    t.assertEq("Cache invalidated after deleteItem",
      WeightCache.peek(actor.id), null
    );

    // Test 7: invalidation on currency change
    WeightCache.getRawTotals(actor);  // re-populate
    await actor.update({ "system.currency.gp": 200 });
    t.assertEq("Cache invalidated after currency update",
      WeightCache.peek(actor.id), null
    );

    // Test 8: invalidation on non-currency actor update does NOT invalidate
    WeightCache.getRawTotals(actor);  // re-populate
    await actor.update({ name: "Renamed Test Actor" });
    t.assert("Cache NOT invalidated on non-currency actor update",
      WeightCache.peek(actor.id) !== null
    );

    // Test 9: recomputeTotals always recomputes
    const beforeRecompute = WeightCache.getRawTotals(actor);
    const recomputed = WeightCache.recomputeTotals(actor);
    t.assert("recomputeTotals returns a new object",
      recomputed !== beforeRecompute
    );
    t.assertEq("recomputeTotals values match getRawTotals",
      recomputed,
      beforeRecompute  // values equal even if reference differs
    );

    // Test 10: invalidateActor returns boolean
    t.assert("invalidateActor returns true when entry existed",
      WeightCache.invalidateActor(actor.id) === true
    );
    t.assert("invalidateActor returns false when no entry",
      WeightCache.invalidateActor(actor.id) === false
    );

    // Test 11: actor with no items has zero itemWeight
    const emptyActor = await createTestActor("QM_WeightCache_Empty");
    try {
      const emptyTotals = WeightCache.getRawTotals(emptyActor);
      t.assertEq("Empty actor itemWeight is 0", emptyTotals.itemWeight, 0);
      t.assertEq("Empty actor coinSum is 0", emptyTotals.coinSum, 0);
    } finally {
      await emptyActor.delete();
    }

  } finally {
    await actor.delete();
  }
}

// ============================================================
// Claim-and-commit tests
// ============================================================

async function runClaimCommitTests(t) {
  // Snapshot transaction log size before tests
  const logSizeBefore = TransactionLog.count();

  // --- Egress test: bag → player ---
  const bag = await createTestActor("QM_Bag_Test");
  const player = await createTestActor("QM_Player_Test");

  try {
    const sourceItem = await addTestItem(bag, { name: "Egress Test Sword" });
    const requestId = `${TEST_REQUEST_PREFIX}egress-${Date.now()}`;

    // Pre-state assertions
    t.assertEq("Egress: bag has 1 item before transfer",
      bag.items.size, 1
    );
    t.assertEq("Egress: player has 0 items before transfer",
      player.items.size, 0
    );

    // Run egress
    const result = await ClaimCommit.performEgress({
      sourceItem,
      destActor: player,
      requestId
    });

    // Result assertions
    t.assert("Egress: success result", result.success === true);
    t.assertEq("Egress: direction in result", result.direction, "egress");
    t.assert("Egress: destItemId is a 16-char string",
      typeof result.destItemId === "string" && result.destItemId.length === 16
    );

    // Post-state assertions
    t.assertEq("Egress: bag has 0 items after transfer",
      bag.items.size, 0
    );
    t.assertEq("Egress: player has 1 item after transfer",
      player.items.size, 1
    );

    const moved = player.items.contents[0];
    t.assertEq("Egress: moved item has predicted _id",
      moved.id, result.destItemId
    );
    t.assertEq("Egress: moved item retains name", moved.name, "Egress Test Sword");

    // Sanitization verification
    t.assertEq("Egress: equipped reset to false on destination",
      moved.system.equipped, false
    );
    // Schema-defensive attunement check: v3 used attunement: 2,
    // v5 uses attuned: true. Either way, the destination must not be
    // in an "attuned by owner" state.
    const stillAttuned = moved.system.attuned === true
                      || moved.system.attunement === 2;
    t.assert("Egress: attuned state cleared on destination",
      !stillAttuned
    );

    // Transaction log assertions
    const trace = ClaimCommit.getTransferTrace(requestId);
    t.assert("Egress: claim entry present",
      trace.claim !== null && trace.claim.type === ClaimCommit.LOG_TYPES.EGRESS_CLAIM
    );
    t.assert("Egress: commit entry present",
      trace.commit !== null && trace.commit.type === ClaimCommit.LOG_TYPES.EGRESS_COMMIT
    );
    t.assertEq("Egress: no failure entries",
      trace.failures.length, 0
    );
    t.assertEq("Egress: claim records itemData",
      trace.claim.itemData?.name, "Egress Test Sword"
    );
    t.assert("Egress: commit confirms predicted _id matched",
      trace.commit.matchesPredictedId === true
    );

  } finally {
    await bag.delete();
    await player.delete();
  }

  // --- Ingress test: player → bag ---
  const bag2 = await createTestActor("QM_Bag_Test_2");
  const player2 = await createTestActor("QM_Player_Test_2");

  try {
    const sourceItem = await addTestItem(player2, { name: "Ingress Test Sword" });
    const requestId = `${TEST_REQUEST_PREFIX}ingress-${Date.now()}`;

    t.assertEq("Ingress: bag empty before transfer", bag2.items.size, 0);
    t.assertEq("Ingress: player has 1 item before transfer", player2.items.size, 1);

    const result = await ClaimCommit.performIngress({
      sourceItem,
      destActor: bag2,
      requestId
    });

    t.assert("Ingress: success result", result.success === true);
    t.assertEq("Ingress: direction in result", result.direction, "ingress");
    t.assertEq("Ingress: bag has 1 item after", bag2.items.size, 1);
    t.assertEq("Ingress: player has 0 items after", player2.items.size, 0);

    const trace = ClaimCommit.getTransferTrace(requestId);
    t.assert("Ingress: claim entry present",
      trace.claim?.type === ClaimCommit.LOG_TYPES.INGRESS_CLAIM
    );
    t.assert("Ingress: commit entry present",
      trace.commit?.type === ClaimCommit.LOG_TYPES.INGRESS_COMMIT
    );
    t.assertEq("Ingress: no failures",
      trace.failures.length, 0
    );

  } finally {
    await bag2.delete();
    await player2.delete();
  }

  // --- Input validation tests ---
  let threw = false;
  try {
    await ClaimCommit.performEgress({ destActor: {}, requestId: "x" });
  } catch { threw = true; }
  t.assert("performEgress throws on missing sourceItem", threw);

  threw = false;
  try {
    await ClaimCommit.performEgress({ sourceItem: {}, requestId: "x" });
  } catch { threw = true; }
  t.assert("performEgress throws on missing destActor", threw);

  threw = false;
  try {
    await ClaimCommit.performEgress({ sourceItem: {}, destActor: { id: "x" } });
  } catch { threw = true; }
  t.assert("performEgress throws on missing requestId", threw);

  // Log integrity check
  t.assert("Transaction log grew by expected count",
    TransactionLog.count() > logSizeBefore
  );

  // Cleanup test log entries
  await cleanupStep8Fixtures();
}

// ============================================================
// Main entry point
// ============================================================

export async function runStep8Tests() {
  if (!game.user.isGM) {
    console.error(`${MODULE_TITLE} | Step 8 tests must be run by a GM (mutates actors)`);
    return [];
  }

  const t = makeTestContext();

  console.log(`${MODULE_TITLE} | Step 8 tests: weight cache phase`);
  await runWeightCacheTests(t);

  console.log(`${MODULE_TITLE} | Step 8 tests: claim-and-commit phase`);
  await runClaimCommitTests(t);

  printResults(`${MODULE_TITLE} | Step 8 Tests`, t.results);
  return t.results;
}
