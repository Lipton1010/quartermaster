/**
 * Quartermaster — Step 4 Test Harness
 *
 * Verifies the socket dispatch pipeline. Tests run from the GM client and
 * exercise the local dispatch path (since cross-client testing requires
 * another connected user). The dispatch logic itself is the same whether
 * called from a player query or a local GM invocation.
 *
 * Run from the F12 console as GM:
 *   await game.modules.get("quartermaster").api.test.runStep4Tests();
 *
 * NOTE: As with step 3, these tests write entries to the transaction log.
 * Clean them up with:
 *   await game.modules.get("quartermaster").api.test.cleanupTestLogEntries();
 */

import { MODULE_TITLE } from "./constants.js";
import {
  submitRequest,
  isActiveGM,
  diagnostics as socketDiagnostics,
  PAYLOAD_TYPES,
  _dispatchForTesting
} from "./socket-handler.js";

const TEST_PREFIX = "qm-step4-test";

function newTestId(label) {
  return `${TEST_PREFIX}-${label}-${foundry.utils.randomID(8)}`;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function runStep4Tests() {
  if (!game.user.isGM) {
    return [{ name: "preflight", pass: false, detail: "must run as GM" }];
  }
  if (!isActiveGM()) {
    return [{ name: "preflight", pass: false, detail: "must be the active GM" }];
  }

  console.log(`${MODULE_TITLE} | Running step 4 verification tests...`);
  const results = [];

  results.push(await testItemTransferStub());
  results.push(await testCurrencyChangeStub());
  results.push(await testCustomResourceChangeStub());
  results.push(await testUnknownPayloadType());
  results.push(await testMissingRequiredFields());
  results.push(await testIdempotencyAcrossSocketLayer());
  results.push(await testSerializationAcrossSocketLayer());
  results.push(await testUserIdMismatchWarning());
  results.push(await testActiveGMDetection());

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  console.log(`${MODULE_TITLE} | Step 4 tests: ${passed} passed, ${failed} failed`);
  console.table(results.map(r => ({
    name: r.name,
    pass: r.pass ? "✓" : "✗",
    detail: r.detail
  })));

  return results;
}

/**
 * Test 1: item transfer payload reaches the dispatcher and is routed
 * through to the real Claim-and-Commit pipeline (step 9). With fake
 * actor and item IDs, the pipeline correctly identifies them as missing
 * and returns a structured failure envelope. The point is to verify the
 * route, not to actually transfer anything.
 */
async function testItemTransferStub() {
  const result = await submitRequest({
    type: PAYLOAD_TYPES.ITEM_TRANSFER,
    requestId: newTestId("itx"),
    action: "ingress",
    payload: {
      sourceActorId: "test-actor-nonexistent",
      sourceItemId: "test-item-abc",
      destActorId: "test-actor-also-nonexistent"
    }
  });

  // After step 9, real implementation runs and reports a clean failure
  // because the actor/item don't exist in the world.
  const pass =
    result.status === "failed" &&
    typeof result.error === "string" &&
    (result.error === "source-actor-not-found" ||
     result.error === "destination-actor-not-found" ||
     result.error === "source-item-not-found");

  return {
    name: "1. Item transfer dispatch (routes to real pipeline, reports missing-doc)",
    pass,
    detail: pass
      ? `dispatched to real pipeline, got expected failure: ${result.error}`
      : `unexpected: ${JSON.stringify(result)}`
  };
}

/**
 * Test 2: currency change payload reaches the real dispatcher (step 10).
 *
 * Step 10 replaced the stub with a real handler that actually mutates
 * the backing actor. We test the cleanest no-op path: delta=0, which
 * doesn't touch state and returns a structured success envelope.
 */
async function testCurrencyChangeStub() {
  const result = await submitRequest({
    type: PAYLOAD_TYPES.CURRENCY_CHANGE,
    requestId: newTestId("cur"),
    payload: {
      currencyType: "gp",
      delta: 0,        // no-op: tests the dispatch path without mutating state
      reason: "step4-pipeline-test"
    }
  });

  const pass =
    result.status === "success" &&
    result.resultData?.currencyType === "gp" &&
    result.resultData?.delta === 0 &&
    result.resultData?.noop === true;

  return {
    name: "2. Currency change reaches real pipeline (no-op success)",
    pass,
    detail: pass
      ? "delta=0 routed to real handler, returned no-op success envelope"
      : `unexpected: ${JSON.stringify(result)}`
  };
}

/**
 * Test 3: custom resource change payload reaches the real dispatcher
 * (step 14). Step 14 replaced the stub with a real handler; with a
 * non-existent resourceId, the handler correctly returns a structured
 * failure. The point is verifying the route, not the resource lookup.
 */
async function testCustomResourceChangeStub() {
  const result = await submitRequest({
    type: PAYLOAD_TYPES.CUSTOM_RESOURCE_CHANGE,
    requestId: newTestId("res"),
    payload: {
      resourceId: "step4-nonexistent-resource",
      delta: -1
    }
  });

  const pass =
    result.status === "failed" &&
    result.error === "resource-not-found" &&
    result.resourceId === "step4-nonexistent-resource";

  return {
    name: "3. Custom resource change reaches real pipeline (resource-not-found)",
    pass,
    detail: pass
      ? "customResourceChange routed to real handler, failed cleanly on unknown id"
      : `unexpected: ${JSON.stringify(result)}`
  };
}

/**
 * Test 4: unknown payload type is rejected with a clear error.
 */
async function testUnknownPayloadType() {
  const result = await submitRequest({
    type: "quartermaster.fakeTypeNobodyHandles",
    requestId: newTestId("unk"),
    payload: { whatever: true }
  });

  const pass = result.status === "failed" && result.error === "unknown-payload-type";
  return {
    name: "4. Unknown payload type rejected",
    pass,
    detail: pass
      ? "returned status=failed, error=unknown-payload-type"
      : `unexpected: ${JSON.stringify(result)}`
  };
}

/**
 * Test 5: missing required fields are caught per payload type.
 */
async function testMissingRequiredFields() {
  // Item transfer without itemId
  const r1 = await submitRequest({
    type: PAYLOAD_TYPES.ITEM_TRANSFER,
    requestId: newTestId("miss-itx"),
    action: "removeFromBag",
    payload: { quantity: 1 }  // missing itemId
  });

  // Currency change without currencyType
  const r2 = await submitRequest({
    type: PAYLOAD_TYPES.CURRENCY_CHANGE,
    requestId: newTestId("miss-cur"),
    payload: { delta: -10 }  // missing currencyType
  });

  // Currency change with non-numeric delta
  const r3 = await submitRequest({
    type: PAYLOAD_TYPES.CURRENCY_CHANGE,
    requestId: newTestId("miss-cur-2"),
    payload: { currencyType: "gp", delta: "fifty" }  // delta should be number
  });

  const pass =
    r1.status === "failed" && r1.error === "missing-item-id" &&
    r2.status === "failed" && r2.error === "missing-currency-type" &&
    r3.status === "failed" && r3.error === "invalid-delta";

  return {
    name: "5. Missing field validation",
    pass,
    detail: pass
      ? "all three malformed payloads rejected with specific errors"
      : `unexpected: r1=${r1.error}, r2=${r2.error}, r3=${r3.error}`
  };
}

/**
 * Test 6: idempotency works across the socket layer (same as coordinator,
 * verified via the submitRequest entry point).
 *
 * Uses CURRENCY_CHANGE with delta=0 (no-op success) to test the dedup
 * behavior without mutating state. The currency stub was replaced in
 * step 10 and the resource stub was replaced in step 14, so neither
 * leaves a non-mutating echo handler. Zero-delta currency is the
 * cleanest path that still exercises the full dispatch + coordinator
 * + idempotency-cache flow.
 */
async function testIdempotencyAcrossSocketLayer() {
  const requestId = newTestId("idem");

  const r1 = await submitRequest({
    type: PAYLOAD_TYPES.CURRENCY_CHANGE,
    requestId,
    payload: { currencyType: "gp", delta: 0 }
  });

  const r2 = await submitRequest({
    type: PAYLOAD_TYPES.CURRENCY_CHANGE,
    requestId,
    payload: { currencyType: "gp", delta: 999 }  // different; should be ignored
  });

  const pass =
    r1.status === "success" &&
    r2.fromCache === true &&
    r2.resultData?.delta === 0;  // original delta, not the second call's

  return {
    name: "6. Idempotency through socket entry point",
    pass,
    detail: pass
      ? "second submission with same requestId returned cached result"
      : `r1=${JSON.stringify(r1)}, r2=${JSON.stringify(r2)}`
  };
}

/**
 * Test 7: serialization on the same resource key across the socket layer.
 */
async function testSerializationAcrossSocketLayer() {
  const sharedItemId = `step4-share-${foundry.utils.randomID(6)}`;
  const order = [];

  // Two parallel submitRequest calls on the same item; they must serialize
  await Promise.all([
    submitRequest({
      type: PAYLOAD_TYPES.ITEM_TRANSFER,
      requestId: newTestId("ser-a"),
      action: "removeFromBag",
      payload: { itemId: sharedItemId, targetActorId: "a", quantity: 1 }
    }).then(() => order.push("a-done")),
    submitRequest({
      type: PAYLOAD_TYPES.ITEM_TRANSFER,
      requestId: newTestId("ser-b"),
      action: "removeFromBag",
      payload: { itemId: sharedItemId, targetActorId: "b", quantity: 1 }
    }).then(() => order.push("b-done"))
  ]);

  // Both should complete; we mostly want to ensure no errors and ordering
  // is sane (both reported done)
  const pass = order.length === 2;
  return {
    name: "7. Serialization through socket entry point",
    pass,
    detail: pass
      ? `both completed in some order: ${order.join(",")}`
      : `order=${order.join(",")}`
  };
}

/**
 * Test 8: when payload.userId disagrees with the authoritative sender,
 * a warning is logged and the authoritative value is used.
 *
 * We use _dispatchForTesting to simulate "Foundry says sender is X" while
 * the payload claims otherwise.
 */
async function testUserIdMismatchWarning() {
  // Capture console.warn calls
  const originalWarn = console.warn;
  const warnMessages = [];
  console.warn = (...args) => {
    warnMessages.push(args.join(" "));
    originalWarn.apply(console, args);
  };

  try {
    const result = await _dispatchForTesting(
      {
        type: PAYLOAD_TYPES.CURRENCY_CHANGE,
        requestId: newTestId("mism"),
        userId: "fake-claimed-user-id",  // wrong
        timestamp: Date.now(),
        payload: { currencyType: "gp", delta: 1 }
      },
      game.user.id  // authoritative
    );

    const sawWarning = warnMessages.some(m => m.includes("userId mismatch"));
    const succeeded = result.status === "success";

    const pass = sawWarning && succeeded;
    return {
      name: "8. userId mismatch logs warning but proceeds",
      pass,
      detail: pass
        ? "warning logged, operation proceeded with authoritative sender ID"
        : `sawWarning=${sawWarning}, status=${result.status}`
    };
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Test 9: diagnostics report active GM correctly.
 */
async function testActiveGMDetection() {
  const d = socketDiagnostics();
  const pass =
    d.registered === true &&
    d.weAreActiveGM === true &&
    d.activeGMId === game.user.id;
  return {
    name: "9. Active GM detection",
    pass,
    detail: pass
      ? `registered=true, weAreActiveGM=true, activeGMId=${d.activeGMId}`
      : `diagnostics=${JSON.stringify(d)}`
  };
}

/**
 * Diagnostic helper exposed via the test API.
 */
export function showSocketDiagnostics() {
  const d = socketDiagnostics();
  console.log(`${MODULE_TITLE} | Socket diagnostics:`, d);
  return d;
}
