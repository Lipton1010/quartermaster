/**
 * Quartermaster — Step 13 Test Harness
 *
 * Tests for the approval policy module. Reads/restores the world setting
 * so the test suite leaves no persistent change. The approval DIALOG
 * itself is interactive and isn't exercised here; verification of the
 * dialog flow is manual (see step 13 verification checklist).
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep13Tests();
 */

import { MODULE_ID, MODULE_TITLE, SETTINGS, CHOICES } from "./constants.js";
import { needsApproval, needsApprovalForCurrentUser, getTimeoutConfig } from "./approval-policy.js";

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
// Settings snapshot/restore
// ============================================================

async function snapshotSettings() {
  return {
    mode: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_MODE),
    threshold: game.settings.get(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_THRESHOLD),
    useTimeout: game.settings.get(MODULE_ID, SETTINGS.USE_APPROVAL_TIMEOUT),
    timeoutSeconds: game.settings.get(MODULE_ID, SETTINGS.APPROVAL_TIMEOUT_SECONDS)
  };
}

async function restoreSettings(snap) {
  await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_MODE, snap.mode);
  await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_THRESHOLD, snap.threshold);
  await game.settings.set(MODULE_ID, SETTINGS.USE_APPROVAL_TIMEOUT, snap.useTimeout);
  await game.settings.set(MODULE_ID, SETTINGS.APPROVAL_TIMEOUT_SECONDS, snap.timeoutSeconds);
}

// ============================================================
// Tests
// ============================================================

export async function runStep13Tests() {
  if (!game.user.isGM) {
    console.error(`${MODULE_TITLE} | Step 13 tests must be run by a GM`);
    return [];
  }

  const t = makeTestContext();
  const snap = await snapshotSettings();

  // Find a non-GM user to test against. If none exist, synthesize one for
  // the test by constructing a fake userId. The needsApproval function
  // resolves via game.users.get; an unknown id returns undefined, which
  // is then treated as non-GM (correct behavior).
  const gmUserId = game.user.id;
  const fakePlayerId = "step13-fake-player-id-aaaaaaa";

  try {
    // -----------------------------------------------------
    // Mode: FREE — never need approval
    // -----------------------------------------------------
    await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_MODE,
      CHOICES.CURRENCY_APPROVAL.FREE);

    t.assertEq("FREE: GM adding gp does not need approval",
      needsApproval({ userId: gmUserId, delta: 50 }), false);
    t.assertEq("FREE: player adding gp does not need approval",
      needsApproval({ userId: fakePlayerId, delta: 50 }), false);
    t.assertEq("FREE: player removing 1000 gp does not need approval",
      needsApproval({ userId: fakePlayerId, delta: -1000 }), false);

    // -----------------------------------------------------
    // Mode: ALL_REQUIRED — every player request needs approval
    // -----------------------------------------------------
    await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_MODE,
      CHOICES.CURRENCY_APPROVAL.ALL_REQUIRED);

    t.assertEq("ALL_REQUIRED: GM adding gp does not need approval (auto-approve self)",
      needsApproval({ userId: gmUserId, delta: 50 }), false);
    t.assertEq("ALL_REQUIRED: GM removing gp does not need approval",
      needsApproval({ userId: gmUserId, delta: -10 }), false);
    t.assertEq("ALL_REQUIRED: player adding 1 gp needs approval",
      needsApproval({ userId: fakePlayerId, delta: 1 }), true);
    t.assertEq("ALL_REQUIRED: player adding 100 gp needs approval",
      needsApproval({ userId: fakePlayerId, delta: 100 }), true);
    t.assertEq("ALL_REQUIRED: player removing 5 gp needs approval",
      needsApproval({ userId: fakePlayerId, delta: -5 }), true);

    // -----------------------------------------------------
    // Mode: THRESHOLD — approval when |delta| >= configured threshold
    // -----------------------------------------------------
    await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_MODE,
      CHOICES.CURRENCY_APPROVAL.THRESHOLD);
    await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_THRESHOLD, 100);

    t.assertEq("THRESHOLD(100): GM at any amount does not need approval",
      needsApproval({ userId: gmUserId, delta: 9999 }), false);
    t.assertEq("THRESHOLD(100): player adding 50 (below threshold) skips approval",
      needsApproval({ userId: fakePlayerId, delta: 50 }), false);
    t.assertEq("THRESHOLD(100): player adding 99 (below threshold) skips approval",
      needsApproval({ userId: fakePlayerId, delta: 99 }), false);
    t.assertEq("THRESHOLD(100): player adding 100 (at threshold) needs approval",
      needsApproval({ userId: fakePlayerId, delta: 100 }), true);
    t.assertEq("THRESHOLD(100): player adding 500 (over threshold) needs approval",
      needsApproval({ userId: fakePlayerId, delta: 500 }), true);
    t.assertEq("THRESHOLD(100): player removing 200 (over threshold) needs approval",
      needsApproval({ userId: fakePlayerId, delta: -200 }), true);
    t.assertEq("THRESHOLD(100): player removing 50 (below threshold) skips approval",
      needsApproval({ userId: fakePlayerId, delta: -50 }), false);

    // Threshold of 0 is an edge case
    await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_THRESHOLD, 0);
    t.assertEq("THRESHOLD(0): any nonzero player delta needs approval",
      needsApproval({ userId: fakePlayerId, delta: 1 }), true);

    // Threshold change at runtime is respected
    await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_THRESHOLD, 500);
    t.assertEq("THRESHOLD(500): player adding 100 below new threshold",
      needsApproval({ userId: fakePlayerId, delta: 100 }), false);

    // -----------------------------------------------------
    // needsApprovalForCurrentUser
    // -----------------------------------------------------
    await game.settings.set(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_MODE,
      CHOICES.CURRENCY_APPROVAL.ALL_REQUIRED);
    t.assertEq("needsApprovalForCurrentUser: GM (us) does not need approval",
      needsApprovalForCurrentUser({ delta: 50 }), false);

    // -----------------------------------------------------
    // Timeout config
    // -----------------------------------------------------
    await game.settings.set(MODULE_ID, SETTINGS.USE_APPROVAL_TIMEOUT, true);
    await game.settings.set(MODULE_ID, SETTINGS.APPROVAL_TIMEOUT_SECONDS, 45);
    const tc1 = getTimeoutConfig();
    t.assertEq("Timeout config: enabled true reflects setting", tc1.enabled, true);
    t.assertEq("Timeout config: seconds reflects setting", tc1.seconds, 45);

    await game.settings.set(MODULE_ID, SETTINGS.USE_APPROVAL_TIMEOUT, false);
    const tc2 = getTimeoutConfig();
    t.assertEq("Timeout config: enabled false when disabled", tc2.enabled, false);

  } finally {
    await restoreSettings(snap);
  }

  printResults(`${MODULE_TITLE} | Step 13 Tests`, t.results);
  return t.results;
}

// ============================================================
// Manual verification helper
// ============================================================

/**
 * Simulate a player-initiated currency request without going through
 * the socket security override. Useful for solo verification of the
 * approval flow: the GM stays logged in as themselves but can drive the
 * code path that a player would trigger.
 *
 * NOT for production use — it bypasses the userId authentication that
 * normally prevents payload-claimed-userId spoofing. Test-only.
 *
 * @example
 *   const api = game.modules.get("quartermaster").api;
 *   const result = await api.test.simulatePlayerCurrencyRequest({
 *     currencyType: "gp",
 *     delta: 25,
 *     reason: "step 13 approval test"
 *   });
 *   console.log(result);
 *
 * @param {Object} options
 * @param {string} [options.userId] - userId to attribute the request to;
 *   defaults to the first non-GM user, or a synthetic id if none exist
 * @param {string} options.currencyType - pp | gp | ep | sp | cp
 * @param {number} options.delta - signed delta
 * @param {string} [options.reason]
 * @returns {Promise<Object>}
 */
export async function simulatePlayerCurrencyRequest({
  userId,
  currencyType = "gp",
  delta = 1,
  reason = "test-simulate"
} = {}) {
  if (!game.user.isGM) {
    console.error(`${MODULE_TITLE} | simulatePlayerCurrencyRequest must be run by a GM`);
    return null;
  }

  // Default to the first non-GM user, or fall back to a synthetic id.
  // The synthetic id resolves to undefined in game.users.get(); the
  // approval policy treats undefined as non-GM, which is what we want.
  const resolvedUserId = userId
    ?? game.users.find(u => !u.isGM)?.id
    ?? "step13-simulated-player-id";

  const requestId = `qm-step13-sim-${foundry.utils.randomID()}`;

  // Import lazily so socket-handler doesn't have to expose internals
  // through the API surface
  const { realCurrencyChange } = await import("./socket-handler.js");

  console.log(
    `${MODULE_TITLE} | Simulating currency request:`,
    { userId: resolvedUserId, currencyType, delta, reason }
  );

  const result = await realCurrencyChange(
    { currencyType, delta, reason },
    { requestId, userId: resolvedUserId }
  );

  console.log(`${MODULE_TITLE} | Simulation result:`, result);
  return result;
}
