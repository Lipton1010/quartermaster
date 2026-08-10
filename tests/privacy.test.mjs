import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  projectPublicTransactionLog,
  redactTransactionEntry
} from "../scripts/storage-privacy.js";
import {
  buildStorageActorData,
  isStorageSystemCompatible,
  preventBackingActorCharacterAssignment,
  registerStoragePrivacyHooks,
  suppressBackingActorFromUserConfig
} from "../scripts/backing-actor.js";
import { releaseItemSnapshot } from "../scripts/transaction-log.js";
import { FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";

test("shared and private storage Actors have distinct default visibility", () => {
  const users = [{ id: "gm", isGM: true }, { id: "player", isGM: false }];
  const shared = buildStorageActorData({
    purpose: "shared", type: "npc", users, moduleVersion: "1.0.0"
  });
  const staging = buildStorageActorData({
    purpose: "staging", type: "npc", users, moduleVersion: "1.0.0"
  });

  assert.equal(shared.ownership.default, 2);
  assert.equal(staging.ownership.default, 0);
  assert.equal(shared.ownership.gm, 3);
  assert.equal(staging.ownership.gm, 3);
  assert.equal(shared.ownership.player, 2);
  assert.equal(staging.ownership.player, 0);
  assert.equal(shared.flags[MODULE_ID][FLAGS.BACKING_ACTOR_MARKER], true);
  assert.equal(staging.flags[MODULE_ID][FLAGS.STAGING_ACTOR_MARKER], true);
  assert.deepEqual(staging.flags[MODULE_ID][FLAGS.RECOVERY_RECORDS], []);
  assert.deepEqual(staging.flags[MODULE_ID][FLAGS.OPERATION_TOMBSTONES], []);
});

test("storage bound to a different game system fails compatibility", () => {
  const actor = {
    getFlag(scope, key) {
      return scope === MODULE_ID && key === FLAGS.STORAGE_SYSTEM_ID ? "dnd5e" : undefined;
    }
  };
  assert.equal(isStorageSystemCompatible(actor, "dnd5e"), true);
  assert.equal(isStorageSystemCompatible(actor, "pf2e"), false);
});

test("storage Actors are removed from a UserConfig rendered before runtime activation", (t) => {
  const oldGame = globalThis.game;
  const oldUi = globalThis.ui;
  const shared = {
    id: "vault",
    uuid: "Actor.vault",
    getFlag(scope, key) {
      return scope === MODULE_ID && key === FLAGS.BACKING_ACTOR_MARKER;
    }
  };
  globalThis.game = {
    actors: {
      get: id => id === shared.id ? shared : null,
      find: predicate => predicate(shared) ? shared : null
    },
    settings: {
      get(_scope, key) {
        return key === SETTINGS.BACKING_ACTOR_ID ? shared.id : null;
      }
    }
  };
  globalThis.ui = { notifications: { warn() {} } };
  t.after(() => {
    globalThis.game = oldGame;
    globalThis.ui = oldUi;
  });

  const group = {
    removed: false,
    querySelector: () => null,
    remove() { this.removed = true; }
  };
  const option = {
    removed: false,
    closest: () => group,
    remove() { this.removed = true; }
  };
  const root = {
    querySelectorAll(selector) {
      return selector === 'select[name="character"] option[value="vault"]' ? [option] : [];
    }
  };

  suppressBackingActorFromUserConfig(null, root);
  assert.equal(option.removed, true);
  assert.equal(group.removed, true);

  const changes = { character: shared.id, name: "Player" };
  assert.equal(preventBackingActorCharacterAssignment({}, changes), false);
  assert.equal(changes.character, null);
});

test("selector privacy hooks register before the ready-gated runtime", (t) => {
  const oldHooks = globalThis.Hooks;
  const registrations = [];
  globalThis.Hooks = {
    on(name, callback) { registrations.push([name, callback]); }
  };
  t.after(() => { globalThis.Hooks = oldHooks; });

  registerStoragePrivacyHooks();
  assert.deepEqual(registrations.map(([name]) => name), ["renderUserConfig", "preUpdateUser"]);

  const moduleSource = readFileSync(
    new URL("../scripts/module.js", import.meta.url),
    "utf8"
  );
  assert.ok(
    moduleSource.indexOf("registerStoragePrivacyHooks();") < moduleSource.indexOf('Hooks.once("init"'),
    "privacy hooks must be registered before Foundry init and the ready-gated runtime"
  );
});

test("canonical log projection removes hidden operations and sensitive payloads", () => {
  const visible = {
    id: "visible",
    timestamp: 1,
    type: "item.egress",
    itemName: "Lantern",
    sourceActorName: "Vault",
    destActorName: "Hero",
    itemData: { system: { secret: true } },
    recoverySnapshot: { hidden: true },
    error: "internal stack trace"
  };
  const projected = redactTransactionEntry(visible);
  assert.equal(projected.itemName, "Lantern");
  assert.equal("itemData" in projected, false);
  assert.equal("recoverySnapshot" in projected, false);
  assert.equal("error" in projected, false);

  assert.equal(redactTransactionEntry({
    id: "secret",
    timestamp: 2,
    type: "hidden.staged",
    itemName: "Spoiler"
  }), null);
  assert.equal(redactTransactionEntry({
    id: "gm",
    timestamp: 3,
    type: "item.egress",
    visibility: "gm"
  }), null);

  assert.deepEqual(projectPublicTransactionLog([visible], { enabled: false }), []);
  assert.deepEqual(projectPublicTransactionLog([visible], { enabled: true }), [projected]);
});

test("terminal transfers release snapshots while interrupted claims retain them", async (t) => {
  const canonical = [
    {
      id: "terminal-claim",
      timestamp: 1,
      type: "transfer.egress.claim",
      requestId: "terminal",
      itemData: { name: "Sword", system: { secret: true } }
    },
    {
      id: "terminal-commit",
      timestamp: 2,
      type: "transfer.egress.commit",
      requestId: "terminal"
    },
    {
      id: "pending-claim",
      timestamp: 3,
      type: "transfer.ingress.claim",
      requestId: "pending",
      itemData: { name: "Map", system: { secret: true } }
    }
  ];
  const values = new Map();
  const storageActor = (id, marker, log = []) => ({
    id,
    documentName: "Actor",
    getFlag(scope, key) {
      if (scope !== MODULE_ID) return undefined;
      if (key === marker) return true;
      if (key === FLAGS.TRANSACTION_LOG) return values.get(`${id}:log`) ?? log;
      return undefined;
    },
    async setFlag(scope, key, value) {
      assert.equal(scope, MODULE_ID);
      if (key === FLAGS.TRANSACTION_LOG) values.set(`${id}:log`, value);
    }
  });
  const staging = storageActor("staging", FLAGS.STAGING_ACTOR_MARKER, canonical);
  const backing = storageActor("backing", FLAGS.BACKING_ACTOR_MARKER, []);
  const oldGame = globalThis.game;
  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: { activeGM: { id: "gm", isGM: true } },
    actors: new Map([[staging.id, staging], [backing.id, backing]]),
    settings: {
      get(_scope, key) {
        if (key === SETTINGS.STAGING_ACTOR_ID) return staging.id;
        if (key === SETTINGS.BACKING_ACTOR_ID) return backing.id;
        return null;
      }
    }
  };
  t.after(() => { globalThis.game = oldGame; });

  assert.equal(await releaseItemSnapshot("terminal"), 1);
  const updated = values.get("staging:log");
  assert.equal("itemData" in updated[0], false);
  assert.deepEqual(updated[2].itemData, canonical[2].itemData);
});
