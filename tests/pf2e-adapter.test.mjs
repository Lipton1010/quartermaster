import test from "node:test";
import assert from "node:assert/strict";

import { CHOICES } from "../scripts/constants.js";
import { pf2eAdapter } from "../scripts/system-adapters/pf2e.js";

test("PF2e coin Bulk combines denominations in one 1,000-coin stack", () => {
  assert.equal(pf2eAdapter.computeNativeCurrencyLoad([
    { id: "pp", source: "native", value: 249 },
    { id: "gp", source: "native", value: 250 },
    { id: "sp", source: "native", value: 250 },
    { id: "cp", source: "native", value: 250 }
  ]), 0);
  assert.equal(pf2eAdapter.computeNativeCurrencyLoad([
    { id: "pp", source: "native", value: 250 },
    { id: "gp", source: "native", value: 250 },
    { id: "sp", source: "native", value: 250 },
    { id: "cp", source: "native", value: 250 }
  ]), 1);
  assert.equal(pf2eAdapter.computeNativeCurrencyLoad([
    { id: "pp", source: "native", value: 500 },
    { id: "gp", source: "native", value: 500 },
    { id: "sp", source: "native", value: 500 },
    { id: "cp", source: "native", value: 500 }
  ]), 2);

  const actor = {
    items: [],
    inventory: {
      currency: { pp: 250, gp: 250, sp: 250, cp: 250 },
      bulk: { value: { value: 3.4 } }
    }
  };
  assert.equal(pf2eAdapter.computeItemLoad(actor), 2.4);
});

test("PF2e adapter prefers current currency APIs and retains alias fallback", async () => {
  const calls = [];
  const inventory = {
    currency: { pp: 0, gp: 5, sp: 0, cp: 0 },
    coins: { pp: 99, gp: 99, sp: 99, cp: 99 },
    async addCurrency(coins, options) {
      calls.push(["addCurrency", coins, options]);
      this.currency.gp += coins.gp;
    },
    async removeCurrency(coins, options) {
      calls.push(["removeCurrency", coins, options]);
      this.currency.gp -= coins.gp;
      return true;
    },
    async addCoins() { throw new Error("deprecated alias should not be called"); },
    async removeCoins() { throw new Error("deprecated alias should not be called"); }
  };
  const actor = { inventory };

  assert.equal(pf2eAdapter.listNativeCurrencies(actor).find(c => c.id === "gp").value, 5);
  assert.deepEqual(await pf2eAdapter.applyNativeCurrencyDelta(actor, "gp", 2), {
    ok: true,
    previousValue: 5,
    newValue: 7
  });
  assert.deepEqual(await pf2eAdapter.applyNativeCurrencyDelta(actor, "gp", -3), {
    ok: true,
    previousValue: 7,
    newValue: 4
  });
  assert.deepEqual(calls.map(call => call[0]), ["addCurrency", "removeCurrency"]);
  assert.deepEqual(calls[1][2], { byValue: false });

  const aliasInventory = {
    coins: { pp: 0, gp: 2, sp: 0, cp: 0 },
    async addCoins(coins) { this.coins.gp += coins.gp; },
    async removeCoins(coins) { this.coins.gp -= coins.gp; return true; }
  };
  assert.equal((await pf2eAdapter.applyNativeCurrencyDelta({ inventory: aliasInventory }, "gp", 1)).newValue, 3);
  assert.equal((await pf2eAdapter.applyNativeCurrencyDelta({ inventory: aliasInventory }, "gp", -2)).newValue, 1);
});

test("PF2e Item normalization uses prepared quantity, Bulk, value, and identification APIs", () => {
  const item = {
    id: "mystery",
    type: "equipment",
    name: "Unidentified Object",
    img: "icons/mystery.webp",
    quantity: 3,
    identificationStatus: "unidentified",
    assetValue: { pp: 0, gp: 6, sp: 0, cp: 0 },
    bulk: {
      value: 0.3,
      toString() { return "3L"; }
    },
    _source: { name: "Greater Mystery" },
    system: {
      identification: {
        status: "unidentified",
        unidentified: { name: "Mysterious Object", img: "icons/unknown.webp" }
      }
    }
  };

  const hidden = pf2eAdapter.normalizeItem(item);
  assert.equal(hidden.name, "Mysterious Object");
  assert.equal(hidden.rawName, "Greater Mystery");
  assert.equal(hidden.quantity, 3);
  assert.equal(hidden.totalLoad, 0.3);
  assert.equal(hidden.loadDisplay, "3L");
  assert.equal(hidden.priceDisplay, "6 GP");
  assert.equal(hidden.isIdentified, false);

  const revealed = pf2eAdapter.normalizeItem(item, {
    unidentifiedDisplay: CHOICES.UNIDENTIFIED_DISPLAY.IDENTIFIED
  });
  assert.equal(revealed.name, "Greater Mystery");
});

test("PF2e coin filtering recognizes live and source Item forms without hiding other treasure", () => {
  assert.equal(pf2eAdapter.isNativeCurrencyItem({
    type: "treasure",
    isCoinage: true,
    isOfType: type => type === "treasure"
  }), true);
  assert.equal(pf2eAdapter.isNativeCurrencyItem({
    type: "treasure",
    system: { category: "coin" }
  }), true);
  assert.equal(pf2eAdapter.isNativeCurrencyItem({
    type: "treasure",
    system: { stackGroup: "coins" }
  }), true);
  assert.equal(pf2eAdapter.isNativeCurrencyItem({
    type: "treasure",
    isCurrency: true,
    isCoinage: false,
    system: { category: "gem" }
  }), false);
});
