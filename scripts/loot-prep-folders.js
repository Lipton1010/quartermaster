/** GM Loot Prep folders stored exclusively on the private staging actor. */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getStagingActor } from "./backing-actor.js";
import {
  isActiveStorageGM,
  requireActiveStorageGM,
  withStorageLedgerLock
} from "./storage-ledger.js";

export function getFolders(actor = getStagingActor()) {
  const storage = getStagingActor() ?? actor;
  if (!storage) return [];
  const folders = storage.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS);
  if (!Array.isArray(folders)) return [];
  return [...folders].sort((a, b) =>
    (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0)
  );
}

export function getFolder(actor, folderId) {
  return getFolders(actor).find(folder => folder.id === folderId) ?? null;
}

export async function createFolder(name) {
  if (!isActiveStorageGM()) return null;
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return null;
    const actor = getStagingActor();
    if (!actor) return null;
    const existing = getFolders(actor);
    const maxOrder = existing.reduce((max, folder) => Math.max(max, folder.order ?? 0), 0);
    const folder = {
      id: `qm-folder-${foundry.utils.randomID()}`,
      name: trimmed,
      order: maxOrder + 10,
      createdAt: Date.now()
    };
    await writeVerifiedArrayFlag(actor, FLAGS.LOOT_PREP_FOLDERS, [...existing, folder]);
    console.debug(`${MODULE_TITLE} | createFolder: "${trimmed}"`);
    return folder;
  });
}

export async function renameFolder(folderId, newName) {
  if (!isActiveStorageGM()) return false;
  const trimmed = (newName ?? "").trim();
  if (!trimmed) return false;
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return false;
    const actor = getStagingActor();
    if (!actor) return false;
    const existing = getFolders(actor);
    const index = existing.findIndex(folder => folder.id === folderId);
    if (index < 0) return false;
    const updated = [...existing];
    updated[index] = { ...updated[index], name: trimmed };
    await writeVerifiedArrayFlag(actor, FLAGS.LOOT_PREP_FOLDERS, updated);
    return true;
  });
}

export async function deleteFolder(folderId) {
  if (!isActiveStorageGM()) return false;
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return false;
    const actor = getStagingActor();
    if (!actor) return false;
    const existing = getFolders(actor);
    const updated = existing.filter(folder => folder.id !== folderId);
    if (updated.length === existing.length) return false;
    await writeVerifiedArrayFlag(actor, FLAGS.LOOT_PREP_FOLDERS, updated);

    for (const item of actor.items.filter(candidate =>
      candidate.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDER) === folderId
    )) {
      requireActiveStorageGM();
      await item.unsetFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDER);
    }
    const currency = actor.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY);
    if (Array.isArray(currency) && currency.some(entry => entry.folderId === folderId)) {
      await writeVerifiedArrayFlag(actor, FLAGS.HIDDEN_CURRENCY, currency.map(entry =>
        entry.folderId === folderId ? { ...entry, folderId: null } : entry
      ));
    }
    return true;
  });
}

export async function setItemFolder(itemId, folderId) {
  if (!isActiveStorageGM()) return false;
  const item = getStagingActor()?.items.get(itemId);
  if (!item) return false;
  requireActiveStorageGM();
  if (folderId) await item.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDER, folderId);
  else await item.unsetFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDER);
  return true;
}

async function writeVerifiedArrayFlag(actor, flag, intended) {
  requireActiveStorageGM();
  let writeError = null;
  try {
    await actor.setFlag(MODULE_ID, flag, clone(intended));
  } catch (error) {
    writeError = error;
  }
  const retained = actor.getFlag(MODULE_ID, flag);
  if (!Array.isArray(retained) || stableStringify(retained) !== stableStringify(intended)) {
    if (writeError) throw writeError;
    throw new Error(`${flag}-verification-failed`);
  }
  if (writeError) {
    console.warn(`${MODULE_TITLE} | ${flag} committed despite an update error`, writeError);
  }
}

function clone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  ).join(",")}}`;
}
