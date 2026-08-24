import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { FLAGS, SETTINGS } from "../scripts/constants.js";

globalThis.foundry = {
  utils: { randomID: () => "test-request-id" },
  applications: {
    api: { DialogV2: class {} },
    instances: new Map()
  }
};
globalThis.game = {
  user: { id: "gm", isGM: true },
  system: { id: "generic" },
  actors: new Map(),
  settings: { get: () => null, storage: { get: () => new Map() } }
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.CONFIG = { Actor: {}, Item: {}, queries: {} };
globalThis.Hooks = { on() {}, once() {}, call() {} };

const {
  resolveActorSheetFromDropEvent,
  handleDocumentCaptureDrop,
  makeSheetDropDedupKey,
  resetSheetDropDedupForTests,
  resetEgressInterceptorForTests,
  registerEgressInterceptor,
  bindSubmitRequestForTests
} = await import("../scripts/drag-drop.js");

const submitCalls = [];

function actor(id, { uuid = null, owned = false, marker = null, type = "character" } = {}) {
  const resolvedUuid = uuid ?? `Actor.${id}`;
  return {
    id,
    uuid: resolvedUuid,
    name: id,
    type,
    documentName: "Actor",
    items: new Map(),
    createEmbeddedDocuments() {},
    getFlag(_module, flag) { return flag === marker; },
    testUserPermission(_user, _level) { return owned; }
  };
}

function item(id, parent, { uuid = null } = {}) {
  const resolvedUuid = uuid ?? `${parent.uuid}.Item.${id}`;
  const document = {
    id,
    uuid: resolvedUuid,
    name: id,
    type: "loot",
    documentName: "Item",
    parent
  };
  parent.items.set(id, document);
  return document;
}

function makeElement(id = "", parent = null) {
  return { id, parentElement: parent };
}

function makeDropEvent(target, payload) {
  const calls = { preventDefault: 0, stopImmediatePropagation: 0 };
  const dataTransfer = {
    getData(type) {
      if (type === "text/plain") return JSON.stringify(payload);
      return "";
    }
  };
  return {
    target,
    dataTransfer,
    preventDefault() { calls.preventDefault += 1; },
    stopImmediatePropagation() { calls.stopImmediatePropagation += 1; },
    calls,
    timeStamp: Date.now()
  };
}

function makeActorCollection(actors) {
  const byId = new Map(actors.map(a => [a.id, a]));
  return {
    get(id) { return byId.get(id); },
    find(fn) {
      for (const actor of byId.values()) {
        if (fn(actor)) return actor;
      }
      return null;
    }
  };
}

function installGlobals({ user = { id: "gm", isGM: true }, vault, actors = [] } = {}) {
  globalThis.foundry = {
    utils: { randomID: () => "test-request-id" },
    applications: {
      api: { DialogV2: class {} },
      instances: new Map()
    }
  };
  globalThis.game = {
    user,
    system: { id: "generic" },
    actors: makeActorCollection(actors),
    settings: {
      get(_scope, key) {
        if (key === SETTINGS.BACKING_ACTOR_ID) return vault?.id ?? null;
        return null;
      },
      storage: { get: () => new Map() }
    }
  };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} }, windows: {} };
  globalThis.CONFIG = { Actor: {}, Item: {}, queries: {} };
}

let hookHandler = null;

beforeEach(() => {
  submitCalls.length = 0;
  resetSheetDropDedupForTests();
  resetEgressInterceptorForTests();
  bindSubmitRequestForTests(async (payload) => {
    submitCalls.push(payload);
    return { status: "success" };
  });
  hookHandler = null;
  globalThis.document = { addEventListener() {} };
  globalThis.Hooks = {
    on(name, fn) {
      if (name === "dropActorSheetData") hookHandler = fn;
    }
  };
});

afterEach(() => {
  resetSheetDropDedupForTests();
  bindSubmitRequestForTests(null);
});

test("resolveActorSheetFromDropEvent walks to ApplicationV2 roots via foundry.applications.instances", () => {
  const dest = actor("hero");
  const sheetRoot = makeElement("CharacterSheetV2-Actor-hero");
  const inner = makeElement("", sheetRoot);

  globalThis.foundry = {
    applications: {
      instances: new Map([
        [sheetRoot.id, { document: dest }]
      ])
    }
  };
  globalThis.ui = { windows: {} };

  const resolved = resolveActorSheetFromDropEvent({ target: inner });
  assert.equal(resolved?.actor, dest);
});

test("resolveActorSheetFromDropEvent walks legacy ApplicationV1 roots via ui.windows", () => {
  const dest = actor("hero");
  const sheetRoot = makeElement("CharacterSheetPF2e-Actor-hero");
  const inner = makeElement("", sheetRoot);
  const sheet = { id: sheetRoot.id, actor: dest };

  globalThis.foundry = {
    applications: {
      instances: new Map()
    }
  };
  globalThis.ui = { windows: { 130: sheet } };

  const resolved = resolveActorSheetFromDropEvent({ target: inner });
  assert.equal(resolved?.actor, dest);
  assert.equal(resolved?.sheet, sheet);
});

test("marked capture drop on a legacy ApplicationV1 sheet routes through submitRequest", async () => {
  const vault = actor("vault", { marker: FLAGS.BACKING_ACTOR_MARKER, type: "npc" });
  const dest = actor("hero", { owned: true });
  const sourceItem = item("dagger", vault);
  installGlobals({ vault, actors: [vault, dest] });
  globalThis.fromUuid = async (uuid) => (uuid === sourceItem.uuid ? sourceItem : null);

  const sheetRoot = makeElement("CharacterSheetPF2e-Actor-hero");
  const inner = makeElement("", sheetRoot);
  globalThis.ui.windows = { 131: { id: sheetRoot.id, actor: dest } };

  const payload = {
    type: "Item",
    uuid: sourceItem.uuid,
    qmEgressDrag: true,
    qmSourceItemUuid: sourceItem.uuid,
    qmSourceItemName: sourceItem.name
  };
  const event = makeDropEvent(inner, payload);

  await handleDocumentCaptureDrop(event);
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0].action, "egress");
  assert.equal(submitCalls[0].payload.destActorUuid, dest.uuid);
  assert.equal(event.calls.preventDefault, 1);
  assert.equal(event.calls.stopImmediatePropagation, 1);
});

test("marked capture drop routes through submitRequest when dropActorSheetData would not fire", async () => {
  const vault = actor("vault", { marker: FLAGS.BACKING_ACTOR_MARKER, type: "npc" });
  const dest = actor("hero", { owned: true });
  const sourceItem = item("gem", vault);
  installGlobals({ vault, actors: [vault, dest] });
  globalThis.fromUuid = async (uuid) => (uuid === sourceItem.uuid ? sourceItem : null);

  const sheetRoot = makeElement("NoHookSheet-Actor-hero");
  const inner = makeElement("", sheetRoot);
  foundry.applications.instances.set(sheetRoot.id, { document: dest });
  globalThis.ui.windows = {};

  const payload = {
    type: "Item",
    uuid: sourceItem.uuid,
    qmEgressDrag: true,
    qmSourceItemUuid: sourceItem.uuid,
    qmSourceItemName: sourceItem.name
  };
  const event = makeDropEvent(inner, payload);

  await handleDocumentCaptureDrop(event);
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0].action, "egress");
  assert.equal(submitCalls[0].payload.sourceItemUuid, sourceItem.uuid);
  assert.equal(submitCalls[0].payload.sourceActorUuid, vault.uuid);
  assert.equal(submitCalls[0].payload.destActorUuid, dest.uuid);
  assert.equal(event.calls.preventDefault, 1);
  assert.equal(event.calls.stopImmediatePropagation, 1);
});

test("unmarked Foundry-native sheet drops are ignored by the capture interceptor", async () => {
  const dest = actor("hero");
  installGlobals({ actors: [dest] });

  const sheetRoot = makeElement("NativeSheet-Actor-hero");
  const inner = makeElement("", sheetRoot);
  foundry.applications.instances.set(sheetRoot.id, { document: dest });

  const event = makeDropEvent(inner, { type: "Item", uuid: "Actor.hero.Item.native" });

  await handleDocumentCaptureDrop(event);
  assert.equal(submitCalls.length, 0);
  assert.equal(event.calls.preventDefault, 0);
  assert.equal(event.calls.stopImmediatePropagation, 0);
});

test("capture and hook paths dedupe to a single submitRequest", async () => {
  const vault = actor("vault", { marker: FLAGS.BACKING_ACTOR_MARKER, type: "npc" });
  const dest = actor("hero", { owned: true });
  const sourceItem = item("map", vault);
  installGlobals({ vault, actors: [vault, dest] });
  globalThis.fromUuid = async (uuid) => (uuid === sourceItem.uuid ? sourceItem : null);

  registerEgressInterceptor();
  assert.ok(hookHandler, "expected dropActorSheetData hook registration");

  const payload = {
    type: "Item",
    uuid: sourceItem.uuid,
    qmEgressDrag: true,
    qmSourceItemUuid: sourceItem.uuid
  };

  const sheetRoot = makeElement("DedupeSheet-Actor-hero");
  const inner = makeElement("", sheetRoot);
  foundry.applications.instances.set(sheetRoot.id, { document: dest, actor: dest });

  const event = makeDropEvent(inner, payload);

  await handleDocumentCaptureDrop(event);
  const hookResult = hookHandler(dest, { document: dest }, payload);
  assert.equal(hookResult, false);
  assert.equal(submitCalls.length, 1);
  assert.equal(
    makeSheetDropDedupKey(dest, payload),
    `${dest.uuid}:${sourceItem.uuid}`
  );
});

test("hostile unauthorized destination is rejected without submitRequest", async () => {
  const vault = actor("vault", { marker: FLAGS.BACKING_ACTOR_MARKER, type: "npc" });
  const hostile = actor("foe", { owned: false });
  const sourceItem = item("secret", vault);
  const player = { id: "player", isGM: false };
  installGlobals({ user: player, vault, actors: [vault, hostile] });
  globalThis.fromUuid = async (uuid) => (uuid === sourceItem.uuid ? sourceItem : null);

  const sheetRoot = makeElement("HostileSheet-Actor-foe");
  const inner = makeElement("", sheetRoot);
  foundry.applications.instances.set(sheetRoot.id, { document: hostile });

  const payload = {
    type: "Item",
    uuid: sourceItem.uuid,
    qmEgressDrag: true,
    qmSourceItemUuid: sourceItem.uuid
  };

  await handleDocumentCaptureDrop(makeDropEvent(inner, payload));
  assert.equal(submitCalls.length, 0);
});

test("synthetic token actor UUIDs are preserved in the egress payload", async () => {
  const vault = actor("vault", { marker: FLAGS.BACKING_ACTOR_MARKER, type: "npc" });
  const tokenActor = actor("tokenActor", {
    uuid: "Scene.scene1.Token.token1.Actor.tokenActor",
    owned: true
  });
  const sourceItem = item("coin", vault, {
    uuid: "Actor.vault.Item.coin"
  });
  installGlobals({ vault, actors: [vault, tokenActor] });
  globalThis.fromUuid = async (uuid) => (uuid === sourceItem.uuid ? sourceItem : null);

  registerEgressInterceptor();

  const payload = {
    type: "Item",
    uuid: sourceItem.uuid,
    qmEgressDrag: true,
    qmSourceItemUuid: sourceItem.uuid
  };

  hookHandler(tokenActor, {}, payload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0].payload.sourceActorUuid, vault.uuid);
  assert.equal(submitCalls[0].payload.sourceItemUuid, "Actor.vault.Item.coin");
  assert.equal(submitCalls[0].payload.destActorUuid, "Scene.scene1.Token.token1.Actor.tokenActor");
  assert.equal(submitCalls[0].payload.destActorId, tokenActor.id);
});
