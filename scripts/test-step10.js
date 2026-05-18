/**
 * Quartermaster — Step 10 Test Harness
 *
 * Integration tests for currency change via the socket pipeline. Each
 * test snapshots the vault's currency before mutation and restores it
 * afterward, so running the suite leaves no persistent side effects.
 *
 * Test requestIds use the `qm-step10-test-` prefix so the cleanup helper
 * can prune the transaction log entries the tests produce.
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep10Tests();
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { PAYLOAD_TYPES, submitRequest } from "./socket-handler.js";
import * as TransactionLog from "./transaction-log.js";

const TEST_REQUEST_PREFIX = "qm-step10-test-";

// ============================================================
// Fixture management
// ============================================================

async function snapshotCurrency() {
  const actor = getBackingActor();
  return {
    pp: actor?.system?.currency?.pp ?? 0,
    gp: actor?.system?.currency?.gp ?? 0,
    ep: actor?.system?.currency?.ep ?? 0,
    sp: actor?.system?.currency?.sp ?? 0,
    cp: actor?.system?.currency?.cp ?? 0
  };
}

async function restoreCurrency(snapshot) {
  const actor = getBackingActor();
  await actor.update({
    "system.currency.pp": snapshot.pp,
    "system.currency.gp": snapshot.gp,
    "system.currency.ep": snapshot.ep,
    "system.currency.sp": snapshot.sp,
    "system.currency.cp": snapshot.cp
  });
}

export async function cleanupStep10Fixtures() {
  const backingActor = getBackingActor();
  if (!backingActor || !game.user.isGM) return 0;

  const log = TransactionLog.readAll();
  const filtered = log.filter(e =>
    typeof e.requestId !== "string" || !e.requestId.startsWith(TEST_REQUEST_PREFIX)
  );
  const removed = log.length - filtered.length;
  if (removed > 0) {
    await backingActor.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, filtered);
  }
  console.log(
    `${MODULE_TITLE} | Step 10 cleanup: removed ${removed} test log entries`
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

export async function runStep10Tests() {
  if (!game.user.isGM) {
    console.error(`${MODULE_TITLE} | Step 10 tests must be run by a GM`);
    return [];
  }

  const t = makeTestContext();
  const backingActor = getBackingActor();
  if (!backingActor) {
    console.error(`${MODULE_TITLE} | No backing actor; tests aborted`);
    return [];
  }

  const snapshot = await snapshotCurrency();

  try {
    // -----------------------------------------------------
    // Section 1: add currency
    // -----------------------------------------------------
    const baselineGp = snapshot.gp;

    const r1 = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId: `${TEST_REQUEST_PREFIX}add-${Date.now()}`,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { currencyType: "gp", delta: 50, reason: "step10-add-test" }
    });

    t.assertEq("Add 50 gp: status is success", r1?.status, "success");
    t.assertEq("Add 50 gp: delta in result", r1?.resultData?.delta, 50);
    t.assertEq("Add 50 gp: previousValue matches snapshot",
      r1?.resultData?.previousValue, baselineGp);
    t.assertEq("Add 50 gp: newValue is previousValue + delta",
      r1?.resultData?.newValue, baselineGp + 50);
    t.assertEq("Add 50 gp: actor.system.currency.gp reflects new value",
      backingActor.system?.currency?.gp, baselineGp + 50);

    // -----------------------------------------------------
    // Section 2: remove currency
    // -----------------------------------------------------
    const beforeRemove = backingActor.system?.currency?.gp ?? 0;

    const r2 = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId: `${TEST_REQUEST_PREFIX}remove-${Date.now()}`,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { currencyType: "gp", delta: -30, reason: "step10-remove-test" }
    });

    t.assertEq("Remove 30 gp: status is success", r2?.status, "success");
    t.assertEq("Remove 30 gp: actor balance reduced",
      backingActor.system?.currency?.gp, beforeRemove - 30);

    // -----------------------------------------------------
    // Section 3: zero delta is a no-op
    // -----------------------------------------------------
    const beforeNoop = backingActor.system?.currency?.gp ?? 0;

    const r3 = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId: `${TEST_REQUEST_PREFIX}noop-${Date.now()}`,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { currencyType: "gp", delta: 0 }
    });

    t.assertEq("Zero delta: status is success", r3?.status, "success");
    t.assert("Zero delta: noop flag set", r3?.resultData?.noop === true);
    t.assertEq("Zero delta: actor unchanged",
      backingActor.system?.currency?.gp, beforeNoop);

    // -----------------------------------------------------
    // Section 4: insufficient funds
    // -----------------------------------------------------
    const currentGp = backingActor.system?.currency?.gp ?? 0;
    const overdraw = currentGp + 1000;

    const r4 = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId: `${TEST_REQUEST_PREFIX}overdraw-${Date.now()}`,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { currencyType: "gp", delta: -overdraw }
    });

    t.assertEq("Overdraw: status is failed", r4?.status, "failed");
    t.assertEq("Overdraw: error is insufficient-funds",
      r4?.error, "insufficient-funds");
    t.assertEq("Overdraw: actor balance unchanged",
      backingActor.system?.currency?.gp, currentGp);

    // -----------------------------------------------------
    // Section 5: invalid inputs
    // -----------------------------------------------------
    const r5a = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId: `${TEST_REQUEST_PREFIX}invalid-type-${Date.now()}`,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { currencyType: "zz", delta: 5 }
    });
    t.assertEq("Invalid currency type: failed", r5a?.status, "failed");
    t.assertEq("Invalid currency type: error code",
      r5a?.error, "invalid-currency-type");

    const r5b = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId: `${TEST_REQUEST_PREFIX}invalid-delta-${Date.now()}`,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { currencyType: "gp", delta: "not-a-number" }
    });
    t.assertEq("Invalid delta: failed", r5b?.status, "failed");
    t.assertEq("Invalid delta: error code", r5b?.error, "invalid-delta");

    // -----------------------------------------------------
    // Section 6: idempotency
    // -----------------------------------------------------
    const beforeIdem = backingActor.system?.currency?.gp ?? 0;
    const idemRequestId = `${TEST_REQUEST_PREFIX}idem-${Date.now()}`;

    const r6a = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId: idemRequestId,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { currencyType: "gp", delta: 7 }
    });
    t.assertEq("Idempotent: first call success", r6a?.status, "success");
    t.assertEq("Idempotent: balance increased by 7",
      backingActor.system?.currency?.gp, beforeIdem + 7);

    const r6b = await submitRequest({
      type: PAYLOAD_TYPES.CURRENCY_CHANGE,
      requestId: idemRequestId,
      timestamp: Date.now(),
      userId: game.user.id,
      payload: { currencyType: "gp", delta: 9999 }
    });
    t.assert("Idempotent: second call from cache", r6b?.fromCache === true);
    t.assertEq("Idempotent: balance not double-applied",
      backingActor.system?.currency?.gp, beforeIdem + 7);

    // -----------------------------------------------------
    // Section 7: transaction log entries
    // -----------------------------------------------------
    const log = TransactionLog.readAll();
    const ourEntries = log.filter(e =>
      typeof e.requestId === "string" &&
      e.requestId.startsWith(TEST_REQUEST_PREFIX)
    );
    const claims = ourEntries.filter(e => e.type === "currency.claim");
    const commits = ourEntries.filter(e => e.type === "currency.commit");

    t.assert("Transaction log: claim entries written",
      claims.length >= 3);  // add, remove, idem-first at minimum
    t.assert("Transaction log: commit entries written",
      commits.length >= 3);
    t.assert("Transaction log: claim entries carry deltas",
      claims.every(e => typeof e.delta === "number"));
    t.assert("Transaction log: commit entries carry previous and new values",
      commits.every(e =>
        typeof e.previousValue === "number" &&
        typeof e.newValue === "number"
      ));
  } finally {
    // Always restore vault state, even on test failure
    await restoreCurrency(snapshot);

    // And prune test transaction log entries
    await cleanupStep10Fixtures();
  }

  printResults(`${MODULE_TITLE} | Step 10 Tests`, t.results);
  return t.results;
}
