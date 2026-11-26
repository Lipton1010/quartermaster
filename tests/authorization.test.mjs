import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { authorizeTransfer, resolveTransferDocuments } from "../scripts/transfer-authorization.js";
import { compensateDestinationItem } from "../scripts/claim-commit.js";

function actor(id, { marker = null, owned = false, type = "character" } = {}) {
  return {
    id,
    uuid: `Actor.${id}`,
    type,
    documentName: "Actor",
    items: new Map(),
    createEmbeddedDocuments() {},
    getFlag(_module, flag) { return flag === marker; },
    testUserPermission() { return owned; }
  };
}

function item(id, parent) {
  const document = {
    id,
    uuid: `${parent.uuid}.Item.${id}`,
    name: id,
    type: "loot",
    documentName: "Item",
    parent
  };
  parent.items.set(id, document);
  return document;
}

const adapter = {
  isCompatibleActor(value) { return value.type !== "forbidden"; },
  canReceiveItem(_item, destination) { return destination.type !== "blocked"; }
};

test("GM-side ingress requires the shared vault and player ownership", () => {
  const vault = actor("vault", { marker: "backingActorMarker", type: "npc" });
  const source = actor("hero", { owned: true });
  const sourceItem = item("gem", source);
  const player = { id: "player", isGM: false };

  assert.deepEqual(authorizeTransfer({
    action: "ingress", sender: player, sourceActor: source, sourceItem,
    destActor: vault, backingActor: vault, adapter
  }), { ok: true });

  const unowned = actor("other", { owned: false });
  const stolen = item("stolen", unowned);
  assert.equal(authorizeTransfer({
    action: "ingress", sender: player, sourceActor: unowned, sourceItem: stolen,
    destActor: vault, backingActor: vault, adapter
  }).error, "source-actor-not-owned");

  assert.equal(authorizeTransfer({
    action: "ingress", sender: player, sourceActor: source, sourceItem,
    destActor: actor("not-vault"), backingActor: vault, adapter
  }).error, "invalid-transfer-boundary");
});

test("egress permits any compatible owned Actor but denies private or cross-storage targets", () => {
  const vault = actor("vault", { marker: "backingActorMarker", type: "npc" });
  const staging = actor("staging", { marker: "stagingActorMarker", type: "npc" });
  const vaultItem = item("map", vault);
  const player = { id: "player", isGM: false };
  const owned = actor("companion", { owned: true });

  assert.deepEqual(authorizeTransfer({
    action: "egress", sender: player, sourceActor: vault, sourceItem: vaultItem,
    destActor: owned, backingActor: vault, stagingActor: staging, adapter
  }), { ok: true });
  assert.equal(authorizeTransfer({
    action: "egress", sender: player, sourceActor: staging, sourceItem: item("secret", staging),
    destActor: owned, backingActor: vault, stagingActor: staging, adapter
  }).error, "invalid-transfer-boundary");
  assert.equal(authorizeTransfer({
    action: "egress", sender: player, sourceActor: vault, sourceItem: vaultItem,
    destActor: staging, backingActor: vault, stagingActor: staging, adapter
  }).error, "invalid-transfer-boundary");
});

test("UUID references are authoritative and mismatched legacy IDs fail closed", async () => {
  const source = actor("hero", { owned: true });
  const destination = actor("vault", { marker: "backingActorMarker" });
  const sourceItem = item("gem", source);
  const byUuid = new Map([
    [source.uuid, source],
    [destination.uuid, destination],
    [sourceItem.uuid, sourceItem]
  ]);
  globalThis.fromUuid = async uuid => byUuid.get(uuid) ?? null;
  const activeGM = { id: "gm", isGM: true };
  globalThis.game = {
    user: activeGM,
    users: { activeGM },
    actors: new Map([[source.id, source], [destination.id, destination]])
  };

  const resolved = await resolveTransferDocuments({
    sourceActorUuid: source.uuid,
    sourceActorId: source.id,
    sourceItemUuid: sourceItem.uuid,
    sourceItemId: sourceItem.id,
    destActorUuid: destination.uuid,
    destActorId: destination.id
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.sourceItem, sourceItem);

  assert.equal((await resolveTransferDocuments({
    sourceActorUuid: source.uuid,
    sourceActorId: "spoofed",
    sourceItemUuid: sourceItem.uuid,
    destActorUuid: destination.uuid
  })).error, "source-actor-reference-mismatch");
});

test("destination compensation verifies removal and reports failures", async (t) => {
  const items = new Map([["created", { id: "created" }]]);
  const destination = {
    items,
    async deleteEmbeddedDocuments(_type, ids) {
      for (const id of ids) items.delete(id);
    }
  };
  assert.deepEqual(
    await compensateDestinationItem(destination, "created"),
    { success: true, error: null }
  );

  const expected = new Error("delete denied");
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });
  const failed = await compensateDestinationItem({
    items: new Map([["created", { id: "created" }]]),
    async deleteEmbeddedDocuments() { throw expected; }
  }, "created");
  assert.equal(failed.success, false);
  assert.equal(failed.error, expected);
});

test("player mutation transport has no unauthenticated raw-socket fallback", () => {
  const source = readFileSync(new URL("../scripts/socket-handler.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /game\.socket\.(?:on|emit)\s*\(/);
  assert.match(source, /authenticated-query-unavailable/);
  assert.match(source, /unauthenticated-query/);
  assert.match(source, /options\.user/);
  assert.match(source, /hasOwnProperty\.call\(payload, "timestamp"\)/);
  assert.doesNotMatch(source, /if \(!payload\.timestamp\)/);
});
