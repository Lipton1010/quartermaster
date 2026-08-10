import test from "node:test";
import assert from "node:assert/strict";

const activeGm = { id: "gm", isGM: true };

globalThis.game = {
  system: { id: "dnd5e" },
  user: activeGm,
  users: { activeGM: activeGm },
  settings: {
    get(moduleId, key) {
      if (key === "hideElectrum") return false;
      if (key === "currencyApprovalThreshold") return 50;
      return null;
    },
    async set() {}
  }
};

const {
  CURRENCY_CONFIG_VERSION,
  applyCurrencyDelta,
  ensureCurrencyConfig,
  getCurrencies,
  getCurrencyConfig
} = await import("../scripts/currencies.js");

function createActor({ system = {}, flag = null, inventory = null } = {}) {
  const writes = [];
  const updates = [];
  const actor = {
    id: "vault",
    system,
    inventory,
    getFlag() { return flag; },
    async setFlag(moduleId, key, value) { writes.push({ moduleId, key, value }); flag = value; },
    async update(change) { updates.push(change); }
  };
  return { actor, writes, updates };
}

test("currency config v3 preserves the D&D facade and annotates native records", async () => {
  game.system.id = "dnd5e";
  const legacy = {
    version: 2,
    referenceCurrencyId: "gp",
    standard: { gp: { hidden: false, referenceRate: 1 } },
    custom: [{ id: "credits", name: "Credits", symbol: "CR", value: 9, referenceRate: 2 }]
  };
  const { actor, writes, updates } = createActor({
    system: { currency: { pp: 1, gp: 12, ep: 0, sp: 3, cp: 4 } },
    flag: legacy
  });

  const config = getCurrencyConfig(actor);
  assert.equal(config.version, CURRENCY_CONFIG_VERSION);
  assert.equal(config.systemId, "dnd5e");
  assert.equal(config.custom[0].id, "credits");

  const currencies = getCurrencies(actor);
  assert.equal(currencies.find(currency => currency.id === "gp").source, "native");
  assert.equal(currencies.find(currency => currency.id === "gp").systemId, "dnd5e");
  assert.equal(currencies.find(currency => currency.id === "credits").source, "custom");
  assert.equal(currencies.find(currency => currency.id === "credits").gpRate, 2);

  assert.equal(await ensureCurrencyConfig(actor), true);
  assert.equal(writes[0].value.version, 3);
  assert.equal((await applyCurrencyDelta("gp", -2, actor)).newValue, 10);
  assert.deepEqual(updates, [{ "system.currency.gp": 10 }]);
});

test("PF2e currency facade uses exact-denomination inventory APIs", async () => {
  game.system.id = "pf2e";
  const calls = [];
  const { actor } = createActor({
    inventory: {
      coins: { pp: 1, gp: 7, sp: 3, cp: 2 },
      async addCoins(coins, options) { calls.push(["add", coins, options]); },
      async removeCoins(coins, options) { calls.push(["remove", coins, options]); return true; }
    }
  });

  const currencies = getCurrencies(actor);
  assert.deepEqual(currencies.filter(currency => !currency.isCustom).map(currency => currency.id), [
    "pp", "gp", "sp", "cp"
  ]);
  assert.equal((await applyCurrencyDelta("gp", -2, actor)).status, "success");
  assert.deepEqual(calls, [["remove", { gp: 2 }, { byValue: false }]]);
  assert.equal((await applyCurrencyDelta("gp", 0.5, actor)).error, "whole-coins-required");
});

test("generic systems receive one editable custom Currency/CUR balance", () => {
  game.system.id = "custom-system";
  const { actor } = createActor();
  const currencies = getCurrencies(actor);
  assert.equal(currencies.length, 1);
  assert.equal(currencies[0].name, "Currency");
  assert.equal(currencies[0].symbol, "CUR");
  assert.equal(currencies[0].source, "custom");
  assert.equal(currencies[0].systemId, null);
  assert.equal(currencies[0].isReference, true);
});
