import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createFolder, setItemFolder } from "../scripts/loot-prep-folders.js";
import { setFolderNote, setItemNote } from "../scripts/loot-prep-notes.js";
import {
  deleteHiddenItem,
  setItemHidden,
  stageHiddenItem
} from "../scripts/hidden-items.js";
import { performEgress, performIngress } from "../scripts/claim-commit.js";

test("a former active GM cannot use cached direct mutation facades", async t => {
  const previous = {
    game: globalThis.game,
    foundry: globalThis.foundry,
    Hooks: globalThis.Hooks
  };
  t.after(() => {
    globalThis.game = previous.game;
    globalThis.foundry = previous.foundry;
    globalThis.Hooks = previous.Hooks;
  });

  const formerActive = { id: "gm-former", isGM: true };
  const elected = { id: "gm-elected", isGM: true };
  let mutations = 0;
  globalThis.game = {
    user: formerActive,
    users: { activeGM: elected },
    actors: {
      get: () => null,
      find: () => null
    },
    settings: { get: () => null }
  };
  globalThis.foundry = {
    utils: {
      deepClone: value => structuredClone(value),
      randomID: () => "unused"
    }
  };
  globalThis.Hooks = { callAll() { mutations += 1; } };

  assert.equal(await createFolder("Blocked"), null);
  assert.equal(await setItemFolder("item", "folder"), false);
  assert.equal(await setFolderNote("folder", "blocked"), false);
  assert.equal(await setItemNote("item", "blocked"), false);
  assert.equal(await setItemHidden("item", true), null);
  assert.deepEqual(await stageHiddenItem({ name: "Blocked" }), {
    status: "failed",
    error: "active-gm-only"
  });
  assert.deepEqual(await deleteHiddenItem("item"), {
    status: "failed",
    error: "active-gm-only"
  });
  assert.deepEqual(await performEgress({ requestId: "egress" }), {
    status: "failed",
    requestId: "egress",
    error: "active-gm-only"
  });
  assert.deepEqual(await performIngress({ requestId: "ingress" }), {
    status: "failed",
    requestId: "ingress",
    error: "active-gm-only"
  });
  assert.equal(mutations, 0);
});

test("persistent GM hooks and windows use election-aware guards", () => {
  const root = new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1");
  const read = path => readFileSync(`${root}/${path}`, "utf8");
  assert.match(read("scripts/compendium-menu.js"), /handleAction[\s\S]*isActiveStorageGM\(\)/);
  assert.match(read("scripts/context-menu.js"), /handleInventoryGMAction[\s\S]*isActiveStorageGM\(\)/);
  assert.match(read("scripts/apps/currency-manager-app.js"), /export async function closeCurrencyManager\(\)/);
  assert.match(
    read("scripts/module.js"),
    /function suspendInactiveGmRuntime\(\)[\s\S]*closeCurrencyManager\(\)/
  );
});
