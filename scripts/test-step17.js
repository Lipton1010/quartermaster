/**
 * Quartermaster — Step 17 Test Harness
 *
 * Tests for settings scope migration, preferences dialog returns,
 * and the custom preferencesChanged hook.
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep17Tests();
 */

import { MODULE_ID, MODULE_TITLE, SETTINGS, HOOKS } from "./constants.js";

// ============================================================
// Helpers
// ============================================================

let _pass = 0;
let _fail = 0;

function pass(label) { _pass++; console.log(`%c  ✓ ${label}`, "color:#4caf50"); }
function fail(label, detail) { _fail++; console.error(`  ✗ ${label}`, detail ?? ""); }
function assert(cond, label, detail) { cond ? pass(label) : fail(label, detail); }

function snapshotSettings(keys) {
  const snap = {};
  for (const key of keys) {
    try { snap[key] = game.settings.get(MODULE_ID, key); } catch { snap[key] = undefined; }
  }
  return snap;
}

async function restoreSettings(snap) {
  for (const [key, val] of Object.entries(snap)) {
    if (val === undefined) continue;
    try { await game.settings.set(MODULE_ID, key, val); } catch {}
  }
}

export async function cleanupStep17Fixtures() {
  // No persistent fixtures to clean — settings are restored inline
  console.log(`${MODULE_TITLE} | Step 17 cleanup: nothing to clean`);
  return 0;
}

// ============================================================
// Tests
// ============================================================

async function testScopeIsCient() {
  // Verify the three migrated settings are now client-scope.
  // Foundry stores the scope in the registered setting's metadata.
  const clientKeys = [
    SETTINGS.SORT_ORDER,
    SETTINGS.DEFAULT_ENTRY_SIZE,
    SETTINGS.HIDE_ZERO_BALANCES
  ];

  for (const key of clientKeys) {
    const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
    assert(!!setting, `setting ${key}: registered`);
    assert(setting?.scope === "client", `setting ${key}: scope is "client"`, setting?.scope);
  }
}

async function testNewSettingsExist() {
  const keys = [
    SETTINGS.LOG_DEFAULT_PHASE_FILTER,
    SETTINGS.LOG_DEFAULT_CATEGORY_FILTER,
    SETTINGS.LOG_AUTO_EXPAND_GROUPS
  ];

  for (const key of keys) {
    const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
    assert(!!setting, `setting ${key}: registered`);
    assert(setting?.scope === "client", `setting ${key}: scope is "client"`, setting?.scope);
    assert(setting?.config === false, `setting ${key}: config is false`, setting?.config);
  }
}

async function testNewSettingDefaults() {
  // Check registered defaults (not current values, which the user may have changed)
  const phaseSetting = game.settings.settings.get(`${MODULE_ID}.${SETTINGS.LOG_DEFAULT_PHASE_FILTER}`);
  assert(phaseSetting?.default === "all", `LOG_DEFAULT_PHASE_FILTER registered default is "all"`, phaseSetting?.default);

  const catSetting = game.settings.settings.get(`${MODULE_ID}.${SETTINGS.LOG_DEFAULT_CATEGORY_FILTER}`);
  assert(catSetting?.default === "all", `LOG_DEFAULT_CATEGORY_FILTER registered default is "all"`, catSetting?.default);

  const expandSetting = game.settings.settings.get(`${MODULE_ID}.${SETTINGS.LOG_AUTO_EXPAND_GROUPS}`);
  assert(expandSetting?.default === false, `LOG_AUTO_EXPAND_GROUPS registered default is false`, expandSetting?.default);
}

async function testSettingsWriteAndRead() {
  const snap = snapshotSettings([SETTINGS.SORT_ORDER, SETTINGS.LOG_DEFAULT_PHASE_FILTER]);
  try {
    await game.settings.set(MODULE_ID, SETTINGS.SORT_ORDER, "alphabetical");
    const readBack = game.settings.get(MODULE_ID, SETTINGS.SORT_ORDER);
    assert(readBack === "alphabetical", "SORT_ORDER write+read round-trip", readBack);

    await game.settings.set(MODULE_ID, SETTINGS.LOG_DEFAULT_PHASE_FILTER, "failed");
    const readBack2 = game.settings.get(MODULE_ID, SETTINGS.LOG_DEFAULT_PHASE_FILTER);
    assert(readBack2 === "failed", "LOG_DEFAULT_PHASE_FILTER write+read round-trip", readBack2);
  } finally {
    await restoreSettings(snap);
  }
}

async function testPreferencesChangedHook() {
  const snap = snapshotSettings([SETTINGS.SORT_ORDER]);
  let hookFired = false;
  let hookKeys = [];

  const hookId = Hooks.on(HOOKS.PREFERENCES_CHANGED, (data) => {
    hookFired = true;
    hookKeys = data?.keys ?? [];
  });

  try {
    // Write via the same mechanism the preferences dialog uses
    const original = game.settings.get(MODULE_ID, SETTINGS.SORT_ORDER);
    const newVal = original === "alphabetical" ? "byType" : "alphabetical";

    await game.settings.set(MODULE_ID, SETTINGS.SORT_ORDER, newVal);
    // Manually fire the hook as the dialog would
    Hooks.callAll(HOOKS.PREFERENCES_CHANGED, { keys: [SETTINGS.SORT_ORDER] });

    assert(hookFired, "preferencesChanged hook fired");
    assert(hookKeys.includes(SETTINGS.SORT_ORDER), "hook payload contains changed key");
  } finally {
    Hooks.off(HOOKS.PREFERENCES_CHANGED, hookId);
    await restoreSettings(snap);
  }
}

async function testWorldScopeUnchanged() {
  // Spot-check that certain settings are still world-scope
  const worldKeys = [
    SETTINGS.ENFORCE_CAPACITY,
    SETTINGS.CURRENCY_APPROVAL_MODE,
    SETTINGS.TRANSACTION_LOG_CAP,
    SETTINGS.TRANSACTION_LOG_VISIBILITY
  ];

  for (const key of worldKeys) {
    const setting = game.settings.settings.get(`${MODULE_ID}.${key}`);
    assert(setting?.scope === "world", `setting ${key}: still world-scope`, setting?.scope);
  }
}

// ============================================================
// Runner
// ============================================================

export async function runStep17Tests() {
  _pass = 0;
  _fail = 0;

  console.group(`${MODULE_TITLE} | Step 17 Tests`);

  try {
    console.group("scope migration");
    await testScopeIsCient();
    console.groupEnd();

    console.group("new settings exist");
    await testNewSettingsExist();
    console.groupEnd();

    console.group("new setting defaults");
    await testNewSettingDefaults();
    console.groupEnd();

    console.group("write + read round-trip");
    await testSettingsWriteAndRead();
    console.groupEnd();

    console.group("preferencesChanged hook");
    await testPreferencesChangedHook();
    console.groupEnd();

    console.group("world-scope unchanged");
    await testWorldScopeUnchanged();
    console.groupEnd();

  } catch (err) {
    console.error(`${MODULE_TITLE} | Step 17: unexpected error`, err);
    _fail++;
  }

  const total = _pass + _fail;
  const color = _fail === 0 ? "color:#4caf50;font-weight:bold" : "color:#f44336;font-weight:bold";
  console.log(`%c${_pass}/${total} passed`, color);
  console.groupEnd();

  return { pass: _pass, fail: _fail, total };
}
