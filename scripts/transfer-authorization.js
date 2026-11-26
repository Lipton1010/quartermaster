/**
 * Quartermaster — Transfer Resolution and Authorization
 *
 * Pure policy helpers and UUID-aware document resolution used by the
 * authenticated GM-side transfer dispatcher. UUIDs are authoritative when
 * supplied; legacy world Actor/Item IDs remain supported only when a UUID is
 * absent.
 */

import { MODULE_ID, FLAGS } from "./constants.js";

const OWNER_LEVEL = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

/**
 * Resolve all documents referenced by a transfer payload.
 *
 * @param {Object} data
 * @returns {Promise<Object>} `{ ok: true, sourceActor, sourceItem, destActor }`
 *   or a stable failure envelope fragment.
 */
export async function resolveTransferDocuments(data = {}) {
  const sourceActorResult = await resolveActorReference({
    uuid: data.sourceActorUuid,
    id: data.sourceActorId,
    label: "source"
  });

  let sourceActor = sourceActorResult.document ?? null;

  const sourceItemResult = await resolveItemReference({
    uuid: data.sourceItemUuid,
    id: data.sourceItemId ?? data.itemId,
    actor: sourceActor,
    label: "source"
  });
  if (!sourceItemResult.ok) return sourceItemResult;

  const sourceItem = sourceItemResult.document;
  if (!sourceActor) sourceActor = sourceItem.parent ?? null;
  if (!sourceActorResult.ok && (data.sourceActorUuid || data.sourceActorId)) {
    return sourceActorResult;
  }
  if (!isActorDocument(sourceActor)) {
    return { ok: false, error: "source-actor-not-found" };
  }

  if (!sameDocument(sourceItem.parent, sourceActor)) {
    return {
      ok: false,
      error: "source-item-not-on-source-actor",
      sourceItemActualParent: sourceItem.parent?.uuid ?? sourceItem.parent?.id ?? null
    };
  }

  const destActorResult = await resolveActorReference({
    uuid: data.destActorUuid,
    id: data.destActorId ?? data.targetActorId,
    label: "destination"
  });
  if (!destActorResult.ok) return destActorResult;

  return {
    ok: true,
    sourceActor,
    sourceItem,
    destActor: destActorResult.document
  };
}

/**
 * Enforce transfer direction, storage boundaries, ownership and adapter
 * compatibility using the authenticated sender supplied by Foundry queries.
 */
export function authorizeTransfer({
  action,
  sender,
  sourceActor,
  sourceItem,
  destActor,
  backingActor,
  stagingActor = null,
  adapter = null
}) {
  if (!sender) return deny("unknown-sender");
  if (!isActorDocument(sourceActor)) return deny("source-actor-not-found");
  if (!isActorDocument(destActor)) return deny("destination-actor-not-found");
  if (!sourceItem || sourceItem.documentName !== "Item") {
    return deny("source-item-not-found");
  }
  if (!backingActor) return deny("no-backing-actor");

  const sourceIsVault = sameDocument(sourceActor, backingActor);
  const sourceIsStaging = sameDocument(sourceActor, stagingActor)
    || hasStorageMarker(sourceActor, FLAGS.STAGING_ACTOR_MARKER);
  const destIsVault = sameDocument(destActor, backingActor);
  const destIsStaging = sameDocument(destActor, stagingActor)
    || hasStorageMarker(destActor, FLAGS.STAGING_ACTOR_MARKER);
  const sourceIsQuartermaster = sourceIsVault || sourceIsStaging
    || hasStorageMarker(sourceActor, FLAGS.BACKING_ACTOR_MARKER);
  const destIsQuartermaster = destIsVault || destIsStaging
    || hasStorageMarker(destActor, FLAGS.BACKING_ACTOR_MARKER);

  if (action === "ingress") {
    if (!destIsVault || sourceIsQuartermaster) {
      return deny("invalid-transfer-boundary");
    }
    if (!sender.isGM && !actorOwnedBy(sourceActor, sender)) {
      return deny("source-actor-not-owned");
    }
  } else if (action === "egress") {
    // Players may only take visible vault items. A GM may additionally move
    // an item directly out of private staging.
    if ((!sourceIsVault && !(sender.isGM && sourceIsStaging)) || destIsQuartermaster) {
      return deny("invalid-transfer-boundary");
    }
    if (!sender.isGM && sourceItem.getFlag?.(MODULE_ID, FLAGS.HIDDEN) === true) {
      return deny("private-item-not-accessible");
    }
    if (!sender.isGM && !actorOwnedBy(destActor, sender)) {
      return deny("destination-actor-not-owned");
    }
  } else {
    return deny("unknown-action", { action });
  }

  const sourceRole = action === "ingress" ? "source" : "vault";
  const destRole = action === "ingress" ? "vault" : "recipient";
  try {
    if (typeof adapter?.isCompatibleActor === "function") {
      if (!adapter.isCompatibleActor(sourceActor, { role: sourceRole })) {
        return deny("incompatible-source-actor");
      }
      if (!adapter.isCompatibleActor(destActor, { role: destRole })) {
        return deny("incompatible-destination-actor");
      }
    }
    if (typeof adapter?.canReceiveItem === "function"
        && !adapter.canReceiveItem(sourceItem, destActor)) {
      return deny("incompatible-destination-item");
    }
  } catch (err) {
    return deny("adapter-preflight-failed", {
      details: errorMessage(err)
    });
  }

  return { ok: true };
}

export function actorOwnedBy(actor, user) {
  if (!actor || !user) return false;
  if (user.isGM) return true;
  try {
    return actor.testUserPermission?.(user, OWNER_LEVEL) === true;
  } catch {
    return false;
  }
}

export function sameDocument(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.uuid && right.uuid) return left.uuid === right.uuid;
  return left.documentName === right.documentName && left.id === right.id;
}

export function isQuartermasterStorageActor(actor) {
  return hasStorageMarker(actor, FLAGS.BACKING_ACTOR_MARKER)
    || hasStorageMarker(actor, FLAGS.STAGING_ACTOR_MARKER);
}

async function resolveActorReference({ uuid, id, label }) {
  if (uuid) {
    const document = await resolveUuid(uuid);
    if (!isActorDocument(document)) {
      return { ok: false, error: `${label}-actor-not-found`, [`${label}ActorUuid`]: uuid };
    }
    if (id && document.id !== id) {
      return { ok: false, error: `${label}-actor-reference-mismatch` };
    }
    return { ok: true, document };
  }

  if (!id) return { ok: false, error: `${label}-actor-not-found` };
  const document = globalThis.game?.actors?.get?.(id) ?? null;
  if (!isActorDocument(document)) {
    return { ok: false, error: `${label}-actor-not-found`, [`${label}ActorId`]: id };
  }
  return { ok: true, document, legacy: true };
}

async function resolveItemReference({ uuid, id, actor, label }) {
  if (uuid) {
    const document = await resolveUuid(uuid);
    if (!document || document.documentName !== "Item") {
      return { ok: false, error: `${label}-item-not-found`, [`${label}ItemUuid`]: uuid };
    }
    if (id && document.id !== id) {
      return { ok: false, error: `${label}-item-reference-mismatch` };
    }
    return { ok: true, document };
  }

  if (!id || !actor) {
    return { ok: false, error: `${label}-item-not-found`, [`${label}ItemId`]: id ?? null };
  }
  const document = actor.items?.get?.(id) ?? null;
  if (!document || document.documentName !== "Item") {
    return { ok: false, error: `${label}-item-not-found`, [`${label}ItemId`]: id };
  }
  return { ok: true, document, legacy: true };
}

async function resolveUuid(uuid) {
  if (typeof uuid !== "string" || !uuid || typeof globalThis.fromUuid !== "function") {
    return null;
  }
  try {
    return await globalThis.fromUuid(uuid);
  } catch {
    return null;
  }
}

function isActorDocument(document) {
  return document?.documentName === "Actor";
}

function hasStorageMarker(actor, marker) {
  if (!actor || !marker) return false;
  try {
    return actor.getFlag?.(MODULE_ID, marker) === true;
  } catch {
    return false;
  }
}

function deny(error, extras = {}) {
  return { ok: false, error, ...extras };
}

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}
