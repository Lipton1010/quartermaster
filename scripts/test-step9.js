/**
 * Quartermaster — Step 9 Test Harness
 *
 * Integration tests for the drag-drop → socket → coordinator → Claim-and-Commit
 * pipeline. Drag and drop events can't be reliably simulated in JS, so we
 * test the layer just below: `submitRequest` with `ITEM_TRANSFER` payloads,
 * which is exactly what the drag-drop module produces.
 *
 * Setup pattern matches step 8: create temporary fixture actors marked with
 * a flag, exercise the pipeline, clean up at the end. Test transaction log
 * entries use a prefix so the cleanup helper can find them.
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep9Tests();
 *
 * If a run is interrupted and leaves fixtures behind:
 *   await game.modules.get("quartermaster").api.test.cleanupStep9Fixtures();
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { PAYLOAD_TYPES, submitRequest } from "./socket-handler.js";
import * as TransactionLog from "./transaction-log.js";

const TEST_FIXTURE_FLAG = "step9TestFixture";
const TEST_REQUEST_PREFIX = "qm-step9-test-";

// ============================================================
// Fixture creation / teardown
// ============================================================

async function createTestActor(name) {
  return await Actor.create({
    name,
    type: "character",
    flags: { [MODULE_ID]: { [TEST_FIXTURE_FLAG]: true } }
  });
}

async function addTestItem(actor, name = "Step 9 Test Sword") {
  const [created] = await actor.createEmbeddedDocuments("Item", [{
    name,
    type: "weapon",
    img: "icons/weapons/swords/sword-broad-steel.webp",
    system: {
      quantity: 1,
      weight: { value: 3, units: "lb" },
      equipped: true,
      rarity: "common",
      damage: { parts: [["1d8", "slashing"]] }
    }
  }]);
  return created;
}

export async function cleanupStep9Fixtures() {
  const testActors = game.actors.filter(a => a.getFlag(MODULE_ID, TEST_FIXTURE_FLAG));
  if (testActors.length > 0) {
    await Actor.deleteDocuments(testActors.map(a => a.id));
  }

  const backingActor = getBackingActor();
  if (backingActor && game.user.isGM) {
    // Remove any items left on the backing actor that came from step 9 tests
    const stragglers = backingActor.items.filter(i =>
      i.name?.startsWith("Step 9 Test")
    );
    if (stragglers.length > 0) {
      await backingActor.deleteEmbeddedDocuments(
        "Item",
        stragglers.map(i => i.id)
      );
    }

    // Trim test transaction log entries
    const log = TransactionLog.readAll();
    const filtered = log.filter(e =>
      typeof e.requestId !== "string" || !e.requestId.startsWith(TEST_REQUEST_PREFIX)
    );
    if (filtered.length !== log.length) {
      await backingActor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, filtered);
    }
  }

  console.log(
    `${MODULE_TITLE} | Step 9 cleanup: removed ${testActors.length} test actors`
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
// Tests
// ============================================================

export async function runStep9Tests() {
  if (!game.user.isGM) {
    console.error(`${MODULE_TITLE} | Step 9 tests must be run by a GM (mutates actors)`);
    return [];
  }

  const t = makeTestContext();
  const backingActor = getBackingActor();
  if (!backingActor) {
    console.error(`${MODULE_TITLE} | No backing actor available; tests aborted`);
    return [];
  }

  // -------------------------------------------------------
  // Section 1: ingress (player → bag) through submitRequest
  // -------------------------------------------------------
  const player1 = await createTestActor("QM_Step9_Player_Ingress");
  try {
    const item = await addTestItem(player1, "Step 9 Test Sword Ingress");
    const requestId = `${TEST_REQUEST_PREFIX}ingress-${Date.now()}`;

    t.assertEq("Ingress: player has 1 item before transfer",
      player1.items.size, 1);
    const bagItemCountBefore = backingActor.items.size;

    const result = await submitRequest({
      type: PAYLOAD_TYPES.ITEM_TRANSFER,
      requestId,
      timestamp: Date.now(),
      userId: game.user.id,
      action: "ingress",
      payload: {
        sourceActorId: player1.id,
        sourceItemId: item.id,
        sourceItemUuid: item.uuid,
        destActorId: backingActor.id
      }
    });

    t.assertEq("Ingress: response status is success",
      result?.status, "success");
    t.assert("Ingress: resultData.direction is ingress",
      result?.resultData?.direction === "ingress");
    t.assertEq("Ingress: player has 0 items after transfer",
      player1.items.size, 0);
    t.assertEq("Ingress: bag has +1 item after transfer",
      backingActor.items.size, bagItemCountBefore + 1);

    const movedItem = backingActor.items.find(i => i.name === "Step 9 Test Sword Ingress");
    t.assert("Ingress: moved item exists on bag with correct name",
      movedItem !== undefined);
    t.assertEq("Ingress: moved item equipped state reset",
      movedItem?.system?.equipped, false);
  } finally {
    await player1.delete();
  }

  // -------------------------------------------------------
  // Section 2: egress (bag → player) through submitRequest
  // -------------------------------------------------------
  const player2 = await createTestActor("QM_Step9_Player_Egress");
  try {
    // Seed the bag with a test item directly
    const [bagItem] = await backingActor.createEmbeddedDocuments("Item", [{
      name: "Step 9 Test Sword Egress",
      type: "weapon",
      img: "icons/weapons/swords/sword-broad-steel.webp",
      system: { quantity: 1, weight: { value: 3, units: "lb" } }
    }]);
    const requestId = `${TEST_REQUEST_PREFIX}egress-${Date.now()}`;

    t.assertEq("Egress: player has 0 items before transfer",
      player2.items.size, 0);

    const result = await submitRequest({
      type: PAYLOAD_TYPES.ITEM_TRANSFER,
      requestId,
      timestamp: Date.now(),
      userId: game.user.id,
      action: "egress",
      payload: {
        sourceActorId: backingActor.id,
        sourceItemId: bagItem.id,
        sourceItemUuid: bagItem.uuid,
        destActorId: player2.id
      }
    });

    t.assertEq("Egress: response status is success",
      result?.status, "success");
    t.assert("Egress: resultData.direction is egress",
      result?.resultData?.direction === "egress");
    t.assertEq("Egress: player has 1 item after transfer",
      player2.items.size, 1);

    const receivedItem = player2.items.contents[0];
    t.assertEq("Egress: received item name preserved",
      receivedItem.name, "Step 9 Test Sword Egress");

    // Bag should no longer have the item
    const bagHas = backingActor.items.get(bagItem.id);
    t.assert("Egress: bag no longer has the item",
      bagHas === undefined);
  } finally {
    await player2.delete();
  }

  // -------------------------------------------------------
  // Section 3: error handling
  // -------------------------------------------------------

  // 3a. Unknown source actor
  const r3a = await submitRequest({
    type: PAYLOAD_TYPES.ITEM_TRANSFER,
    requestId: `${TEST_REQUEST_PREFIX}bad-src-${Date.now()}`,
    timestamp: Date.now(),
    userId: game.user.id,
    action: "ingress",
    payload: {
      sourceActorId: "nonexistent-actor-id",
      sourceItemId: "nonexistent-item-id",
      destActorId: backingActor.id
    }
  });
  t.assertEq("Error: unknown source actor returns clean failure",
    r3a?.error, "source-actor-not-found");

  // 3b. Unknown destination actor
  const player3 = await createTestActor("QM_Step9_Player_BadDest");
  try {
    const item = await addTestItem(player3, "Step 9 Test BadDest");
    const r3b = await submitRequest({
      type: PAYLOAD_TYPES.ITEM_TRANSFER,
      requestId: `${TEST_REQUEST_PREFIX}bad-dest-${Date.now()}`,
      timestamp: Date.now(),
      userId: game.user.id,
      action: "ingress",
      payload: {
        sourceActorId: player3.id,
        sourceItemId: item.id,
        destActorId: "nonexistent-dest-id"
      }
    });
    t.assertEq("Error: unknown destination actor returns clean failure",
      r3b?.error, "destination-actor-not-found");
    t.assertEq("Error: source item still present after failed transfer",
      player3.items.size, 1);
  } finally {
    await player3.delete();
  }

  // 3c. Unknown action
  const r3c = await submitRequest({
    type: PAYLOAD_TYPES.ITEM_TRANSFER,
    requestId: `${TEST_REQUEST_PREFIX}bad-action-${Date.now()}`,
    timestamp: Date.now(),
    userId: game.user.id,
    action: "teleport",
    payload: {
      sourceActorId: backingActor.id,
      sourceItemId: "anything",
      destActorId: backingActor.id
    }
  });
  t.assertEq("Error: unknown action returns clean failure",
    r3c?.error, "unknown-action");

  // -------------------------------------------------------
  // Section 4: idempotency through the pipeline
  // -------------------------------------------------------
  const player4 = await createTestActor("QM_Step9_Player_Idem");
  try {
    const item = await addTestItem(player4, "Step 9 Test Idempotent");
    const requestId = `${TEST_REQUEST_PREFIX}idem-${Date.now()}`;

    const r4a = await submitRequest({
      type: PAYLOAD_TYPES.ITEM_TRANSFER,
      requestId,
      timestamp: Date.now(),
      userId: game.user.id,
      action: "ingress",
      payload: {
        sourceActorId: player4.id,
        sourceItemId: item.id,
        destActorId: backingActor.id
      }
    });

    t.assertEq("Idempotent: first call succeeds",
      r4a?.status, "success");

    const bagCountAfterFirst = backingActor.items.size;

    // Second call with same requestId — should be deduped by coordinator
    const r4b = await submitRequest({
      type: PAYLOAD_TYPES.ITEM_TRANSFER,
      requestId,
      timestamp: Date.now(),
      userId: game.user.id,
      action: "ingress",
      payload: {
        sourceActorId: player4.id,
        sourceItemId: item.id,  // already gone from player4
        destActorId: backingActor.id
      }
    });

    t.assert("Idempotent: second call returns cached result",
      r4b?.fromCache === true);
    t.assertEq("Idempotent: bag count unchanged by duplicate call",
      backingActor.items.size, bagCountAfterFirst);
  } finally {
    await player4.delete();
  }

  // Cleanup any items left on the backing actor from these tests
  await cleanupStep9Fixtures();

  printResults(`${MODULE_TITLE} | Step 9 Tests`, t.results);
  return t.results;
}
