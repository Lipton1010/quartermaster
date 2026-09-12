import test from "node:test";
import assert from "node:assert/strict";
import { FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";

const clone = value => JSON.parse(JSON.stringify(value));

class Collection extends Map {
  [Symbol.iterator]() { return this.values(); }
  find(fn) { return [...this.values()].find(fn); }
  filter(fn) { return [...this.values()].filter(fn); }
  map(fn) { return [...this.values()].map(fn); }
}

class Item {
  constructor(data, parent) {
    Object.assign(this, clone(data));
    this.id = data._id;
    this.documentName = "Item";
    this.parent = parent;
    this.uuid = `${parent.uuid}.Item.${this.id}`;
    this.flags ??= {};
  }
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  async setFlag(scope, key, value) { (this.flags[scope] ??= {})[key] = clone(value); }
  async unsetFlag(scope, key) { delete this.flags[scope]?.[key]; }
  toObject() {
    return clone({ _id: this.id, name: this.name, type: this.type, system: this.system ?? {}, flags: this.flags });
  }
}

class Actor {
  constructor(id, marker = null) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.documentName = "Actor";
    this.type = "character";
    this.name = id;
    this.items = new Collection();
    this.system = { currency: { gp: 10, pp: 0, ep: 0, sp: 0, cp: 0 } };
    this.flags = { [MODULE_ID]: marker ? { [marker]: true } : {} };
    this.inventory = {
      currency: { gp: 10, pp: 0, sp: 0, cp: 0 },
      addCurrency: async coins => {
        if (this.currencyMode === "cancel") return [];
        this.inventory.currency.gp += this.currencyMode === "partial" ? 2 : coins.gp;
        if (this.currencyMode === "throw-after") throw new Error("currency-after-write");
      },
      removeCurrency: async coins => {
        if (this.currencyMode === "cancel") return false;
        this.inventory.currency.gp -= coins.gp;
        return true;
      }
    };
  }
  add(data) { const item = new Item(data, this); this.items.set(item.id, item); return item; }
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  async setFlag(scope, key, value) {
    if (this.rejectCommitType && key === FLAGS.TRANSACTION_LOG && value.at(-1)?.type === this.rejectCommitType) {
      throw new Error("commit-log-write-failure");
    }
    if (this.rejectRecovery && key === FLAGS.RECOVERY_RECORDS) throw new Error("recovery-write-failure");
    if (key === FLAGS.CURRENCY_CONFIG && this.currencyMode === "cancel") return undefined;
    const stored = clone(value);
    if (key === FLAGS.CURRENCY_CONFIG && this.currencyMode === "partial") {
      stored.custom[0].value = this.flags[scope][key].custom[0].value + 2;
    }
    (this.flags[scope] ??= {})[key] = stored;
    if (key === FLAGS.CURRENCY_CONFIG && this.currencyMode === "throw-after") throw new Error("currency-after-write");
    return this;
  }
  async createEmbeddedDocuments(_type, data) {
    await this.beforeCreate?.();
    if (this.createMode === "cancel") return [];
    if (this.createMode === "throw-before") throw new Error("create-before-write");
    const created = data.map(entry => this.add(entry));
    if (this.createMode === "throw-after") throw new Error("create-after-write");
    return created;
  }
  async deleteEmbeddedDocuments(_type, ids) {
    if (this.deleteMode === "cancel") return [];
    const deleted = ids.map(id => this.items.get(id)).filter(Boolean);
    for (const id of ids) this.items.delete(id);
    return deleted;
  }
  async update(changes) {
    if (this.currencyMode === "cancel") return undefined;
    for (const [key, value] of Object.entries(changes)) {
      if (key.startsWith("system.currency.")) {
        const currency = key.split(".").at(-1);
        this.system.currency[currency] = this.currencyMode === "partial" ? this.system.currency[currency] + 2 : value;
      }
    }
    if (this.currencyMode === "throw-after") throw new Error("currency-after-write");
    return this;
  }
  testUserPermission() { return this.owned !== false; }
}

function installWorld(systemId = "dnd5e") {
  let nextId = 0;
  const backing = new Actor("vault", FLAGS.BACKING_ACTOR_MARKER);
  const staging = new Actor("staging", FLAGS.STAGING_ACTOR_MARKER);
  backing.type = staging.type = systemId === "dnd5e" ? "npc" : systemId === "pf2e" ? "loot" : "character";
  const hero = new Actor("hero");
  const actors = new Collection([[backing.id, backing], [staging.id, staging], [hero.id, hero]]);
  const gm = { id: "gm", isGM: true };
  const player = { id: "player", isGM: false };
  const users = new Collection([[gm.id, gm], [player.id, player]]);
  users.activeGM = gm;
  const settings = new Map([
    [SETTINGS.BACKING_ACTOR_ID, backing.id], [SETTINGS.STAGING_ACTOR_ID, staging.id],
    [SETTINGS.TRANSACTION_LOG_VISIBILITY, "all"], [SETTINGS.TRANSACTION_LOG_CAP, 500],
    [SETTINGS.RECENT_REQUEST_CACHE_SIZE, 100], [SETTINGS.REQUEST_AGE_MAX_SECONDS, 300],
    [SETTINGS.MUTATION_RATE_LIMIT_MAX, 0]
  ]);
  globalThis.game = { system: { id: systemId }, user: gm, users, actors, settings: { get: (_scope, key) => settings.get(key) ?? null } };
  globalThis.foundry = {
    applications: { api: { DialogV2: class {} } },
    utils: { deepClone: structuredClone, randomID: () => `audit${String(++nextId).padStart(11, "0")}` }
  };
  globalThis.Hooks = { callAll() {} };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.fromUuid = async uuid => {
    const [, actorId, , itemId] = uuid.split(".");
    return itemId ? actors.get(actorId)?.items.get(itemId) : actors.get(actorId);
  };
  return { backing, staging, hero };
}

installWorld();
const coordinator = await import("../scripts/operation-coordinator.js");
const { _dispatchForTesting, PAYLOAD_TYPES } = await import("../scripts/socket-handler.js");
const { setItemHidden, deleteHiddenItem, stageHiddenItem } = await import("../scripts/hidden-items.js");
const { revealHiddenCurrency } = await import("../scripts/hidden-currency.js");
const { getCurrency, ensureCurrencyConfig } = await import("../scripts/currencies.js");
const { withItemMutationLock } = await import("../scripts/storage-ledger.js");
const { readRecoveryRecords } = await import("../scripts/recovery-records.js");

function world(systemId) {
  const fixture = installWorld(systemId);
  coordinator.initializeCoordinator();
  coordinator._resetCacheForTesting();
  return fixture;
}
function transferEnvelope(item, destination, requestId = "transfer") {
  return { type: PAYLOAD_TYPES.ITEM_TRANSFER, action: "egress", requestId, timestamp: Date.now(), payload: {
    sourceActorUuid: item.parent.uuid, sourceItemUuid: item.uuid, destActorUuid: destination.uuid
  } };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function pauseCreate(actor) {
  const entered = deferred();
  const resume = deferred();
  actor.beforeCreate = async () => { entered.resolve(); await resume.promise; };
  return { entered: entered.promise, resume: resume.resolve };
}
const sourceData = { _id: "gem", name: "One gem", type: "loot" };

test("player egress and a simultaneous GM hide preserve exactly one Item", { timeout: 2000 }, async () => {
  const { backing, staging, hero } = world();
  const source = backing.add(sourceData);
  const gate = pauseCreate(hero);
  const transfer = _dispatchForTesting(transferEnvelope(source, hero), "player");
  await gate.entered;
  const hide = setItemHidden(source.id, true);
  await new Promise(setImmediate);
  gate.resume();
  const [result, hidden] = await Promise.all([transfer, hide]);
  assert.equal(result.status, "success");
  assert.equal(hidden, null);
  assert.equal(backing.items.size, 0);
  assert.equal(staging.items.size, 0);
  assert.equal(hero.items.size, 1);
});

test("an egress queued behind GM hide rechecks its source before creating", { timeout: 2000 }, async () => {
  const { backing, staging, hero } = world();
  const source = backing.add(sourceData);
  const gate = pauseCreate(staging);
  const hide = setItemHidden(source.id, true);
  await gate.entered;
  const transfer = _dispatchForTesting(transferEnvelope(source, hero), "player");
  gate.resume();
  assert.ok(await hide);
  assert.equal((await transfer).status, "failed");
  assert.equal(staging.items.size, 1);
  assert.equal(hero.items.size, 0);
});

test("deleting staged loot waits for an in-flight GM egress", { timeout: 2000 }, async () => {
  const { staging, hero } = world();
  const source = staging.add({ ...sourceData, flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } } });
  const gate = pauseCreate(hero);
  const transfer = _dispatchForTesting(transferEnvelope(source, hero), "gm");
  await gate.entered;
  const deletion = deleteHiddenItem(source.id);
  await new Promise(setImmediate);
  gate.resume();
  assert.equal((await transfer).status, "success");
  assert.equal((await deletion).error, "item-not-found");
  assert.equal(staging.items.size, 0);
  assert.equal(hero.items.size, 1);
});

test("queued direct transfers recheck destination ownership under the Item lock", { timeout: 2000 }, async () => {
  const { backing, hero } = world();
  const source = backing.add(sourceData);
  const gate = deferred();
  const held = withItemMutationLock(() => gate.promise);
  const { performEgress } = await import("../scripts/claim-commit.js");
  const transfer = performEgress({ sourceItem: source, destActor: hero, requestId: "queued", userId: "player" });
  hero.owned = false;
  gate.resolve();
  await held;
  assert.equal((await transfer).error, "destination-actor-not-owned");
  assert.equal(backing.items.size, 1);
  assert.equal(hero.items.size, 0);
});

test("the GM-only low-level transfer API still supports development Actors", async () => {
  world();
  const sourceActor = new Actor("development-source");
  const destination = new Actor("development-destination");
  const source = sourceActor.add(sourceData);
  const { performEgress } = await import("../scripts/claim-commit.js");
  const result = await performEgress({ sourceItem: source, destActor: destination, requestId: "development" });
  assert.equal(result.success, true);
  assert.equal(sourceActor.items.size, 0);
  assert.equal(destination.items.size, 1);
});

for (const systemId of ["dnd5e", "pf2e", "custom-system-builder"]) {
  for (const mode of ["cancel", "partial", "throw-after"]) {
    test(`${systemId} staged currency handles a ${mode} write without losing or doubling funds`, async () => {
      const { backing, staging } = world(systemId);
      await ensureCurrencyConfig(backing);
      const currencyId = systemId === "custom-system-builder"
        ? backing.getFlag(MODULE_ID, FLAGS.CURRENCY_CONFIG).custom[0].id : "gp";
      const before = getCurrency(currencyId, backing).value;
      await staging.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, [{ id: "five", currencyId, type: currencyId, amount: 5, createdAt: 1 }]);
      backing.currencyMode = mode;
      const outcome = await revealHiddenCurrency("five", { notify: false });
      if (mode === "throw-after") {
        assert.equal(outcome.status, "success");
        assert.equal(getCurrency(currencyId, backing).value, before + 5);
        assert.equal(staging.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY).length, 0);
      } else {
        assert.equal(outcome.status, "failed");
        assert.equal(staging.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY).length, 1);
        backing.currencyMode = null;
        coordinator._resetCacheForTesting();
        if (mode === "cancel") {
          assert.equal(outcome.error, "currency-update-not-applied");
          assert.equal(getCurrency(currencyId, backing).value, before);
          assert.equal((await revealHiddenCurrency("five", { notify: false })).status, "success");
          assert.equal(getCurrency(currencyId, backing).value, before + 5);
        } else {
          assert.equal(outcome.error, "currency-reconciliation-required");
          assert.equal(readRecoveryRecords().length, 1);
          assert.equal((await revealHiddenCurrency("five", { notify: false })).status, "failed");
          assert.equal(getCurrency(currencyId, backing).value, before + 2);
        }
      }
    });
  }
}

for (const mode of ["cancel", "throw-before", "throw-after"]) {
  test(`destination creation ${mode} preserves exactly one copy`, async () => {
    const { backing, hero } = world();
    const source = backing.add(sourceData);
    hero.createMode = mode;
    const result = await _dispatchForTesting(transferEnvelope(source, hero), "player");
    assert.equal(backing.items.size + hero.items.size, 1);
    assert.equal(result.status, mode === "throw-after" ? "success" : "failed");
    if (mode === "throw-after") assert.equal(result.resultData.createWarning, "create-after-write");
  });
}

test("a recovered destination create is compensated when the source delete is cancelled", async () => {
  const { backing, hero } = world();
  const source = backing.add(sourceData);
  backing.deleteMode = "cancel";
  hero.createMode = "throw-after";
  const result = await _dispatchForTesting(transferEnvelope(source, hero), "player");
  assert.equal(result.status, "failed");
  assert.equal(result.details.compensated, true);
  assert.equal(backing.items.size, 1);
  assert.equal(hero.items.size, 0);
});

test("a recovered create retains recovery material if compensation also fails", async () => {
  const { backing, hero } = world();
  const source = backing.add(sourceData);
  backing.deleteMode = hero.deleteMode = "cancel";
  hero.createMode = "throw-after";
  const result = await _dispatchForTesting(transferEnvelope(source, hero), "player");
  assert.equal(result.status, "failed");
  assert.equal(result.details.recoveryRecorded, true);
  assert.equal(readRecoveryRecords()[0].rawData.name, source.name);
  assert.equal(backing.items.size + hero.items.size, 2);
});

test("hide, reveal, and staging recover creates which commit before throwing", async () => {
  const { backing, staging } = world();
  const source = backing.add(sourceData);
  backing.createMode = staging.createMode = "throw-after";
  assert.ok(await setItemHidden(source.id, true));
  assert.equal(backing.items.size, 0);
  assert.equal(staging.items.size, 1);
  assert.ok(await setItemHidden(source.id, false));
  assert.equal(backing.items.size, 1);
  assert.equal(staging.items.size, 0);
  const staged = await stageHiddenItem({ ...sourceData, _id: "new-loot" });
  assert.equal(staged.status, "success");
  assert.equal(staging.items.size, 1);
});

for (const resource of [false, true]) {
  for (const rejectRecovery of [false, true]) {
    test(`${resource ? "resource" : "currency"} commit-log failure preserves success and durable replay${rejectRecovery ? " even if recovery logging fails" : ""}`, async () => {
      const { backing, staging } = world();
      await backing.setFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES, [{ id: "rations", name: "Rations", value: 10 }]);
      staging.rejectCommitType = resource ? "resource.commit" : "currency.commit";
      staging.rejectRecovery = rejectRecovery;
      const request = {
        requestId: "balance", timestamp: Date.now(),
        type: resource ? PAYLOAD_TYPES.CUSTOM_RESOURCE_CHANGE : PAYLOAD_TYPES.CURRENCY_CHANGE,
        payload: resource ? { resourceId: "rations", delta: 5 } : { currencyType: "gp", delta: 5 }
      };
      const outcome = await _dispatchForTesting(request, "gm");
      assert.equal(outcome.status, "success");
      assert.equal(outcome.resultData.newValue, 15);
      assert.equal(outcome.resultData.finalizationWarning, "commit-log-write-failure");
      assert.equal(outcome.resultData.finalizationRecoveryRecorded, !rejectRecovery);
      coordinator._resetCacheForTesting();
      const replay = await _dispatchForTesting(request, "gm");
      assert.equal(replay.status, "success");
      assert.equal(replay.resultData.newValue, 15);
      const observed = resource ? backing.getFlag(MODULE_ID, FLAGS.CUSTOM_RESOURCES)[0].value : backing.system.currency.gp;
      assert.equal(observed, 15);
    });
  }
}
