/**
 * Quartermaster — Loot Prep Folders (v0.1.2)
 *
 * Organizational folders for hidden items and currency in GM Loot Prep.
 * Stored as a flag array on the backing actor:
 *   actor.flags.quartermaster.lootPrepFolders[]
 *
 * Hidden items and currency entries reference a folderId to associate
 * with a folder. Items without a folderId appear in "Uncategorized."
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";

// ============================================================
// Read
// ============================================================

export function getFolders(actor) {
  if (!actor) return [];
  const folders = actor.getFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS) ?? [];
  if (!Array.isArray(folders)) return [];
  return folders.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function getFolder(actor, folderId) {
  return getFolders(actor).find(f => f.id === folderId) ?? null;
}

// ============================================================
// Write
// ============================================================

export async function createFolder(name) {
  if (!game.user.isGM) return null;
  const actor = getBackingActor();
  if (!actor) return null;

  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;

  const existing = getFolders(actor);
  const maxOrder = existing.reduce((max, f) => Math.max(max, f.order ?? 0), 0);

  const folder = {
    id: `qm-folder-${foundry.utils.randomID()}`,
    name: trimmed,
    order: maxOrder + 10,
    createdAt: Date.now()
  };

  await actor.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS, [...existing, folder]);
  console.debug(`${MODULE_TITLE} | createFolder: "${trimmed}"`);
  return folder;
}

export async function renameFolder(folderId, newName) {
  if (!game.user.isGM) return false;
  const actor = getBackingActor();
  if (!actor) return false;

  const trimmed = (newName ?? "").trim();
  if (!trimmed) return false;

  const existing = getFolders(actor);
  const idx = existing.findIndex(f => f.id === folderId);
  if (idx === -1) return false;

  const updated = [...existing];
  updated[idx] = { ...updated[idx], name: trimmed };
  await actor.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS, updated);
  return true;
}

export async function deleteFolder(folderId) {
  if (!game.user.isGM) return false;
  const actor = getBackingActor();
  if (!actor) return false;

  const existing = getFolders(actor);
  const updated = existing.filter(f => f.id !== folderId);
  if (updated.length === existing.length) return false; // not found

  await actor.setFlag(MODULE_ID, FLAGS.LOOT_PREP_FOLDERS, updated);

  // Unassign items and currency entries from this folder
  // (move them to uncategorized rather than deleting them)
  const items = actor.items.filter(i => {
    return i.getFlag(MODULE_ID, "lootPrepFolder") === folderId;
  });
  for (const item of items) {
    await item.unsetFlag(MODULE_ID, "lootPrepFolder");
  }

  const hiddenCurrency = actor.getFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY) ?? [];
  if (hiddenCurrency.some(e => e.folderId === folderId)) {
    const updatedCurrency = hiddenCurrency.map(e =>
      e.folderId === folderId ? { ...e, folderId: null } : e
    );
    await actor.setFlag(MODULE_ID, FLAGS.HIDDEN_CURRENCY, updatedCurrency);
  }

  console.debug(`${MODULE_TITLE} | deleteFolder: removed "${folderId}"`);
  return true;
}

/**
 * Assign a hidden item to a folder.
 */
export async function setItemFolder(itemId, folderId) {
  if (!game.user.isGM) return false;
  const actor = getBackingActor();
  if (!actor) return false;

  const item = actor.items.get(itemId);
  if (!item) return false;

  if (folderId) {
    await item.setFlag(MODULE_ID, "lootPrepFolder", folderId);
  } else {
    await item.unsetFlag(MODULE_ID, "lootPrepFolder");
  }
  return true;
}
