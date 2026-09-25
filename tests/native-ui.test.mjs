import test from "node:test";
import assert from "node:assert/strict";
import { FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";
import { stableStringify } from "../scripts/stable-json.js";

const hooks = new Map();
const menus = [];
const choices = [];
const dialogs = [];
let writes = [];
let beforeWrite = async () => {};
let serial = 0;
const escapeHTML = value => String(value).replace(/[&<>"']/g,
  char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[char]);

class DialogV2 {
  static async wait(config) {
    dialogs.push(config);
    const { action, fields = {} } = choices.shift();
    const dialog = { element: { querySelector: selector => fields[selector] ?? null } };
    config.render?.({}, dialog);
    if (action === "close") return null;
    const button = config.buttons.find(entry => entry.action === action);
    assert.ok(button, `Missing dialog action: ${action}`);
    // Foundry falls back to the action for nullish callback results.
    return (await button.callback?.({}, {}, dialog)) ?? action;
  }
}
class ApplicationV2 {}
globalThis.foundry = {
  applications: {
    api: { DialogV2, ApplicationV2, HandlebarsApplicationMixin: Base => Base },
    ux: { ContextMenu: class {
      constructor(root, selector, entries, options) { menus.push({ root, selector, entries, options }); }
    } }
  },
  utils: { deepClone: structuredClone, escapeHTML, randomID: () => String(++serial) }
};
globalThis.Hooks = {
  on(name, callback) { hooks.set(name, callback); },
  callAll(name, value) { hooks.get(name)?.(value); }
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.CONFIG = { Item: { typeLabels: {}, typeIcons: {} } };

function actor(id, marker) {
  const flags = { [marker]: true };
  return {
    id, uuid: `Actor.${id}`, name: id, type: "character", documentName: "Actor",
    items: { contents: [], get() {}, filter() { return []; } },
    getFlag(_scope, key) { return flags[key]; },
    async setFlag(_scope, key, value) {
      await beforeWrite();
      writes.push(key);
      flags[key] = structuredClone(value);
    }
  };
}
function world() {
  writes = [];
  beforeWrite = async () => {};
  const shared = actor("shared", FLAGS.BACKING_ACTOR_MARKER);
  const staging = actor("staging", FLAGS.STAGING_ACTOR_MARKER);
  const gm = { id: "gm", isGM: true, active: true };
  const actors = new Map([[shared.id, shared], [staging.id, staging]]);
  actors.find = predicate => [...actors.values()].find(predicate);
  const settings = new Map([[SETTINGS.BACKING_ACTOR_ID, shared.id], [SETTINGS.STAGING_ACTOR_ID, staging.id]]);
  globalThis.game = {
    user: gm, users: { activeGM: gm }, actors, packs: new Map(), system: { id: "native-ui-fixture" },
    documentTypes: { Item: ["loot"] }, i18n: { localize: value => value },
    settings: {
      get: (_scope, key) => settings.get(key),
      async set(_scope, key, value) {
        await beforeWrite();
        writes.push(key);
        settings.set(key, value);
      }
    }
  };
  return { shared, staging, settings };
}
const choose = (action, fields = {}) => choices.push({ action, fields });
const app = { render() {} };
const target = { dataset: { folderId: "folder" } };
const { LootPrepApp } = await import("../scripts/apps/loot-prep-app.js");
const { promptResourceEdit } = await import("../scripts/apps/resource-edit-dialog.js");
const { promptInventoryPreferences } = await import("../scripts/apps/preferences-dialog.js");
const { openCurrencyEditor } = await import("../scripts/apps/currency-manager-app.js");
const { attachInventoryContextMenu } = await import("../scripts/context-menu.js");
const { registerCompendiumContextMenu } = await import("../scripts/compendium-menu.js");

test("shared serializer preserves persistence equality without hiding changed values", () => {
  const left = { z: [undefined, { b: 2, a: 1 }], ignored: undefined };
  const right = { z: [null, { a: 1, b: 2 }] };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.notEqual(stableStringify(left), stableStringify({ z: [null, { a: 2, b: 2 }] }));
});

test("native resource dialog returns saved data and null for Cancel or window close", async () => {
  world();
  choose("save", {
    "#qm-res-name": { value: "  Charges  " }, "#qm-res-value": { value: "3" },
    "#qm-res-max": { value: "7" }, "#qm-res-desc": { value: "daily" }
  });
  assert.deepEqual(await promptResourceEdit(), {
    name: "Charges", icon: "icons/svg/coins.svg", value: 3, max: 7, description: "daily"
  });
  for (const action of ["cancel", "close"]) {
    choose(action);
    assert.equal(await promptResourceEdit(), null);
  }
});

test("preferences await persistence and cancelling performs no writes", async () => {
  world();
  let release;
  beforeWrite = () => new Promise(resolve => { release = resolve; });
  choose("save", { "[name='sortOrder']:checked": { value: "alphabetical" } });
  let completed = false;
  const pending = promptInventoryPreferences().then(value => { completed = true; return value; });
  await new Promise(setImmediate);
  assert.equal(completed, false);
  beforeWrite = async () => {};
  release();
  assert.equal(await pending, true);
  const count = writes.length;
  for (const action of ["cancel", "close"]) {
    choose(action);
    assert.equal(await promptInventoryPreferences(), false);
    assert.equal(writes.length, count);
  }
});

test("folder Save trims the name; invalid, cancelled and dismissed names do not create folders", async () => {
  const { staging } = world();
  choose("save", { "[name='folderName']": { value: "  Hoard  " } });
  await LootPrepApp.onCreateFolder.call(app, {}, target);
  assert.equal(staging.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS)[0].name, "Hoard");
  const count = writes.length;
  for (const action of ["save", "cancel", "close"]) {
    choose(action, { "[name='folderName']": { value: "  " } });
    await LootPrepApp.onCreateFolder.call(app, {}, target);
    assert.equal(writes.length, count);
  }
});

test("saving an empty note clears it, while Cancel and window close preserve it", async () => {
  const { staging } = world();
  for (const action of ["cancel", "close", "save"]) {
    await staging.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS, [{ id: "folder", name: "Hoard", note: "secret" }]);
    choose(action, { "[name='lootPrepNote']": { value: "" } });
    await LootPrepApp.onEditFolderNote.call(app, {}, target);
    assert.equal(staging.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS)[0].note,
      action === "save" ? undefined : "secret");
  }
});

test("cancelled loot and currency editors do not mutate storage", async () => {
  world();
  for (const action of ["cancel", "close"]) {
    choose(action);
    await LootPrepApp.onAddCurrencyLoot.call(app, {}, target);
    choose(action);
    await LootPrepApp.onCreateItem.call(app, {}, target);
    choose(action);
    assert.equal(await openCurrencyEditor("qm-cur-default"), false);
  }
  assert.deepEqual(writes, []);
});

test("inventory binds one native menu per root and reevaluates GM conditions", () => {
  world();
  const root = {};
  attachInventoryContextMenu({ element: root });
  attachInventoryContextMenu({ element: root });
  assert.equal(menus.length, 1);
  assert.equal(menus[0].options.jQuery, false);
  assert.equal(menus[0].options.fixed, true);
  assert.equal(menus[0].entries[0].name, "Add to Actor...");
  assert.ok(menus[0].entries.slice(1).every(entry => entry.condition()));
  game.user = { id: "player", isGM: false };
  assert.ok(menus[0].entries.slice(1).every(entry => !entry.condition()));
});

test("compendium entries retain native actions, target the selected Item and exclude world directories", async () => {
  world();
  registerCompendiumContextMenu();
  const hook = hooks.get("getItemContextOptions");
  let requested;
  const pack = { collection: "test.items", documentName: "Item",
    async getDocument(id) { requested = id; return null; } };
  game.packs.set(pack.collection, pack);
  const native = { name: "Import Entry" };
  const entries = [native];
  hook({ collection: pack }, entries);
  assert.equal(entries[0], native);
  assert.equal(entries.length, 3);
  await entries[1].callback({ dataset: { entryId: "selected-item" } });
  assert.equal(requested, "selected-item");
  game.user = { id: "player", isGM: false };
  assert.ok(entries.slice(1).every(entry => !entry.condition()));
  const worldEntries = [native];
  hook({ collection: { documentName: "Item" } }, worldEntries);
  assert.deepEqual(worldEntries, [native]);
});
