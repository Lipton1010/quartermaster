/** Private GM Loot Prep notes. */

import { MODULE_ID, FLAGS } from "./constants.js";
import { getStagingActor } from "./backing-actor.js";
import { getFolders } from "./loot-prep-folders.js";
import {
  isActiveStorageGM,
  requireActiveStorageGM,
  withStorageLedgerLock
} from "./storage-ledger.js";

const MAX_NOTE_LENGTH = 2000;

export function normalizeLootPrepNote(note) {
  return typeof note === "string" ? note.trim().slice(0, MAX_NOTE_LENGTH) : "";
}

export function getItemNote(item) {
  return normalizeLootPrepNote(item?.getFlag?.(MODULE_ID, FLAGS.LOOT_PREP_NOTE));
}

export function getFolderNote(folder) {
  return normalizeLootPrepNote(folder?.note);
}

export function getEffectiveItemNote(item, folder = null) {
  const itemNote = getItemNote(item);
  if (itemNote) return { note: itemNote, source: "item" };
  const folderNote = getFolderNote(folder);
  if (folderNote) return { note: folderNote, source: "folder" };
  return { note: "", source: null };
}

export async function setItemNote(itemId, note) {
  if (!isActiveStorageGM()) return false;
  const item = getStagingActor()?.items.get(itemId);
  if (!item) return false;
  const normalized = normalizeLootPrepNote(note);
  requireActiveStorageGM();
  if (normalized) await item.setFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE, normalized);
  else await item.unsetFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE);
  return true;
}

export async function setFolderNote(folderId, note) {
  if (!isActiveStorageGM()) return false;
  return withStorageLedgerLock(async () => {
    if (!isActiveStorageGM()) return false;
    const actor = getStagingActor();
    if (!actor) return false;
    const folders = getFolders(actor);
    const index = folders.findIndex(folder => folder.id === folderId);
    if (index < 0) return false;
    const updatedFolder = { ...folders[index] };
    const normalized = normalizeLootPrepNote(note);
    if (normalized) updatedFolder.note = normalized;
    else delete updatedFolder.note;
    const updated = [...folders];
    updated[index] = updatedFolder;
    requireActiveStorageGM();
    let writeError = null;
    try {
      await actor.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS, updated);
    } catch (error) {
      writeError = error;
    }
    const retained = getFolders(actor);
    if (stableStringify(retained) !== stableStringify(updated)) {
      if (writeError) throw writeError;
      throw new Error("loot-prep-folder-note-verification-failed");
    }
    return true;
  });
}

// A key present with an `undefined` value is indistinguishable from an
// absent key once Foundry actually persists a flag - JSON has no `undefined`.
// Match that here so a benign, system-dependent `undefined` leaf isn't
// mistaken for lost or corrupted data. Array elements still become `null`,
// matching JSON.stringify.
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry) ?? "null").join(",")}]`;
  }
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
