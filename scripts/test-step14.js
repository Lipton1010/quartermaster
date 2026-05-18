/**
 * Quartermaster — Step 14 Test Harness
 *
 * Tests for custom resources: CRUD on the backing actor flag, applyDelta
 * validation (bounds, missing resource, invalid input), idempotency
 * through the socket pipeline, and transaction log entry shape.
 *
 * Each test snapshots the resources flag before mutating and restores
 * afterward; the suite leaves no persistent change to your real
 * resources.
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep14Tests();
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import * as Resources from "./resources.js";
import { PAYLOAD_TYPES, submitRequest } from "./socket-handler.js";
import * as TransactionLog from "./transaction-log.js";

const TEST_REQUEST_PREFIX = "qm-step14-test-";

// ============================================================
// Snapshot / restore
// ============================================================

function snapshotResources() {
  const actor = getBackingActor();
  const raw = actor?.getFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES);
  return Array.isArray(raw) ? structuredClone(raw) : [];
}

async function restoreResources(snapshot) {
  const actor = getBackingActor();
  if (!actor) return;
  await actor.setFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES, snapshot);
}

export async function cleanupStep14Fixtures() {
  if (!game.user.isGM) return 0;
  const actor = getBackingActor();
  if (!actor) return 0;

  const log = TransactionLog.readAll();
  const filtered = log.filter(e =>
    typeof e.requestId !== "string" || !e.requestId.startsWith(TEST_REQUEST_PREFIX)
  );
  const removed = log.length - filtered.length;
  if (removed > 0) {
    await actor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, filtered);
  }
  console.log(
    `${MODULE_TITLE} | Step 14 cleanup: removed ${removed} test log entries`
  );
  return removed;
}

// ============================================================
// Test runner
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
      results.push({ name, pass, details: pass ? null : { actual, expected } });
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

export async function runStep14Tests() {
  if (!game.user.isGM) {
    console.error(`${MODULE_TITLE} | Step 14 tests must be run by a GM`);
    return [];
  }

  const t = makeTestContext();
  const snapshot = snapshotResources();

  try {
    // -----------------------------------------------------
    // CRUD
    // -----------------------------------------------------
    const r1 = await Resources.createResource({
      name: "Test Healing Charges",
      icon: "icons/svg/blood.svg",
      value: 5,
      max: 10,
      description: "Test resource for step 14"
    });
    t.assert("create: returns the new resource", r1 != null);
    t.assertEq("create: name set", r1?.name, "Test Healing Charges");
    t.assertEq("create: value set", r1?.value, 5);
    t.assertEq("create: max set", r1?.max, 10);

    const list1 = Resources.getResources();
    t.assert("getResources: contains created resource",
      list1.some(r => r.id === r1.id));

    const got = Resources.getResource(r1.id);
    t.assertEq("getResource: by id returns the same resource",
      got?.id, r1.id);

    // Create with no max
    const r2 = await Resources.createResource({
      name: "Test Unbounded",
      value: 0
    });
    t.assertEq("create: max null when not provided", r2?.max, null);
    t.assert("create: icon defaults when not provided",
      typeof r2?.icon === "string" && r2.icon.length > 0);

    // Update
    const updated = await Resources.updateResource(r1.id, {
      name: "Renamed",
      value: 7
    });
    t.assertEq("update: name changed", updated?.name, "Renamed");
    t.assertEq("update: value changed", updated?.value, 7);
    t.assertEq("update: max preserved when not in changes",
      updated?.max, 10);

    // Update with max below current value clamps down
    const clamped = await Resources.updateResource(r1.id, { max: 3 });
    t.assertEq("update: value clamped to new max",
      clamped?.value, 3);
    t.assertEq("update: max set", clamped?.max, 3);

    // -----------------------------------------------------
    // applyDelta
    // -----------------------------------------------------
    const addResult = await Resources.applyDelta(r1.id, 1);
    t.assertEq("applyDelta(+1): status success",
      addResult.status, "success");
    t.assertEq("applyDelta(+1): newValue increased",
      addResult.resultData?.newValue, 4);

    const removeResult = await Resources.applyDelta(r1.id, -2);
    t.assertEq("applyDelta(-2): status success",
      removeResult.status, "success");
    t.assertEq("applyDelta(-2): newValue decreased",
      removeResult.resultData?.newValue, 2);

    // Insufficient resource
    const insufficient = await Resources.applyDelta(r1.id, -100);
    t.assertEq("applyDelta(huge negative): insufficient-resource error",
      insufficient.error, "insufficient-resource");

    // Bring back to 0 first
    await Resources.updateResource(r1.id, { value: 0 });
    const maxExceeded = await Resources.applyDelta(r1.id, 100);
    t.assertEq("applyDelta(beyond max): max-exceeded error",
      maxExceeded.error, "max-exceeded");

    // Zero delta is noop success
    const noop = await Resources.applyDelta(r1.id, 0);
    t.assertEq("applyDelta(0): status success", noop.status, "success");
    t.assert("applyDelta(0): noop flag", noop.resultData?.noop === true);

    // Invalid delta
    const badDelta = await Resources.applyDelta(r1.id, "not-a-number");
    t.assertEq("applyDelta(string): invalid-delta error",
      badDelta.error, "invalid-delta");

    // Resource not found
    const notFound = await Resources.applyDelta("does-not-exist", 1);
    t.assertEq("applyDelta(unknown id): resource-not-found error",
      notFound.error, "resource-not-found");

    // -----------------------------------------------------
    // Socket pipeline + transaction log
    // -----------------------------------------------------
    await Resources.updateResource(r1.id, { max: 100, value: 50 });

    const pipelineAdd = await submitRequest({
      type: PAYLOAD_TYPES.CUSTOM_RESOURCE_CHANGE,
      requestId: `${TEST_REQUEST_PREFIX}pipe-add-${Date.now()}`,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { resourceId: r1.id, delta: 10 }
    });
    t.assertEq("pipeline: add via socket success",
      pipelineAdd?.status, "success");
    t.assertEq("pipeline: actor reflects new value",
      Resources.getResource(r1.id)?.value, 60);

    // Transaction log entries written
    const log = TransactionLog.readAll();
    const ourLog = log.filter(e =>
      typeof e.requestId === "string" &&
      e.requestId.startsWith(TEST_REQUEST_PREFIX)
    );
    const claims = ourLog.filter(e => e.type === "resource.claim");
    const commits = ourLog.filter(e => e.type === "resource.commit");
    t.assert("log: claim written for pipeline call", claims.length >= 1);
    t.assert("log: commit written for pipeline call", commits.length >= 1);
    t.assert("log: commit carries resourceName",
      commits.every(e => typeof e.resourceName === "string"));

    // Idempotency
    const idemReqId = `${TEST_REQUEST_PREFIX}idem-${Date.now()}`;
    const idem1 = await submitRequest({
      type: PAYLOAD_TYPES.CUSTOM_RESOURCE_CHANGE,
      requestId: idemReqId,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { resourceId: r1.id, delta: 5 }
    });
    const before2 = Resources.getResource(r1.id)?.value;
    const idem2 = await submitRequest({
      type: PAYLOAD_TYPES.CUSTOM_RESOURCE_CHANGE,
      requestId: idemReqId,  // SAME requestId
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { resourceId: r1.id, delta: 999 }
    });
    t.assertEq("idempotency: first call success",
      idem1?.status, "success");
    t.assert("idempotency: second call from cache",
      idem2?.fromCache === true);
    t.assertEq("idempotency: actor not double-mutated",
      Resources.getResource(r1.id)?.value, before2);

    // -----------------------------------------------------
    // Delete
    // -----------------------------------------------------
    const removed = await Resources.deleteResource(r1.id);
    t.assert("delete: returns true", removed === true);
    t.assert("delete: resource no longer in list",
      Resources.getResources().every(r => r.id !== r1.id));

    const removeAgain = await Resources.deleteResource(r1.id);
    t.assert("delete: returns false for already-deleted",
      removeAgain === false);
  } finally {
    await restoreResources(snapshot);
    await cleanupStep14Fixtures();
  }

  printResults(`${MODULE_TITLE} | Step 14 Tests`, t.results);
  return t.results;
}
