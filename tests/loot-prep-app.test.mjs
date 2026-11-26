import test from "node:test";
import assert from "node:assert/strict";

import { FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";

class ItemCollection extends Map {
  [Symbol.iterator]() { return this.values(); }
  find(predicate) { return [...this.values()].find(predicate) ?? null; }
  filter(predicate) { return [...this.values()].filter(predicate); }
}

function makeActor(id, marker) {
  const flags = { [MODULE_ID]: { [marker]: true } };
  return {
    id,
    name: id === "shared" ? "Quartermaster Vault" : "Quartermaster Staging",
    items: new ItemCollection(),
    getFlag(scope, key) { return flags[scope]?.[key]; }
  };
}

test("Loot Prep prepares staged Item context through the real application path", async (t) => {
  const previousFoundry = globalThis.foundry;
  const previousGame = globalThis.game;
  t.after(() => {
    globalThis.foundry = previousFoundry;
    globalThis.game = previousGame;
  });

  class ApplicationV2 {}
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2,
        DialogV2: class {},
        HandlebarsApplicationMixin: Base => class extends Base {}
      },
      apps: { FilePicker: { implementation: class {} } }
    },
    utils: { deepClone: structuredClone }
  };

  const backing = makeActor("shared", FLAGS.BACKING_ACTOR_MARKER);
  const staging = makeActor("private", FLAGS.STAGING_ACTOR_MARKER);
  const stagedItem = {
    id: "staged-item",
    uuid: "Actor.private.Item.staged-item",
    name: "Secret Map",
    img: "icons/svg/item-bag.svg",
    type: "loot",
    parent: staging,
    flags: { [MODULE_ID]: { [FLAGS.HIDDEN]: true } },
    getFlag(scope, key) { return this.flags[scope]?.[key]; }
  };
  staging.items.set(stagedItem.id, stagedItem);

  const actors = new Map([[backing.id, backing], [staging.id, staging]]);
  actors.find = predicate => [...actors.values()].find(predicate) ?? null;
  globalThis.game = {
    system: { id: "unsupported-test-system" },
    user: { id: "gm", isGM: true },
    actors,
    modules: new Map([[MODULE_ID, { version: "1.0.0" }]]),
    settings: {
      get(_scope, key) {
        if (key === SETTINGS.BACKING_ACTOR_ID) return backing.id;
        if (key === SETTINGS.STAGING_ACTOR_ID) return staging.id;
        if (key === SETTINGS.UNIDENTIFIED_DISPLAY) return "name";
        return null;
      }
    }
  };

  const { getStagingActor } = await import("../scripts/backing-actor.js");
  const { getHiddenItems } = await import("../scripts/hidden-items.js");
  assert.equal(getStagingActor(), staging);
  assert.equal(getHiddenItems(staging).length, 1);

  const { LootPrepApp } = await import("../scripts/apps/loot-prep-app.js");
  const context = await LootPrepApp.prototype._prepareContext.call({});

  assert.equal(context.hiddenItemCount, 1);
  assert.equal(context.allHiddenCount, 1);
  assert.equal(context.uncatItems[0].id, stagedItem.id);
  assert.equal(context.uncatItems[0].name, stagedItem.name);
  assert.equal(context.uncatItems[0].folderId, null);
});
