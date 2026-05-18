/**
 * Quartermaster — Step 7 Test Harness
 *
 * Unit-style fixture tests for the sanitization pipeline. Pure function
 * testing: no Foundry document creation, no socket traffic, no actor
 * mutation. Just feed in fixture data, run sanitize, assert on the
 * output.
 *
 * Run from console:
 *   game.modules.get("quartermaster").api.test.runStep7Tests();
 *
 * Tests cover:
 *   - ID generation and immutability of inputs
 *   - Owner-specific state stripping (equipped, attuned, attunement, prepared)
 *   - Module cache stripping (midi-qol, dae, quartermaster)
 *   - Effect origin rewriting (exact match, sub-reference, non-match)
 *   - Edge cases (no effects, no flags, empty system)
 */

import {
  sanitizeItemForTransfer,
  generateItemId,
  buildItemUuid,
  stripOwnerSpecificState,
  stripTransientCaches,
  rewriteEffectOrigin,
  rewriteEffectOrigins
} from "./sanitization.js";

import { MODULE_ID, MODULE_TITLE } from "./constants.js";

// ============================================================
// Fixtures
// ============================================================

/**
 * Build a fresh "kitchen sink" item data fixture. Exercises every
 * sanitization concern in one structure.
 */
function makeKitchenSinkFixture() {
  return {
    _id: "ORIGINAL_ID_xxxx",
    name: "Flame Tongue Longsword",
    type: "weapon",
    img: "icons/weapons/swords/sword-broad-gold.webp",
    system: {
      quantity: 1,
      weight: { value: 3, units: "lb" },
      price: { value: 5000, denomination: "gp" },
      rarity: "rare",
      identified: true,
      equipped: true,
      attuned: true,
      attunement: 2,
      damage: { parts: [["1d8 + @mod", "slashing"]] },
      properties: ["mgc", "ver"],
      uses: { value: 3, max: 3, per: "day" }
    },
    flags: {
      "midi-qol": {
        advantage: { all: { value: true } },
        disadvantage: { attack: { all: false } },
        lastSelectedTokenIds: ["tok1", "tok2"],
        macroCalls: { onAttack: "..." },
        cached: { rollData: { foo: "bar" } },
        // A non-runtime config that should survive:
        keepThisOne: true
      },
      dae: {
        cached: { transferEffects: ["..."] },
        // A non-cached config:
        macroRepeat: "once"
      },
      [MODULE_ID]: {
        hidden: true,
        someStaleData: { foo: "bar" }
      },
      core: {
        sourceId: "Compendium.dnd5e.items.someSourceId"
      }
    },
    effects: [
      {
        // Effect 1: origin points to source item — should rewrite
        _id: "EFFECT_ONE_xxxx",
        name: "Flame Tongue Glow",
        origin: "Actor.SOURCE_ACTOR_ID.Item.ORIGINAL_ID_xxxx",
        changes: [],
        disabled: false,
        transfer: true
      },
      {
        // Effect 2: origin is a sub-reference to source item — should rewrite with suffix preserved
        _id: "EFFECT_TWO_xxxx",
        name: "Flame Tongue Aura",
        origin: "Actor.SOURCE_ACTOR_ID.Item.ORIGINAL_ID_xxxx.ActiveEffect.SUBREF_xxxx",
        changes: [],
        disabled: false,
        transfer: false
      },
      {
        // Effect 3: origin points to a different actor — should NOT rewrite
        name: "Cursed By Hag",
        origin: "Actor.OTHER_ACTOR_ID.Item.HAG_CURSE_xxxx",
        changes: [],
        disabled: false,
        transfer: false
        // Note: no _id, sanitize should add one
      },
      {
        // Effect 4: no origin — should NOT touch origin field
        _id: "EFFECT_FOUR_xxxx",
        name: "Anonymous Effect",
        changes: [],
        disabled: true,
        transfer: false
      },
      {
        // Effect 5: empty string origin — should NOT touch
        _id: "EFFECT_FIVE_xxxx",
        name: "Empty Origin",
        origin: "",
        changes: [],
        disabled: false,
        transfer: false
      }
    ]
  };
}

/**
 * Mock destination actor for sanitize tests. Real actor not needed —
 * sanitize only uses the `id` field.
 */
const MOCK_DEST_ACTOR = { id: "DEST_ACTOR_ID" };
const SOURCE_ITEM_UUID = "Actor.SOURCE_ACTOR_ID.Item.ORIGINAL_ID_xxxx";

// ============================================================
// Test runner infrastructure
// ============================================================

function makeTestContext() {
  const results = [];
  return {
    results,
    assert(name, condition, details = null) {
      const pass = Boolean(condition);
      results.push({ name, pass, details });
    },
    assertEq(name, actual, expected) {
      const pass = JSON.stringify(actual) === JSON.stringify(expected);
      results.push({
        name,
        pass,
        details: pass ? null : { actual, expected }
      });
    },
    assertThrows(name, fn) {
      let threw = false;
      let err = null;
      try { fn(); } catch (e) { threw = true; err = e; }
      results.push({
        name,
        pass: threw,
        details: threw ? null : "expected function to throw"
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

export async function runStep7Tests() {
  const t = makeTestContext();

  // --- Section: ID generation and basics ---

  t.assert("generateItemId returns a 16-char string",
    typeof generateItemId() === "string" && generateItemId().length === 16
  );

  const id1 = generateItemId();
  const id2 = generateItemId();
  t.assert("generateItemId produces unique IDs", id1 !== id2);

  t.assertEq("buildItemUuid composes correctly",
    buildItemUuid({ id: "AAA" }, "BBB"),
    "Actor.AAA.Item.BBB"
  );

  t.assertThrows("buildItemUuid throws on missing actor id",
    () => buildItemUuid({}, "BBB")
  );

  t.assertThrows("buildItemUuid throws on empty itemId",
    () => buildItemUuid({ id: "AAA" }, "")
  );

  // --- Section: sanitizeItemForTransfer top-level behavior ---

  t.assertThrows("sanitize throws on null sourceData",
    () => sanitizeItemForTransfer(null, MOCK_DEST_ACTOR)
  );

  t.assertThrows("sanitize throws on missing destination actor",
    () => sanitizeItemForTransfer({}, null)
  );

  // Input immutability check
  const original = makeKitchenSinkFixture();
  const originalClone = foundry.utils.deepClone(original);
  sanitizeItemForTransfer(original, MOCK_DEST_ACTOR, {
    sourceItemUuid: SOURCE_ITEM_UUID
  });
  t.assertEq("sanitize does not mutate the input",
    original, originalClone
  );

  // Standard sanitization run for the rest of the tests
  const cleaned = sanitizeItemForTransfer(
    makeKitchenSinkFixture(),
    MOCK_DEST_ACTOR,
    { sourceItemUuid: SOURCE_ITEM_UUID }
  );

  // --- Section: _id generation ---

  t.assert("sanitized data has a fresh _id",
    typeof cleaned._id === "string" && cleaned._id.length === 16
  );

  t.assert("sanitized _id is not the source _id",
    cleaned._id !== "ORIGINAL_ID_xxxx"
  );

  // --- Section: owner-specific state ---

  t.assertEq("equipped reset to false",
    cleaned.system.equipped, false
  );

  t.assertEq("attuned (boolean) reset to false",
    cleaned.system.attuned, false
  );

  t.assertEq("attunement (numeric) 2 → 1 (keeps required, drops attuned-by-owner)",
    cleaned.system.attunement, 1
  );

  // Test the other attunement values explicitly
  const cleanedNoAttune = sanitizeItemForTransfer(
    { system: { attunement: 0 } },
    MOCK_DEST_ACTOR
  );
  t.assertEq("attunement 0 stays 0",
    cleanedNoAttune.system.attunement, 0
  );

  const cleanedReqAttune = sanitizeItemForTransfer(
    { system: { attunement: 1 } },
    MOCK_DEST_ACTOR
  );
  t.assertEq("attunement 1 stays 1",
    cleanedReqAttune.system.attunement, 1
  );

  // --- Section: preservation of non-owner fields ---

  t.assertEq("quantity preserved",
    cleaned.system.quantity, 1
  );

  t.assertEq("weight object preserved",
    cleaned.system.weight, { value: 3, units: "lb" }
  );

  t.assertEq("uses.value preserved (current charges persist)",
    cleaned.system.uses.value, 3
  );

  t.assertEq("rarity preserved",
    cleaned.system.rarity, "rare"
  );

  t.assertEq("identified preserved",
    cleaned.system.identified, true
  );

  // --- Section: module cache stripping ---

  t.assert("midi-qol runtime caches removed (advantage)",
    cleaned.flags["midi-qol"]?.advantage === undefined
  );

  t.assert("midi-qol runtime caches removed (lastSelectedTokenIds)",
    cleaned.flags["midi-qol"]?.lastSelectedTokenIds === undefined
  );

  t.assert("midi-qol runtime caches removed (cached)",
    cleaned.flags["midi-qol"]?.cached === undefined
  );

  t.assert("midi-qol non-cache config preserved",
    cleaned.flags["midi-qol"]?.keepThisOne === true
  );

  t.assert("dae.cached removed",
    cleaned.flags.dae?.cached === undefined
  );

  t.assert("dae non-cache config preserved",
    cleaned.flags.dae?.macroRepeat === "once"
  );

  t.assert("core.sourceId preserved (untouched namespace)",
    cleaned.flags.core?.sourceId === "Compendium.dnd5e.items.someSourceId"
  );

  // --- Section: quartermaster flag handling ---

  t.assertEq("quartermaster.hidden preserved by default",
    cleaned.flags[MODULE_ID]?.hidden, true
  );

  t.assert("quartermaster.someStaleData cleared",
    cleaned.flags[MODULE_ID]?.someStaleData === undefined
  );

  // Test with preserveHiddenFlag: false
  const cleanedNoHidden = sanitizeItemForTransfer(
    makeKitchenSinkFixture(),
    MOCK_DEST_ACTOR,
    { sourceItemUuid: SOURCE_ITEM_UUID, preserveHiddenFlag: false }
  );
  t.assert("preserveHiddenFlag:false clears entire quartermaster namespace",
    cleanedNoHidden.flags[MODULE_ID] === undefined
  );

  // --- Section: effect origin rewriting ---

  const destItemUuid = buildItemUuid(MOCK_DEST_ACTOR, cleaned._id);

  t.assertEq("Effect 1: exact-match origin rewritten to destination",
    cleaned.effects[0].origin, destItemUuid
  );

  t.assertEq("Effect 2: sub-reference origin rewritten with suffix preserved",
    cleaned.effects[1].origin,
    `${destItemUuid}.ActiveEffect.SUBREF_xxxx`
  );

  t.assertEq("Effect 3: non-matching origin left untouched",
    cleaned.effects[2].origin,
    "Actor.OTHER_ACTOR_ID.Item.HAG_CURSE_xxxx"
  );

  t.assert("Effect 3: missing _id was assigned",
    typeof cleaned.effects[2]._id === "string" && cleaned.effects[2]._id.length === 16
  );

  t.assert("Effect 4: missing origin not invented",
    cleaned.effects[3].origin === undefined
  );

  t.assertEq("Effect 5: empty-string origin stays empty",
    cleaned.effects[4].origin, ""
  );

  // --- Section: edge cases ---

  const minimalItem = sanitizeItemForTransfer(
    { name: "Bare Item" },
    MOCK_DEST_ACTOR
  );
  t.assert("Item with no system field sanitizes without error",
    typeof minimalItem._id === "string"
  );

  const noEffectsItem = sanitizeItemForTransfer(
    { name: "No Effects", system: { equipped: true } },
    MOCK_DEST_ACTOR
  );
  t.assertEq("Item without effects: no effects field added",
    Array.isArray(noEffectsItem.effects), false
  );
  t.assertEq("Item without effects still gets state stripped",
    noEffectsItem.system.equipped, false
  );

  // --- Section: rewriteEffectOrigins batch helper ---

  const batchResult = rewriteEffectOrigins(
    [
      { origin: SOURCE_ITEM_UUID },
      { origin: "Actor.OTHER.Item.X" }
    ],
    SOURCE_ITEM_UUID,
    "Actor.DEST.Item.NEW"
  );
  t.assertEq("Batch: first effect rewritten",
    batchResult[0].origin, "Actor.DEST.Item.NEW"
  );
  t.assertEq("Batch: second effect untouched",
    batchResult[1].origin, "Actor.OTHER.Item.X"
  );
  t.assertEq("Batch helper handles empty array",
    rewriteEffectOrigins([], "any", "thing"), []
  );
  t.assertEq("Batch helper handles non-array input",
    rewriteEffectOrigins(null, "any", "thing"), []
  );

  // --- Section: when sourceItemUuid not provided ---

  const noSourceUuid = sanitizeItemForTransfer(
    makeKitchenSinkFixture(),
    MOCK_DEST_ACTOR
    // intentionally no sourceItemUuid
  );
  t.assertEq(
    "Without sourceItemUuid, origins are not rewritten",
    noSourceUuid.effects[0].origin,
    "Actor.SOURCE_ACTOR_ID.Item.ORIGINAL_ID_xxxx"
  );

  printResults(`${MODULE_TITLE} | Step 7 Sanitization Tests`, t.results);
  return t.results;
}
