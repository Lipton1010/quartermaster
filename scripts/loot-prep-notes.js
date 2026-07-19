/**
 * Quartermaster — GM Loot Prep Notes
 *
 * Folder notes live on the corresponding lootPrepFolders entry. Individual
 * notes live on the hidden Item document. An individual note takes precedence;
 * clearing it restores the folder note automatically.
 */

import { MODULE_ID, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { getFolders } from "./loot-prep-folders.js";

const MAX_NOTE_LENGTH = 2000;

export function normalizeLootPrepNote(note) {
  if (typeof note !== "string") return "";
  return note.trim().slice(0, MAX_NOTE_LENGTH);
}

export function getItemNote(item) {
  return normalizeLootPrepNote(item?.getFlag?.(MODULE_ID, FLAGS.LOOT_PREP_NOTE));
}

export function getFolderNote(folder) {
  return normalizeLootPrepNote(folder?.note);
}

/**
 * Resolve the note shown for an item. Item notes always override folder notes.
 */
export function getEffectiveItemNote(item, folder = null) {
  const itemNote = getItemNote(item);
  if (itemNote) return { note: itemNote, source: "item" };

  const folderNote = getFolderNote(folder);
  if (folderNote) return { note: folderNote, source: "folder" };

  return { note: "", source: null };
}

export async function setItemNote(itemId, note) {
  if (!game.user.isGM) return false;
  const actor = getBackingActor();
  const item = actor?.items.get(itemId);
  if (!item) return false;

  const normalized = normalizeLootPrepNote(note);
  if (normalized) {
    await item.setFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE, normalized);
  } else {
    await item.unsetFlag(MODULE_ID, FLAGS.LOOT_PREP_NOTE);
  }
  return true;
}

export async function setFolderNote(folderId, note) {
  if (!game.user.isGM) return false;
  const actor = getBackingActor();
  if (!actor) return false;

  const folders = getFolders(actor);
  const index = folders.findIndex(folder => folder.id === folderId);
  if (index === -1) return false;

  const normalized = normalizeLootPrepNote(note);
  const updatedFolder = { ...folders[index] };
  if (normalized) updatedFolder.note = normalized;
  else delete updatedFolder.note;

  const updatedFolders = [...folders];
  updatedFolders[index] = updatedFolder;
  await actor.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS, updatedFolders);
  return true;
}
