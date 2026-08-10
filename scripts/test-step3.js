/**
 * Quartermaster — Step 3 Test Harness
 *
 * In-console verification suite for the Operation Coordinator and its
 * dependencies (AsyncLock, RecentRequestCache, transaction-log lookup).
 *
 * Run from the F12 console as GM:
 *   await game.modules.get("quartermaster").api.test.runStep3Tests();
 *
 * Returns an array of test result objects with { name, pass, detail }.
 * Each test is self-contained and uses unique requestIds so they do not
 * collide with each other or with real operations.
 *
 * NOTE: Tests write entries to the transaction log. After verifying, you
 * can clear them via:
 *   await game.modules.get("quartermaster").api.test.cleanupTestLogEntries();
 */

import { MODULE_TITLE } from "./constants.js";
import {
  executeOperation as executeCoordinatorOperation,
  diagnostics,
  _resetCacheForTesting
} from "./operation-coordinator.js";
import { AsyncLock } from "./async-lock.js";
import { RecentRequestCache } from "./recent-request-cache.js";
import * as TransactionLog from "./transaction-log.js";

const TEST_PREFIX = "qm-step3-test";

function newTestId(label) {
  return `${TEST_PREFIX}-${label}-${foundry.utils.randomID(8)}`;
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Bind every in-world test request to a stable synthetic payload. Production
 * requests are bound by the authenticated socket dispatcher; the console
 * harness mirrors that contract so its idempotency assertions remain valid.
 */
function executeOperation(options) {
  const requestData = options.requestData ?? {
    type: "quartermaster.coordinatorTest",
    operationType: options.operationType,
    resourceKeys: [...(options.resourceKeys ?? [])].map(String).sort()
  };
  return executeCoordinatorOperation({ ...options, requestData });
}

/**
 * Run all step 3 tests sequentially and return a results array.
 */
export async function runStep3Tests() {
  if (!game.user.isGM) {
    return [{ name: "preflight", pass: false, detail: "must run as GM" }];
  }

  console.log(`${MODULE_TITLE} | Running step 3 verification tests...`);
  const results = [];

  results.push(await testBasicExecution());
  results.push(await testIdempotencyCache());
  results.push(await testIdempotencyLog());
  results.push(await testRequestAgeRejection());
  results.push(await testMutexSerialization());
  results.push(await testMutexParallelism());
  results.push(await testMultiKeyAcquisition());
  results.push(await testAsyncLockDirectly());
  results.push(await testLruEviction());
  results.push(await testFnThrowsAreCaught());

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  console.log(
    `${MODULE_TITLE} | Step 3 tests: ${passed} passed, ${failed} failed`
  );

  // Pretty-print
  console.table(results.map(r => ({
    name: r.name,
    pass: r.pass ? "✓" : "✗",
    detail: r.detail
  })));

  return results;
}

/**
 * Test 1: a basic operation runs to completion and returns a wrapped result.
 */
async function testBasicExecution() {
  const requestId = newTestId("basic");
  const result = await executeOperation({
    resourceKeys: ["test:basic"],
    requestId,
    operationType: "test-basic",
    requester: game.user.id,
    timestamp: Date.now(),
    fn: async () => ({ value: 42 })
  });

  const pass = result.status === "success" && result.resultData?.value === 42;
  return {
    name: "1. Basic execution",
    pass,
    detail: pass
      ? "returned status=success, resultData.value=42"
      : `unexpected: ${JSON.stringify(result)}`
  };
}

/**
 * Test 2: same requestId returns from the durable tombstone without re-running fn.
 */
async function testIdempotencyCache() {
  const requestId = newTestId("cache");
  const timestamp = Date.now();
  let fnCalls = 0;

  const r1 = await executeOperation({
    resourceKeys: ["test:cache"],
    requestId,
    operationType: "test-cache",
    requester: game.user.id,
    timestamp,
    fn: async () => { fnCalls++; return { call: 1 }; }
  });

  const r2 = await executeOperation({
    resourceKeys: ["test:cache"],
    requestId,
    operationType: "test-cache",
    requester: game.user.id,
    timestamp,
    fn: async () => { fnCalls++; return { call: 2 }; }
  });

  const pass = fnCalls === 1 && r2.fromTombstone === true && r1.resultData.call === 1;
  return {
    name: "2. Durable idempotency",
    pass,
    detail: pass
      ? `fn ran once, second call returned fromTombstone=true with original result`
      : `fnCalls=${fnCalls}, r2=${JSON.stringify(r2)}`
  };
}

/**
 * Test 3: durable tombstone idempotency survives a local cache reset.
 */
async function testIdempotencyLog() {
  const requestId = newTestId("log");
  const timestamp = Date.now();
  let fnCalls = 0;

  // Complete a bound operation, then clear the LRU to force durable replay.
  const first = await executeOperation({
    resourceKeys: ["test:log"],
    requestId,
    operationType: "test-log",
    requester: game.user.id,
    timestamp,
    fn: async () => ({ preseeded: true })
  });
  _resetCacheForTesting();

  const result = await executeOperation({
    resourceKeys: ["test:log"],
    requestId,
    operationType: "test-log",
    requester: game.user.id,
    timestamp,
    fn: async () => { fnCalls++; return { call: "should-not-run" }; }
  });

  const pass = first.status === "success"
    && fnCalls === 0
    && result.fromTombstone === true
    && result.resultData?.preseeded === true;
  return {
    name: "3. Transaction log idempotency",
    pass,
    detail: pass
      ? "fn did not run; returned fromTombstone=true with preseeded data"
      : `fnCalls=${fnCalls}, result=${JSON.stringify(result)}`
  };
}

/**
 * Test 4: a request with a timestamp older than the age limit is rejected.
 */
async function testRequestAgeRejection() {
  const requestId = newTestId("age");
  let fnCalls = 0;

  const oldTimestamp = Date.now() - 60 * 1000;  // 60 seconds ago (default limit is 30s)

  const result = await executeOperation({
    resourceKeys: ["test:age"],
    requestId,
    operationType: "test-age",
    requester: game.user.id,
    timestamp: oldTimestamp,
    fn: async () => { fnCalls++; return {}; }
  });

  const pass = fnCalls === 0 && result.status === "failed" && result.error === "request-too-old";
  return {
    name: "4. Request age rejection",
    pass,
    detail: pass
      ? "60-second-old request rejected without running fn"
      : `fnCalls=${fnCalls}, result=${JSON.stringify(result)}`
  };
}

/**
 * Test 5: two operations on the same resource key serialize FIFO.
 * Each fn sleeps 200ms. If they ran in parallel, total time would be ~200ms.
 * If they serialize, total time is ~400ms.
 */
async function testMutexSerialization() {
  const start = Date.now();
  const order = [];

  await Promise.all([
    executeOperation({
      resourceKeys: ["test:serial"],
      requestId: newTestId("ser-a"),
      operationType: "test-serial",
      requester: game.user.id,
      timestamp: Date.now(),
      fn: async () => {
        order.push("a-start");
        await delay(200);
        order.push("a-end");
      }
    }),
    executeOperation({
      resourceKeys: ["test:serial"],
      requestId: newTestId("ser-b"),
      operationType: "test-serial",
      requester: game.user.id,
      timestamp: Date.now(),
      fn: async () => {
        order.push("b-start");
        await delay(200);
        order.push("b-end");
      }
    })
  ]);

  const elapsed = Date.now() - start;
  const orderStr = order.join(",");
  // Pass if elapsed >= 380ms (allow 20ms slack) AND order is strictly serialized
  const isSerial =
    (orderStr === "a-start,a-end,b-start,b-end" || orderStr === "b-start,b-end,a-start,a-end");
  const pass = elapsed >= 380 && isSerial;

  return {
    name: "5. Mutex serialization (same key)",
    pass,
    detail: pass
      ? `serialized in ${elapsed}ms, order: ${orderStr}`
      : `elapsed=${elapsed}ms (expected >= 380), order=${orderStr}`
  };
}

/**
 * Test 6: two operations on different keys parallelize.
 * Each fn sleeps 200ms. If they parallelize, total time is ~200ms.
 */
async function testMutexParallelism() {
  const start = Date.now();

  await Promise.all([
    executeOperation({
      resourceKeys: ["test:parA"],
      requestId: newTestId("par-a"),
      operationType: "test-parallel",
      requester: game.user.id,
      timestamp: Date.now(),
      fn: async () => { await delay(200); }
    }),
    executeOperation({
      resourceKeys: ["test:parB"],
      requestId: newTestId("par-b"),
      operationType: "test-parallel",
      requester: game.user.id,
      timestamp: Date.now(),
      fn: async () => { await delay(200); }
    })
  ]);

  const elapsed = Date.now() - start;
  const pass = elapsed < 380;  // should be ~200, generous upper bound

  return {
    name: "6. Mutex parallelism (different keys)",
    pass,
    detail: pass
      ? `parallelized in ${elapsed}ms`
      : `elapsed=${elapsed}ms (expected < 380, suggesting serialization)`
  };
}

/**
 * Test 7: multi-key acquisition serializes operations that overlap on at
 * least one key. Two ops, both want lock on "X". One also wants "Y".
 * They must serialize on X.
 */
async function testMultiKeyAcquisition() {
  const start = Date.now();
  const order = [];

  await Promise.all([
    executeOperation({
      resourceKeys: ["test:mkX", "test:mkY"],
      requestId: newTestId("mk-a"),
      operationType: "test-multikey",
      requester: game.user.id,
      timestamp: Date.now(),
      fn: async () => {
        order.push("a-start");
        await delay(150);
        order.push("a-end");
      }
    }),
    executeOperation({
      resourceKeys: ["test:mkX"],
      requestId: newTestId("mk-b"),
      operationType: "test-multikey",
      requester: game.user.id,
      timestamp: Date.now(),
      fn: async () => {
        order.push("b-start");
        await delay(150);
        order.push("b-end");
      }
    })
  ]);

  const elapsed = Date.now() - start;
  const orderStr = order.join(",");
  const isSerial =
    (orderStr === "a-start,a-end,b-start,b-end" || orderStr === "b-start,b-end,a-start,a-end");
  const pass = elapsed >= 280 && isSerial;

  return {
    name: "7. Multi-key overlap serializes",
    pass,
    detail: pass
      ? `serialized in ${elapsed}ms despite different key sets, order: ${orderStr}`
      : `elapsed=${elapsed}ms, order=${orderStr}`
  };
}

/**
 * Test 8: direct AsyncLock test (independent of coordinator). Confirms the
 * lock primitive itself works as advertised.
 */
async function testAsyncLockDirectly() {
  const lock = new AsyncLock();
  const order = [];

  await Promise.all([
    lock.acquire("k", async () => { order.push("1-in"); await delay(50); order.push("1-out"); }),
    lock.acquire("k", async () => { order.push("2-in"); await delay(50); order.push("2-out"); }),
    lock.acquire("k", async () => { order.push("3-in"); await delay(50); order.push("3-out"); })
  ]);

  const expected = "1-in,1-out,2-in,2-out,3-in,3-out";
  const actual = order.join(",");
  const pass = actual === expected && lock.size() === 0;

  return {
    name: "8. AsyncLock FIFO and self-prune",
    pass,
    detail: pass
      ? `strict FIFO order; map auto-pruned (size=${lock.size()})`
      : `order=${actual}, expected=${expected}, lock.size=${lock.size()}`
  };
}

/**
 * Test 9: LRU cache evicts oldest entry when full.
 */
async function testLruEviction() {
  const cache = new RecentRequestCache({ maxSize: 3 });
  cache.set("a", { v: 1 });
  cache.set("b", { v: 2 });
  cache.set("c", { v: 3 });
  cache.set("d", { v: 4 });  // should evict "a"

  const aGone = !cache.has("a");
  const dPresent = cache.has("d") && cache.get("d").v === 4;

  // Touch "b" then add "e" -> "c" should be evicted (since b was touched)
  cache.get("b");
  cache.set("e", { v: 5 });
  const cGone = !cache.has("c");
  const bStillPresent = cache.has("b");

  const pass = aGone && dPresent && cGone && bStillPresent;

  return {
    name: "9. LRU eviction order",
    pass,
    detail: pass
      ? "evicts oldest on overflow; get() bumps MRU correctly"
      : `aGone=${aGone}, dPresent=${dPresent}, cGone=${cGone}, bStillPresent=${bStillPresent}`
  };
}

/**
 * Test 10: an fn that throws is caught and wrapped as { status: "failed" }.
 */
async function testFnThrowsAreCaught() {
  const result = await executeOperation({
    resourceKeys: ["test:throws"],
    requestId: newTestId("throws"),
    operationType: "test-throws",
    requester: game.user.id,
    timestamp: Date.now(),
    fn: async () => { throw new Error("intentional test failure"); }
  });

  const pass = result.status === "failed" && result.error === "intentional test failure";
  return {
    name: "10. fn throw is caught",
    pass,
    detail: pass
      ? "thrown error captured as { status: failed, error: ... }"
      : `unexpected: ${JSON.stringify(result)}`
  };
}

/**
 * Diagnostic helper exposed via the test API.
 */
export function showDiagnostics() {
  const d = diagnostics();
  console.log(`${MODULE_TITLE} | Coordinator diagnostics:`, d);
  return d;
}

/**
 * Remove all transaction log entries created by the step 3 or step 4 test
 * harnesses. Useful for cleaning up after verification.
 *
 * Returns the number of entries removed.
 */
export async function cleanupTestLogEntries() {
  if (!game.user.isGM) {
    console.warn(`${MODULE_TITLE} | cleanupTestLogEntries: must run as GM`);
    return 0;
  }
  const all = TransactionLog.readAll();
  const kept = all.filter(e =>
    !e.requestId?.startsWith("qm-step3-test") &&
    !e.requestId?.startsWith("qm-step4-test")
  );
  const removed = all.length - kept.length;
  if (removed === 0) return 0;

  // Bypass the writeEntry path; set the flag directly via the actor
  const actor = (await import("./backing-actor.js")).getBackingActor();
  if (!actor) return 0;
  await actor.setFlag("quartermaster", "transactionLog", kept);

  console.log(`${MODULE_TITLE} | Removed ${removed} test log entries`);
  return removed;
}
