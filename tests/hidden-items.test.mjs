import test from "node:test";
import assert from "node:assert/strict";

import { FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";
import { deleteHiddenItem, setItemHidden } from "../scripts/hidden-items.js";

class ItemCollection extends Map {
  find(predicate) { return [...this.values()].find(predicate) ?? null; }
  filter(predicate) { return [...this.values()].filter(predicate); }
}

class FakeItem {
  constructor(data, parent) {
    this.id = data._id ?? data.id;
    this.name = data.name;
    this.type = data.type ?? "loot";
    this.parent = parent;
    this.uuid = `${parent.uuid}.Item.${this.id}`;
    this.flags = structuredClone(data.flags ?? {});
  }

  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  async setFlag(scope, key, value) {
    this.flags[scope] ??= {};
    this.flags[scope][key] = value;
    return this;
  }
  async unsetFlag(scope, key) {
    if (this.flags[scope]) delete this.flags[scope][key];
    return this;
  }
  toObject() {
    return {
      _id: this.id,
      name: this.name,
      type: this.type,
      flags: structuredClone(this.flags)
    };
  }
}

class FakeActor {
  constructor(id, marker, { deleteMode = "normal" } = {}) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.documentName = "Actor";
    this.items = new ItemCollection();
    this.marker = marker;
    this.flags = { [MODULE_ID]: { [marker]: true } };
    this.deleteMode = deleteMode;
  }

  addItem(data) {
    const item = new FakeItem(data, this);
    this.items.set(item.id, item);
    return item;
  }
  getFlag(scope, key) { return this.flags[scope]?.[key]; }
  async setFlag(scope, key, value) {
    this.flags[scope] ??= {};
    this.flags[scope][key] = structuredClone(value);
    return this;
  }
  async createEmbeddedDocuments(_type, entries) {
    return entries.map(entry => this.addItem(entry));
  }
  async deleteEmbeddedDocuments(_type, ids) {
    if (this.deleteMode === "throw-before") throw new Error("delete-before-removal");
    for (const id of ids) this.items.delete(id);
    if (this.deleteMode === "throw-after") throw new Error("delete-after-removal");
  }
}

function installWorld({ deleteMode = "normal", stagingDeleteMode = "normal" } = {}) {
  const backing = new FakeActor("shared", FLAGS.BACKING_ACTOR_MARKER, { deleteMode });
  const staging = new FakeActor("private", FLAGS.STAGING_ACTOR_MARKER, {
    deleteMode: stagingDeleteMode
  });
  backing.addItem({ _id: "secret", name: "Secret", flags: {} });
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
        return null;
      }
    }
  };
  return { backing, staging };
}

test("hidden Item move compensates destination when source deletion fails", async (t) => {
  const previousGame = globalThis.game;
  t.after(() => { globalThis.game = previousGame; });
  const { backing, staging } = installWorld({ deleteMode: "throw-before" });
  const previousError = console.error;
  console.error = () => {};
  t.after(() => { console.error = previousError; });

  assert.equal(await setItemHidden("secret", true), null);
  assert.ok(backing.items.get("secret"), "source is preserved");
  assert.equal(staging.items.get("secret"), undefined, "destination copy is removed");
});

test("post-removal hook errors preserve the only surviving destination copy", async (t) => {
  const previousGame = globalThis.game;
  t.after(() => { globalThis.game = previousGame; });
  const { backing, staging } = installWorld({ deleteMode: "throw-after" });
  const previousWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = previousWarn; });

  const moved = await setItemHidden("secret", true);
  assert.equal(moved, staging.items.get("secret"));
  assert.equal(backing.items.get("secret"), undefined);
  assert.equal(moved.getFlag(MODULE_ID, FLAGS.HIDDEN), true);
});

test("hidden Item deletion fails when the source remains", async (t) => {
  const previousGame = globalThis.game;
  t.after(() => { globalThis.game = previousGame; });
  const { staging } = installWorld({ stagingDeleteMode: "throw-before" });
  staging.addItem({
    _id: "staged-secret",
    name: "Staged Secret",
    flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } }
  });
  const previousError = console.error;
  console.error = () => {};
  t.after(() => { console.error = previousError; });

  const result = await deleteHiddenItem("staged-secret");
  assert.equal(result.status, "failed");
  assert.ok(staging.items.get("staged-secret"), "source is preserved");
});

test("hidden Item deletion reports success when a hook throws after removal", async (t) => {
  const previousGame = globalThis.game;
  const previousFoundry = globalThis.foundry;
  const previousHooks = globalThis.Hooks;
  t.after(() => {
    globalThis.game = previousGame;
    globalThis.foundry = previousFoundry;
    globalThis.Hooks = previousHooks;
  });
  const { staging } = installWorld({ stagingDeleteMode: "throw-after" });
  staging.addItem({
    _id: "staged-secret",
    name: "Staged Secret",
    flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } }
  });
  globalThis.foundry = {
    utils: {
      deepClone: structuredClone,
      randomID: () => "log-id"
    }
  };
  globalThis.Hooks = { callAll() {} };
  const previousWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = previousWarn; });

  const result = await deleteHiddenItem("staged-secret");
  assert.equal(result.status, "success");
  assert.equal(result.warning, "delete-hook-error-after-removal");
  assert.equal(staging.items.get("staged-secret"), undefined);
  const log = staging.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG);
  assert.equal(log.at(-1).type, "hidden.deleted");
  assert.equal(log.at(-1).itemId, "staged-secret");
});
