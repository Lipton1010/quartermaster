import test from "node:test";
import assert from "node:assert/strict";

import { FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";

class ItemCollection extends Map {
  find(predicate) { return [...this.values()].find(predicate) ?? null; }
}

class FakeActor {
  constructor(id, marker) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.flags = { [MODULE_ID]: { [marker]: true } };
  }
  getFlag(module, key) { return this.flags[module]?.[key]; }
  async setFlag(module, key, value) {
    this.flags[module] ??= {};
    // Mirrors real Foundry flag persistence: undefined-valued keys are
    // dropped on write, unlike a structural (non-JSON) clone.
    this.flags[module][key] = JSON.parse(JSON.stringify(value));
    return value;
  }
}

// Preserves undefined-valued keys, matching foundry.utils.deepClone's real
// behavior (a structured clone, not a JSON round-trip).
function deepCloneWithUndefined(value) {
  if (Array.isArray(value)) return value.map(deepCloneWithUndefined);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) result[key] = deepCloneWithUndefined(value[key]);
    return result;
  }
  return value;
}

function installWorld() {
  const backing = new FakeActor("shared", FLAGS.BACKING_ACTOR_MARKER);
  const staging = new FakeActor("private", FLAGS.STAGING_ACTOR_MARKER);
  const actors = new Map([[backing.id, backing], [staging.id, staging]]);
  actors.find = predicate => [...actors.values()].find(predicate) ?? null;
  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm", isGM: true } },
    actors,
    settings: {
      get(_scope, key) {
        if (key === SETTINGS.BACKING_ACTOR_ID) return backing.id;
        if (key === SETTINGS.STAGING_ACTOR_ID) return staging.id;
        if (key === SETTINGS.TRANSACTION_LOG_CAP) return 0;
        return null;
      }
    }
  };
  globalThis.foundry = { utils: { randomID: () => `id-${Math.random().toString(36).slice(2)}`, deepClone: deepCloneWithUndefined } };
  globalThis.Hooks = { callAll() {} };
  return { backing, staging };
}

test("a raw Item snapshot with an undefined leaf does not fail transaction-log write verification", async (t) => {
  const previousGame = globalThis.game;
  const previousFoundry = globalThis.foundry;
  const previousHooks = globalThis.Hooks;
  t.after(() => {
    globalThis.game = previousGame;
    globalThis.foundry = previousFoundry;
    globalThis.Hooks = previousHooks;
  });
  installWorld();
  const { writeEntry } = await import("../scripts/transaction-log.js");

  // Reproduces the live Foundry v14.365/PF2e and Custom System Builder defect:
  // a real Item's system data can carry a schema-defined but unset field as
  // literal `undefined` (e.g. PF2e Treasure's system.price.sizeSensitive).
  const written = await writeEntry({
    type: "item.egress",
    itemName: "Treasure",
    itemSnapshot: {
      _id: "treasure1",
      name: "Treasure",
      system: { price: { value: 5, sizeSensitive: undefined } }
    }
  });

  assert.ok(written, "writeEntry should succeed instead of throwing canonical-transaction-log-verification-failed");
  assert.equal(written.itemSnapshot.system.price.value, 5);
});

test("a genuinely different transaction-log write still fails verification", async (t) => {
  const previousGame = globalThis.game;
  const previousFoundry = globalThis.foundry;
  const previousHooks = globalThis.Hooks;
  t.after(() => {
    globalThis.game = previousGame;
    globalThis.foundry = previousFoundry;
    globalThis.Hooks = previousHooks;
  });
  const { staging } = installWorld();
  const { writeEntry } = await import("../scripts/transaction-log.js");

  // Force the post-write read-back to diverge from what was written, so the
  // verification path still fails closed on a real mismatch.
  const originalSetFlag = staging.setFlag.bind(staging);
  staging.setFlag = async (module, key, value) => {
    await originalSetFlag(module, key, value);
    if (key === FLAGS.TRANSACTION_LOG) {
      const corrupted = staging.flags[module][key].map(entry => ({ ...entry, itemName: "corrupted" }));
      staging.flags[module][key] = corrupted;
    }
  };

  await assert.rejects(
    () => writeEntry({ type: "item.egress", itemName: "Treasure" }),
    /canonical-transaction-log-verification-failed/
  );
});
