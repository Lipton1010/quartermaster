import test from "node:test";
import assert from "node:assert/strict";

import { SYSTEM_ADAPTER_API_VERSION } from "../scripts/constants.js";
import {
  getActiveSystemAdapter,
  getSystemAdapter,
  registerSystemAdapter,
  validateAdapter
} from "../scripts/system-adapters/registry.js";
import { genericAdapter } from "../scripts/system-adapters/generic.js";
import { dnd5eAdapter } from "../scripts/system-adapters/dnd5e.js";
import { pf2eAdapter } from "../scripts/system-adapters/pf2e.js";

test("generic adapter preserves unknown Item data and omits unsupported metadata", () => {
  const source = {
    name: "Strange Relic",
    type: "relic",
    system: { opaque: { nested: [1, 2, 3] } },
    flags: {
      anotherModule: { state: true },
      "midi-qol": { cached: { opaque: true } },
      dae: { cached: { opaque: true } }
    }
  };
  const prepared = genericAdapter.prepareItemForTransfer(source);
  assert.deepEqual(prepared, source);
  assert.notEqual(prepared, source);
  prepared.system.opaque.nested.push(4);
  assert.deepEqual(source.system.opaque.nested, [1, 2, 3]);
  assert.deepEqual(prepared.flags["midi-qol"], { cached: { opaque: true } });
  assert.deepEqual(prepared.flags.dae, { cached: { opaque: true } });

  const normalized = genericAdapter.normalizeItem(source);
  assert.equal(normalized.totalLoad, null);
  assert.equal(normalized.priceDisplay, null);
  assert.equal(normalized.isIdentified, null);
  assert.equal(normalized.showQuantity, false);
  assert.equal(genericAdapter.computeItemLoad({ items: [source] }), 0);
});

test("D&D 5e adapter retains v0.1.8 quantity, weight, price, and currency behavior", async () => {
  const item = {
    id: "sword",
    name: "Named Sword",
    type: "weapon",
    system: {
      quantity: 2,
      weight: { value: 3 },
      identified: false,
      unidentified: { name: "Mysterious Blade" },
      price: { value: 5, denomination: "gp" }
    }
  };
  const normalized = dnd5eAdapter.normalizeItem(item);
  assert.equal(normalized.name, "Mysterious Blade");
  assert.equal(normalized.quantity, 2);
  assert.equal(normalized.totalLoad, 6);
  assert.equal(normalized.loadDisplay, "6 lb");
  assert.equal(normalized.priceDisplay, "10 GP");

  const updates = [];
  const actor = {
    system: { currency: { gp: 12 } },
    items: [item],
    async update(change) { updates.push(change); }
  };
  assert.equal(dnd5eAdapter.computeItemLoad(actor), 6);
  assert.equal(dnd5eAdapter.listNativeCurrencies(actor).find(c => c.id === "gp").value, 12);
  assert.deepEqual(await dnd5eAdapter.applyNativeCurrencyDelta(actor, "gp", -2), {
    ok: true,
    previousValue: 12,
    newValue: 10
  });
  assert.deepEqual(updates, [{ "system.currency.gp": 10 }]);
  assert.deepEqual(await dnd5eAdapter.applyNativeCurrencyDelta(actor, "gp", 0.5), {
    ok: false,
    error: "whole-coins-required"
  });
  assert.deepEqual(updates, [{ "system.currency.gp": 10 }]);
  assert.equal(dnd5eAdapter.computeNativeCurrencyLoad([
    { source: "native", value: 50 },
    { source: "native", value: 25 }
  ]), 1.5);

  const prepared = dnd5eAdapter.prepareItemForTransfer({
    system: { equipped: true, attuned: true, preparation: { prepared: true } },
    flags: { "midi-qol": { cached: true, keep: "yes" }, dae: { cached: true } }
  });
  assert.equal(prepared.system.equipped, false);
  assert.equal(prepared.system.attuned, false);
  assert.equal(prepared.system.preparation.prepared, false);
  assert.deepEqual(prepared.flags["midi-qol"], { keep: "yes" });
  assert.equal("dae" in prepared.flags, false);

  const committedActor = {
    system: { currency: { gp: 5 } },
    async update(change) {
      this.system.currency.gp = change["system.currency.gp"];
      throw new Error("post-update hook failed");
    }
  };
  const committed = await dnd5eAdapter.applyNativeCurrencyDelta(committedActor, "gp", 2);
  assert.equal(committed.ok, true);
  assert.equal(committed.newValue, 7);
  assert.equal(committed.committedAfterError, true);
});

test("PF2e adapter uses loot Actors, native coin APIs, Bulk, and coin filtering", async () => {
  assert.equal(pf2eAdapter.getRecommendedVaultActorType(["character", "loot"]), "loot");
  assert.equal(pf2eAdapter.defaultCapacity.enforced, false);
  assert.equal(pf2eAdapter.isNativeCurrencyItem({
    type: "treasure",
    system: { stackGroup: "coins" }
  }), true);

  const calls = [];
  const actor = {
    inventory: {
      coins: { pp: 0, gp: 4, sp: 0, cp: 0 },
      async addCurrency(coins, options) { calls.push(["add", coins, options]); },
      async removeCurrency(coins, options) { calls.push(["remove", coins, options]); return true; }
    }
  };
  assert.equal((await pf2eAdapter.applyNativeCurrencyDelta(actor, "gp", 3)).newValue, 7);
  assert.equal((await pf2eAdapter.applyNativeCurrencyDelta(actor, "gp", -2)).newValue, 2);
  assert.deepEqual(calls.map(call => call[0]), ["add", "remove"]);

  assert.equal(pf2eAdapter.computeNativeCurrencyLoad([
    { source: "native", value: 500 },
    { source: "native", value: 500 }
  ]), 1);
  assert.equal(pf2eAdapter.formatLoad(0.1), "L");

  const aggregateActor = {
    items: [],
    inventory: {
      coins: { pp: 0, gp: 1000, sp: 0, cp: 0 },
      bulk: { value: { value: 3.1 } }
    }
  };
  assert.equal(pf2eAdapter.computeItemLoad(aggregateActor), 2.1);

  const committedActor = {
    inventory: {
      coins: { pp: 0, gp: 5, sp: 0, cp: 0 },
      async addCoins(coins) {
        this.coins.gp += coins.gp;
        throw new Error("post-create hook failed");
      }
    }
  };
  const committed = await pf2eAdapter.applyNativeCurrencyDelta(committedActor, "gp", 2);
  assert.equal(committed.ok, true);
  assert.equal(committed.newValue, 7);
  assert.equal(committed.committedAfterError, true);
});

test("registry selects built-ins and validates future integrations", () => {
  assert.equal(SYSTEM_ADAPTER_API_VERSION, 2);
  globalThis.game = { system: { id: "dnd5e" } };
  assert.equal(getActiveSystemAdapter(), dnd5eAdapter);
  globalThis.game.system.id = "unknown-system";
  assert.equal(getActiveSystemAdapter(), genericAdapter);
  assert.equal(getSystemAdapter("pf2e"), pf2eAdapter);

  assert.throws(() => validateAdapter({
    apiVersion: SYSTEM_ADAPTER_API_VERSION,
    id: "incomplete",
    systemId: "incomplete",
    capabilities: {}
  }), /missing/);

  const custom = {
    ...genericAdapter,
    id: "test-custom",
    systemId: "test-custom"
  };
  registerSystemAdapter(custom);
  assert.equal(getSystemAdapter("test-custom"), custom);
  assert.throws(() => registerSystemAdapter(custom), /already has/);
});
