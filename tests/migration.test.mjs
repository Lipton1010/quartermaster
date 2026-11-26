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
    this.effects = structuredClone(data.effects ?? []);
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
      effects: structuredClone(this.effects),
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
  globalThis.foundry = { utils: { deepClone: structuredClone }, data: { fields: { SetField: class {} } } };
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
  Object.defineProperty(shared.items[0].system, "getFieldForProperty", {
    value: path => path === "properties" ? new foundry.data.fields.SetField() : null
  });

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

test("visible metadata migration resumes after scrubbing only the note", async () => {
  const [shared, staging] = legacyActors();
  const map = shared.items.get("map");
  const unset = map.unsetFlag.bind(map);
  map.unsetFlag = async (scope, flag) => {
    if (flag === FLAGS.LOOT_PREP_FOLDER) throw new Error("interrupted");
    return unset(scope, flag);
  };
  await assert.rejects(migrateStorageSchema(shared, staging), /interrupted/);
  assert.equal(map.getFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE), undefined);
  map.unsetFlag = unset;
  // An actual edit between runs must still be preserved and reported.
  map.flags[MODULE_ID][FLAGS.LOOT_PREP_FOLDER] = "other";
  await assert.rejects(migrateStorageSchema(shared, staging), /migration-record-conflict/);
  map.flags[MODULE_ID][FLAGS.LOOT_PREP_FOLDER] = "room";
  assert.equal((await migrateStorageSchema(shared, staging)).migrated, true);
  const [archive] = staging.getFlag(MODULE_ID, FLAGS.MIGRATED_ITEM_METADATA);
  assert.equal(archive.note, "The marked route is a secret");
  assert.equal(archive.folderId, "room");
  assert.equal(map.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDER), undefined);
});

test("D&D migration rejects split container links before moving any hidden items", async () => {
  game.system = { id: "dnd5e" };
  for (const parentHidden of [true, false]) {
    const [shared, staging] = legacyActors();
    await shared.createEmbeddedDocuments("Item", [
      { _id: "bag", type: "container", flags: { [MODULE_ID]: { hidden: parentHidden } } },
      { _id: "gem", type: "loot", system: { container: "bag" }, flags: { [MODULE_ID]: { hidden: !parentHidden } } }
    ]);
    await assert.rejects(migrateStorageSchema(shared, staging), /Unpack the item or mark the container/);
    assert.equal(shared.items.length, 4);
    assert.equal(staging.items.length, 0);
  }
});

test("D&D migrates a hidden container and child together, including partially completed moves", async () => {
  game.system = { id: "dnd5e" };
  for (const alreadyMoved of [null, "bag", "gem"]) {
    const [shared, staging] = legacyActors();
    const hidden = { [MODULE_ID]: { hidden: true } };
    await shared.createEmbeddedDocuments("Item", [
      { _id: "gem", type: "loot", system: { container: "bag" }, flags: hidden },
      { _id: "bag", type: "container", flags: hidden }
    ]);
    if (alreadyMoved) {
      const prior = shared.items.get(alreadyMoved);
      const data = prior.toObject();
      data.flags[MODULE_ID].migrationSourceUuid = prior.uuid;
      await staging.createEmbeddedDocuments("Item", [data]);
      await shared.deleteEmbeddedDocuments("Item", [prior.id]);
    }
    assert.equal((await migrateStorageSchema(shared, staging)).migrated, true);
    assert.equal(staging.items.get("gem").system.container, staging.items.get("bag").id);
    assert.equal(staging.items.length, 3);
  }
});

test("D&D migration never assigns a child to an unrelated actor-local container with the same ID", async () => {
  game.system = { id: "dnd5e" };
  const [shared, staging] = legacyActors();
  shared.items.get("crown").system.container = "bag";
  await staging.createEmbeddedDocuments("Item", [{ _id: "bag", type: "container" }]);
  await assert.rejects(migrateStorageSchema(shared, staging), /Cannot migrate container link/);
  assert.ok(shared.items.get("crown"));
  assert.equal(staging.items.length, 1);
});

for (const field of ["system", "flags"]) {
  test(`migration preserves ordered repeated values in ${field}`, async () => {
    const [shared, staging] = legacyActors();
    const crown = shared.items.get("crown");
    crown[field].sequence = ["a", "a", "b"];
    const create = staging.createEmbeddedDocuments.bind(staging);
    staging.createEmbeddedDocuments = (type, entries) => {
      const changed = structuredClone(entries);
      changed[0][field].sequence = ["b", "a"];
      return create(type, changed);
    };
    await assert.rejects(migrateStorageSchema(shared, staging), /hidden-item-verification-failed-crown/);
    assert.deepEqual(shared.items.get("crown")[field].sequence, ["a", "a", "b"]);
  });
}

test("migration rebases self-referencing effects, including copies interrupted on a prior version", async () => {
  const [shared, staging] = legacyActors();
  const crown = shared.items.get("crown");
  crown.effects = [
    { _id: "e1", origin: crown.uuid },
    { _id: "e2", origin: crown.uuid + ".ActiveEffect.e1" },
    { _id: "e3", origin: "Actor.other.Item.spell" }
  ];
  const oldCopy = crown.toObject();
  oldCopy.flags[MODULE_ID].migrationSourceUuid = crown.uuid;
  const [partial] = await staging.createEmbeddedDocuments("Item", [oldCopy]);
  partial.update = async ({ effects }) => { partial.effects = structuredClone(effects); };
  await migrateStorageSchema(shared, staging);
  assert.deepEqual(partial.effects.map(effect => effect.origin), [
    partial.uuid, partial.uuid + ".ActiveEffect.e1", "Actor.other.Item.spell"
  ]);
  assert.equal(staging.items.length, 1);
  assert.equal(shared.items.get("crown"), null);
});

test("embedded effect copies accept regenerated server stats and retain strict provenance and change verification", async () => {
  const historicStats = {
    coreVersion: "13.351", systemId: "prior-system", systemVersion: "5.0",
    createdTime: 10, modifiedTime: 20, lastModifiedBy: "prior-gm",
    compendiumSource: "Compendium.source.items.Item.a", duplicateSource: "Item.original",
    exportSource: { uuid: "Item.exported", coreVersion: "13.351" }
  };
  const latestStats = {
    coreVersion: "14.370", systemId: "dnd5e", systemVersion: "6.1.1",
    createdTime: 30, modifiedTime: 30, lastModifiedBy: "active-gm"
  };
  for (const difference of [null, "compendiumSource", "duplicateSource", "exportSource", "changes", "flags", "origin"]) {
    const [shared, staging] = legacyActors();
    const crown = shared.items.get("crown");
    crown.effects = [{ _id: "effect", origin: crown.uuid, _stats: historicStats,
      changes: [{ key: "system.one" }, { key: "system.two" }], flags: { sequence: ["first", "second"] } }];
    const create = staging.createEmbeddedDocuments.bind(staging);
    staging.createEmbeddedDocuments = (type, data) => {
      const copy = structuredClone(data);
      const effect = copy[0].effects[0];
      Object.assign(effect._stats, latestStats);
      if (difference === "changes") effect.changes.reverse();
      else if (difference === "flags") effect.flags.sequence.reverse();
      else if (difference === "origin") effect.origin = crown.uuid;
      else if (difference) effect._stats[difference] = null;
      return create(type, copy);
    };
    if (difference) {
      await assert.rejects(migrateStorageSchema(shared, staging), /hidden-item-verification-failed/);
      assert.ok(shared.items.get("crown"), difference);
    } else {
      await migrateStorageSchema(shared, staging);
      const migrated = staging.items.get("crown");
      assert.equal(migrated.effects[0].origin, migrated.uuid);
      assert.equal(shared.items.get("crown"), null);
    }
  }
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

test("a malformed legacy transaction log is preserved for GM recovery", async () => {
  const [shared, staging] = legacyActors();
  const legacy = { unexpectedFormat: ["preserve this record"] };
  await shared.setFlag(MODULE_ID, FLAGS.TRANSACTION_LOG, legacy);
  await assert.rejects(migrateStorageSchema(shared, staging), /invalid-migration-array/);
  assert.deepEqual(shared.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG), legacy);
  assert.equal(shared.getFlag(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION), undefined);
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
