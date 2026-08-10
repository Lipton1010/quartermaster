import test from "node:test";
import assert from "node:assert/strict";

import { FLAGS, MODULE_ID, STORAGE_SCHEMA_VERSION } from "../scripts/constants.js";
import { migrateStorageSchema } from "../scripts/storage-migration.js";

class ItemCollection extends Array {
  get(id) { return this.find(item => item.id === id) ?? null; }
  static get [Symbol.species]() { return Array; }
}

class FakeItem {
  constructor(data, parent) {
    this.id = data._id ?? data.id;
    this.name = data.name;
    this.type = data.type;
    this.system = structuredClone(data.system ?? {});
    this.flags = structuredClone(data.flags ?? {});
    this.parent = parent;
    this.uuid = `${parent.uuid}.Item.${this.id}`;
  }
  getFlag(module, flag) { return this.flags[module]?.[flag]; }
  async unsetFlag(module, flag) {
    if (this.flags[module]) delete this.flags[module][flag];
    return this;
  }
  toObject() {
    return {
      _id: this.id,
      name: this.name,
      type: this.type,
      system: structuredClone(this.system),
      flags: structuredClone(this.flags)
    };
  }
}

class FakeActor {
  constructor(id, { flags = {}, items = [], failDeleteOnce = false } = {}) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.flags = structuredClone(flags);
    this.items = new ItemCollection();
    this.failDeleteOnce = failDeleteOnce;
    for (const data of items) this.items.push(new FakeItem(data, this));
  }
  getFlag(module, flag) { return this.flags[module]?.[flag]; }
  async setFlag(module, flag, value) {
    this.flags[module] ??= {};
    this.flags[module][flag] = structuredClone(value);
    return value;
  }
  async createEmbeddedDocuments(_type, data) {
    const created = data.map(entry => new FakeItem(entry, this));
    this.items.push(...created);
    return created;
  }
  async deleteEmbeddedDocuments(_type, ids) {
    if (this.failDeleteOnce) {
      this.failDeleteOnce = false;
      throw new Error("simulated-delete-failure");
    }
    for (const id of ids) {
      const index = this.items.findIndex(item => item.id === id);
      if (index >= 0) this.items.splice(index, 1);
    }
  }
}

function legacyActors({ failDeleteOnce = false } = {}) {
  const source = new FakeActor("shared", {
    failDeleteOnce,
    flags: { [MODULE_ID]: {
      [FLAGS.HIDDEN_CURRENCY]: [{ id: "coins", currencyId: "gp", amount: 25 }],
      [FLAGS.LOOT_PREP_FOLDERS]: [{ id: "room", name: "Secret Room" }],
      [FLAGS.TRANSACTION_LOG]: [
        { id: "public", timestamp: 1, type: "item.egress", itemName: "Rope" },
        { id: "secret", timestamp: 2, type: "hidden.staged", itemName: "Crown" }
      ]
    } },
    items: [{
      _id: "crown",
      name: "Crown",
      type: "loot",
      flags: { [MODULE_ID]: {
        [FLAGS.HIDDEN]: true,
        [FLAGS.LOOT_PREP_FOLDER]: "room",
        [FLAGS.LOOT_PREP_NOTE]: "King's ransom"
      } }
    }, {
      _id: "map",
      name: "Visible Map",
      type: "loot",
      flags: { [MODULE_ID]: {
        [FLAGS.LOOT_PREP_FOLDER]: "room",
        [FLAGS.LOOT_PREP_NOTE]: "The marked route is a secret"
      } }
    }]
  });
  return [source, new FakeActor("private")];
}

test.beforeEach(() => {
  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm", isGM: true } },
    settings: { get: () => "all" }
  };
});

test("only the elected GM migrates and a waiting GM can continue after election", async () => {
  const [shared, staging] = legacyActors();
  const waitingGm = { id: "gm-waiting", isGM: true };
  const otherGm = { id: "gm-active", isGM: true };
  game.user = waitingGm;
  game.users.activeGM = otherGm;
  const before = structuredClone({
    sharedFlags: shared.flags,
    sharedItems: shared.items.map(item => item.toObject()),
    stagingFlags: staging.flags,
    stagingItems: staging.items.map(item => item.toObject())
  });

  const blocked = await migrateStorageSchema(shared, staging);
  assert.deepEqual(blocked, { migrated: false, reason: "active-gm-only" });
  assert.deepEqual({
    sharedFlags: shared.flags,
    sharedItems: shared.items.map(item => item.toObject()),
    stagingFlags: staging.flags,
    stagingItems: staging.items.map(item => item.toObject())
  }, before);

  game.users.activeGM = waitingGm;
  const elected = await migrateStorageSchema(shared, staging);
  assert.equal(elected.migrated, true);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), STORAGE_SCHEMA_VERSION);
});

test("a benign Set-field duplicate introduced by document creation does not fail item verification", async () => {
  // Reproduces a live Foundry v14.365/dnd5e 5.3.3 defect: recreating an Item via
  // createEmbeddedDocuments can round-trip a Set-backed system field (e.g. a
  // "properties" tag set) with a duplicate entry. That is not data loss —
  // verifyMigratedItem must tolerate it instead of failing migration.
  class DuplicatingActor extends FakeActor {
    async createEmbeddedDocuments(type, data) {
      const mutated = data.map(entry => ({
        ...entry,
        system: {
          ...entry.system,
          properties: [...(entry.system?.properties ?? []), ...(entry.system?.properties ?? [])]
        }
      }));
      return super.createEmbeddedDocuments(type, mutated);
    }
  }

  const shared = new FakeActor("shared", {
    flags: { [MODULE_ID]: {
      [FLAGS.HIDDEN_CURRENCY]: [],
      [FLAGS.LOOT_PREP_FOLDERS]: [],
      [FLAGS.TRANSACTION_LOG]: []
    } },
    items: [{
      _id: "ring",
      name: "Ring",
      type: "loot",
      system: { properties: ["gear"] },
      flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } }
    }]
  });
  const staging = new DuplicatingActor("private");

  const result = await migrateStorageSchema(shared, staging);
  assert.equal(result.migrated, true);
  assert.equal(shared.items.length, 0);
  assert.equal(staging.items.length, 1);
  assert.deepEqual(staging.items[0].system.properties, ["gear", "gear"]);
});

test("a genuinely different system field still fails item verification", async () => {
  class CorruptingActor extends FakeActor {
    async createEmbeddedDocuments(type, data) {
      const mutated = data.map(entry => ({
        ...entry,
        system: { ...entry.system, properties: ["magic"] }
      }));
      return super.createEmbeddedDocuments(type, mutated);
    }
  }

  const shared = new FakeActor("shared", {
    flags: { [MODULE_ID]: {
      [FLAGS.HIDDEN_CURRENCY]: [],
      [FLAGS.LOOT_PREP_FOLDERS]: [],
      [FLAGS.TRANSACTION_LOG]: []
    } },
    items: [{
      _id: "ring",
      name: "Ring",
      type: "loot",
      system: { properties: ["gear"] },
      flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } }
    }]
  });
  const staging = new CorruptingActor("private");
  const previousError = console.error;
  console.error = () => {};

  await assert.rejects(
    () => migrateStorageSchema(shared, staging),
    /hidden-item-verification-failed-ring/
  );
  console.error = previousError;
});

test("schema migration moves private state, verifies it, and is idempotent", async () => {
  const [shared, staging] = legacyActors();
  const result = await migrateStorageSchema(shared, staging);
  assert.equal(result.migrated, true);
  assert.equal(shared.items.length, 1);
  assert.equal(staging.items.length, 1);
  assert.equal(staging.items[0].getFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE), "King's ransom");
  assert.equal(shared.items[0].getFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE), undefined);
  assert.equal(shared.items[0].getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDER), undefined);
  assert.deepEqual(staging.getFlag(MODULE_ID, FLAGS.MIGRATED_ITEM_METADATA), [{
    id: "Actor.shared.Item.map",
    sourceItemUuid: "Actor.shared.Item.map",
    itemId: "map",
    itemName: "Visible Map",
    note: "The marked route is a secret",
    folderId: "room"
  }]);
  assert.deepEqual(shared.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY), []);
  assert.deepEqual(staging.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY), [
    { id: "coins", currencyId: "gp", amount: 25 }
  ]);
  assert.deepEqual(shared.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG).map(entry => entry.id), ["public"]);
  assert.deepEqual(staging.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG).map(entry => entry.id), ["public", "secret"]);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), STORAGE_SCHEMA_VERSION);
  assert.equal(staging.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), STORAGE_SCHEMA_VERSION);

  const repeated = await migrateStorageSchema(shared, staging);
  assert.equal(repeated.migrated, false);
  assert.equal(staging.items.length, 1);
});

test("a migrated fractional amount for a whole-units-only native currency is surfaced to the GM", async () => {
  game.system = { id: "pf2e" };
  const [shared, staging] = legacyActors();
  shared.inventory = { coins: {} };
  await shared.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, [
    { id: "coins", currencyId: "gp", amount: 25 },
    { id: "half-a-coin", currencyId: "gp", amount: 2.5 }
  ]);

  const result = await migrateStorageSchema(shared, staging);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.fractionalCurrencyWarnings, [
    { id: "half-a-coin", currencyId: "gp", amount: 2.5 }
  ]);
  assert.deepEqual(
    shared.getFlag(MODULE_ID, FLAGS.MIGRATION_STATE).fractionalCurrencyWarnings,
    [{ id: "half-a-coin", currencyId: "gp", amount: 2.5 }]
  );
  assert.deepEqual(staging.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY), [
    { id: "coins", currencyId: "gp", amount: 25 },
    { id: "half-a-coin", currencyId: "gp", amount: 2.5 }
  ]);
});

test("failed migration leaves the schema marker unset and resumes without duplicates", async () => {
  const [shared, staging] = legacyActors({ failDeleteOnce: true });
  await assert.rejects(() => migrateStorageSchema(shared, staging), /simulated-delete-failure/);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
  assert.equal(shared.items.length, 2);
  assert.equal(staging.items.length, 1);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.MIGRATION_STATE).status, "failed");

  const resumed = await migrateStorageSchema(shared, staging);
  assert.equal(resumed.migrated, true);
  assert.equal(shared.items.length, 1);
  assert.equal(staging.items.length, 1);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), STORAGE_SCHEMA_VERSION);
});

test("migration fails closed when a staging record reuses an id with different data", async () => {
  const [shared, staging] = legacyActors();
  await staging.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, [
    { id: "coins", currencyId: "gp", amount: 999 }
  ]);

  await assert.rejects(
    () => migrateStorageSchema(shared, staging),
    /migration-record-conflict-coins/
  );
  assert.deepEqual(shared.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY), [
    { id: "coins", currencyId: "gp", amount: 25 }
  ]);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
});

test("a missing staging marker is repaired only after current shared storage is reverified", async () => {
  const [shared, staging] = legacyActors();
  await migrateStorageSchema(shared, staging);
  delete staging.flags[MODULE_ID][FLAGS.STORAGE_SCHEMA_VERSION];

  const repeated = await migrateStorageSchema(shared, staging);

  assert.equal(repeated.migrated, false);
  assert.equal(repeated.repairedStagingMarker, true);
  assert.equal(staging.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), STORAGE_SCHEMA_VERSION);
  assert.equal(shared.items.length, 1);
  assert.equal(staging.items.length, 1);
  assert.deepEqual(shared.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG).map(entry => entry.id), ["public"]);
});

test("a missing staging marker is not repaired while private data remains shared", async () => {
  const [shared, staging] = legacyActors();
  await shared.setFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION);

  await assert.rejects(
    () => migrateStorageSchema(shared, staging),
    /hidden-items-remain-on-shared-vault/
  );

  assert.equal(staging.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
  assert.equal(shared.items.length, 2);
});

test("malformed private staging data is preserved instead of defaulted away", async () => {
  const [shared, staging] = legacyActors();
  shared.items.splice(0);
  await shared.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, []);
  await shared.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS, []);
  await shared.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, []);
  await shared.setFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION, STORAGE_SCHEMA_VERSION);
  const recoverable = { id: "coins", currencyId: "gp", amount: 25 };
  await staging.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, recoverable);

  await assert.rejects(
    () => migrateStorageSchema(shared, staging),
    /invalid-staging-private-data-hiddenCurrency/
  );

  assert.deepEqual(staging.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY), recoverable);
  assert.equal(staging.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
});

test("resumed canonical log state still rejects a changed same-ID private record", async () => {
  const [shared, staging] = legacyActors();
  shared.items.splice(0);
  await shared.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, []);
  await shared.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS, []);
  await shared.setFlag(MODULE_ID, FLAGS.MIGRATION_STATE, {
    status: "failed",
    phase: "transaction-log",
    canonicalLogCopied: true
  });
  const originalSharedLog = structuredClone(shared.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG));
  await staging.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, [
    { id: "public", timestamp: 1, type: "item.egress", itemName: "Altered" },
    { id: "secret", timestamp: 2, type: "hidden.staged", itemName: "Crown" }
  ]);

  await assert.rejects(
    () => migrateStorageSchema(shared, staging),
    /transaction-log-record-conflict-public/
  );

  assert.deepEqual(shared.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG), originalSharedLog);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
  assert.equal(staging.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
});

test("conflicting duplicate IDs already in private staging block schema advancement", async () => {
  const shared = new FakeActor("shared", { flags: { [MODULE_ID]: {
    [FLAGS.HIDDEN_CURRENCY]: [],
    [FLAGS.LOOT_PREP_FOLDERS]: [],
    [FLAGS.TRANSACTION_LOG]: []
  } } });
  const staging = new FakeActor("private", { flags: { [MODULE_ID]: {
    [FLAGS.HIDDEN_CURRENCY]: [
      { id: "coins", currencyId: "gp", amount: 25 },
      { id: "coins", currencyId: "gp", amount: 999 }
    ]
  } } });

  await assert.rejects(
    () => migrateStorageSchema(shared, staging),
    /migration-record-conflict-coins/
  );

  assert.equal(staging.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY).length, 2);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
  assert.equal(staging.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
});

test("schema markers remain unset when the final public projection cannot be verified", async () => {
  const [shared, staging] = legacyActors();
  const setFlag = shared.setFlag.bind(shared);
  shared.setFlag = async (module, flag, value) => {
    if (module === MODULE_ID && flag === FLAGS.TRANSACTION_LOG
        && Array.isArray(value) && value.length === 1) {
      return value; // Simulate an acknowledged write that did not persist.
    }
    return setFlag(module, flag, value);
  };

  await assert.rejects(
    () => migrateStorageSchema(shared, staging),
    /transaction-log-projection-verification-failed/
  );

  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
  assert.equal(staging.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.MIGRATION_STATE).status, "failed");
});
