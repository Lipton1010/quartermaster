import test from "node:test";
import assert from "node:assert/strict";

import { CHOICES, FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";

const settingValues = new Map([
  [SETTINGS.ENFORCE_CAPACITY, false],
  [SETTINGS.CAPACITY_LIMIT, 500],
  [SETTINGS.APPLY_CURRENCY_WEIGHT, true],
  [SETTINGS.HIDE_ZERO_BALANCES, false],
  [SETTINGS.SORT_ORDER, CHOICES.SORT_ORDER.ALPHABETICAL],
  [SETTINGS.DEFAULT_ENTRY_SIZE, CHOICES.ENTRY_SIZE.MEDIUM],
  [SETTINGS.UNIDENTIFIED_DISPLAY, CHOICES.UNIDENTIFIED_DISPLAY.UNIDENTIFIED],
  [SETTINGS.INVENTORY_BUTTON_LABEL, "Shared Party Inventory"],
  [SETTINGS.INVENTORY_BACKGROUND_IMAGE, ""],
  [SETTINGS.HIDE_PRICES_FROM_PLAYERS, false],
  [SETTINGS.HIDE_ELECTRUM, false]
]);

globalThis.CONFIG = { Actor: {}, Item: {} };
globalThis.game = {
  system: { id: "dnd5e" },
  user: { isGM: true },
  i18n: { localize: key => key },
  settings: {
    get(_scope, key) { return settingValues.get(key); },
    storage: { get: () => new Map() }
  }
};

const { buildInventoryContext } = await import("../scripts/inventory-rendering.js");
const { recomputeTotals } = await import("../scripts/weight-cache.js");

test("hidden balances remain part of load while staying out of rendered currencies", () => {
  game.system.id = "dnd5e";
  const currencyConfig = {
    version: 3,
    systemId: "dnd5e",
    referenceCurrencyId: "gp",
    standard: {
      gp: { hidden: false, referenceRate: 1 },
      ep: { hidden: true, referenceRate: 0.5 }
    },
    custom: [{
      id: "hidden-custom",
      name: "Hidden Custom",
      symbol: "HC",
      value: 2,
      hidden: true,
      referenceRate: 1,
      weightPerUnit: 0.5,
      createdAt: 1,
      order: 10
    }]
  };
  const actor = {
    id: "vault-loads",
    uuid: "Actor.vault-loads",
    name: "Vault",
    system: { currency: { pp: 0, gp: 0, ep: 50, sp: 0, cp: 0 } },
    items: [],
    getFlag(scope, key) {
      if (scope !== MODULE_ID) return undefined;
      if (key === FLAGS.CURRENCY_CONFIG) return currencyConfig;
      if (key === FLAGS.CUSTOM_RESOURCES) return [];
      return undefined;
    }
  };

  const context = buildInventoryContext(actor);
  assert.equal(context.currencies.some(currency => currency.id === "ep"), false);
  assert.equal(context.currencies.some(currency => currency.id === "hidden-custom"), false);
  assert.equal(context.totals.currencyLoad, 2);
  assert.equal(context.totals.totalLoad, 2);
});

test("inventory context isGM reflects the active storage-GM election, not raw user.isGM", () => {
  game.system.id = "dnd5e";
  const previousUser = game.user;
  const previousUsers = game.users;
  const actor = {
    id: "vault-election",
    uuid: "Actor.vault-election",
    name: "Vault",
    system: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } },
    items: [],
    getFlag() { return undefined; }
  };

  try {
    game.user = { id: "gm-waiting", isGM: true };
    game.users = { activeGM: { id: "gm-active", isGM: true } };
    assert.equal(buildInventoryContext(actor).isGM, false);

    game.users = { activeGM: { id: "gm-waiting", isGM: true } };
    assert.equal(buildInventoryContext(actor).isGM, true);
  } finally {
    game.user = previousUser;
    game.users = previousUsers;
  }
});

test("weight cache delegates PF2e item load to the native aggregate and removes coin Bulk", () => {
  game.system.id = "pf2e";
  const actor = {
    id: "pf2e-vault-loads",
    uuid: "Actor.pf2e-vault-loads",
    items: [],
    inventory: {
      coins: { pp: 0, gp: 1000, sp: 0, cp: 0 },
      bulk: { value: { value: 3.4 } }
    }
  };

  const totals = recomputeTotals(actor);
  assert.equal(totals.itemLoad, 2.4);
  assert.equal(totals.coinSum, 1000);
});
