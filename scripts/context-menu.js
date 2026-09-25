/**
 * Quartermaster — Inventory Context Menu (step 16)
 *
 * Provides a right-click context menu on item rows in the Shared Party
 * Inventory popup. GM-only actions:
 *
 *   - Hide (send to Loot Prep)  — sets the hidden flag, moves item out of
 *                                  the visible inventory back into the
 *                                  hidden staging pool
 *   - Delete Item               — permanently removes the item from the
 *                                  backing actor entirely
 *
 * Foundry manages menu placement and dismissal. GM conditions are checked
 * whenever the menu opens; players retain the Add to Actor action.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { setItemHidden } from "./hidden-items.js";
import { isActiveStorageGM, requireActiveStorageGM, withItemMutationLock } from "./storage-ledger.js";
import { writeEntry } from "./transaction-log.js";
import { transferInventoryItemToActor } from "./drag-drop.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";
import {
  actorOwnedBy,
  isQuartermasterStorageActor
} from "./transfer-authorization.js";

// ============================================================
// Internal state
// ============================================================

const attachedRoots = new WeakSet();

const escapeHtml = value => foundry.utils.escapeHTML(typeof value === "string" ? value : "");

// ============================================================
// Public: attach right-click listener to inventory popup
// ============================================================

/**
 * Wire contextmenu listener on every .qm-item-row in the rendered popup.
 * Called from InventoryApp._onRender after each render pass.
 *
 * @param {InventoryApp} app
 */
export function attachInventoryContextMenu(app) {
  const el = app?.element;
  if (!el || attachedRoots.has(el)) return;
  new foundry.applications.ux.ContextMenu(el, ".qm-item-row", [
    {
      name: "Add to Actor...",
      icon: '<i class="fa-solid fa-user-plus"></i>',
      callback: row => handleAddToCharacter(row.dataset.itemId, app)
    },
    {
      name: "Hide (send to Loot Prep)",
      icon: '<i class="fa-solid fa-eye-slash"></i>',
      condition: () => isActiveStorageGM(),
      callback: row => handleHideItem(row.dataset.itemId, app)
    },
    {
      name: "Delete Item",
      icon: '<i class="fa-solid fa-trash"></i>',
      condition: () => isActiveStorageGM(),
      callback: row => handleDeleteItem(row.dataset.itemId,
        row.querySelector(".qm-item-name")?.textContent?.trim() ?? "(item)", app)
    }
  ], { jQuery: false, fixed: true });
  attachedRoots.add(el);
}

// ============================================================
// Action dispatch
// ============================================================

export async function handleInventoryGMAction(action, itemId, itemName, app) {
  if (!isActiveStorageGM()) return;
  return handleContextAction(action, itemId, itemName, app);
}

async function handleContextAction(action, itemId, itemName, app) {
  switch (action) {
    case "add-to-character": return handleAddToCharacter(itemId, app);
    case "hide-item":        return handleHideItem(itemId, app);
    case "delete-item":      return handleDeleteItem(itemId, itemName, app);
    default:
      console.warn(`${MODULE_TITLE} | unknown context action: ${action}`);
  }
}

function getAssignedCharacter() {
  const character = game.user.character;
  if (character?.documentName === "Actor") return character;

  const id = typeof character === "string"
    ? character
    : game.user._source?.character ?? game.user.characterId ?? null;
  return id ? game.actors.get(id) ?? null : null;
}

function getSelectableCharacters() {
  const adapter = getActiveSystemAdapter();
  const assigned = getAssignedCharacter();
  const selected = [];
  const seen = new Set();

  const addActor = (actor) => {
    if (!actor || actor.documentName !== "Actor") return;
    if (isQuartermasterStorageActor(actor)) return;
    if (!game.user.isGM && !actorOwnedBy(actor, game.user)) return;
    try {
      if (typeof adapter?.isCompatibleActor === "function"
          && !adapter.isCompatibleActor(actor, { role: "recipient" })) return;
    } catch {
      return;
    }
    const key = actor.uuid ?? `Actor.${actor.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(actor);
  };

  // Assigned Actor is the preferred/default choice when it is eligible.
  addActor(assigned);

  for (const actor of game.actors ?? []) addActor(actor);
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    addActor(token.actor);
  }

  const preferredUuid = assigned?.uuid;
  return selected.sort((a, b) => {
    if (a.uuid === preferredUuid) return -1;
    if (b.uuid === preferredUuid) return 1;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

async function promptCharacterTarget(itemName) {
  const characters = getSelectableCharacters();
  if (characters.length === 0) {
    ui.notifications.warn(`${MODULE_TITLE}: no compatible owned actors are available.`);
    return null;
  }

  const byUuid = new Map(characters.map(actor => [actor.uuid ?? `Actor.${actor.id}`, actor]));
  const options = characters
    .map((actor, index) => {
      const uuid = actor.uuid ?? `Actor.${actor.id}`;
      const tokenSuffix = actor.isToken ? " (Token)" : "";
      return `<option value="${escapeHtml(uuid)}"${index === 0 ? " selected" : ""}>${escapeHtml(actor.name)}${tokenSuffix}</option>`;
    })
    .join("");
  const content = `
    <form class="qm-pref-form" autocomplete="off">
      <div class="qm-pref-row">
        <label>Actor</label>
        <select name="targetCharacter" class="qm-pref-select">
          ${options}
        </select>
      </div>
      <p class="hint">Add <strong>${escapeHtml(itemName)}</strong> to the selected actor.</p>
    </form>
  `;

  const { DialogV2 } = foundry.applications.api;
  return new Promise((resolve) => {
    let resolved = false;
    let closeHookId = null;
    let selectedActorUuid = null;

    const finish = (actorUuid) => {
      if (resolved) return;
      resolved = true;
      if (closeHookId !== null) {
        try { Hooks.off("closeDialogV2", closeHookId); } catch {}
      }
      resolve(actorUuid ? byUuid.get(actorUuid) ?? null : null);
    };

    const dialog = new DialogV2({
      window: { title: "Add to Actor", icon: "fa-solid fa-user-plus" },
      content,
      rejectClose: false,
      modal: true,
      buttons: [
        {
          action: "add",
          label: "Add",
          icon: "fa-solid fa-check",
          default: true,
          callback: (event, btn, dlg) => {
            const root = dlg.element ?? dlg;
            selectedActorUuid = root.querySelector("[name='targetCharacter']")?.value ?? null;
          }
        },
        {
          action: "cancel",
          label: "Cancel",
          icon: "fa-solid fa-xmark",
          callback: () => { selectedActorUuid = null; }
        }
      ]
    });

    closeHookId = Hooks.on("closeDialogV2", (closedApp) => {
      if (closedApp !== dialog) return;
      finish(selectedActorUuid);
    });

    dialog.render({ force: true });
  });
}

async function handleAddToCharacter(itemId, app) {
  const actor = getBackingActor();
  const item = actor?.items.get(itemId);
  const itemName = item?.name ?? "this item";
  const choices = getSelectableCharacters();
  const character = choices.length === 1
    ? choices[0]
    : await promptCharacterTarget(itemName);
  if (!character) {
    return;
  }

  const canOwn = actorOwnedBy(character, game.user);
  if (!canOwn) {
    ui.notifications.warn(`${MODULE_TITLE}: you do not own ${character.name}.`);
    return;
  }

  const result = await transferInventoryItemToActor(itemId, character);
  if (result?.status === "success") app?.render();
}

async function handleHideItem(itemId, app) {
  if (!isActiveStorageGM()) return;
  const actor = getBackingActor();
  if (!actor) {
    ui.notifications.error(`${MODULE_TITLE}: no backing actor.`);
    return;
  }
  const item = actor.items.get(itemId);
  if (!item) {
    ui.notifications.warn(`${MODULE_TITLE}: item no longer exists.`);
    app?.render();
    return;
  }

  const staged = await setItemHidden(itemId, true);
  if (!staged) {
    ui.notifications.error(`${MODULE_TITLE}: failed to move item to private staging.`);
    return;
  }
  await writeEntry({
    type: "hidden.staged",
    requestId: `qm-rehide-${itemId}-${Date.now()}`,
    userId: game.user.id,
    itemId: staged.id,
    itemName: item.name,
    backingActorId: actor.id,
    visibility: "gm"
  });
  // setItemHidden fires updateItem → inventory popup auto-refreshes via existing hook
  // and loot-prep auto-refreshes via its updateItem hook
  ui.notifications.info(`"${item.name}" moved to hidden loot pool.`);
}

async function handleDeleteItem(itemId, itemName, app) {
  if (!isActiveStorageGM()) return;
  const actor = getBackingActor();
  if (!actor) {
    ui.notifications.error(`${MODULE_TITLE}: no backing actor.`);
    return;
  }
  const item = actor.items.get(itemId);
  if (!item) {
    ui.notifications.warn(`${MODULE_TITLE}: item no longer exists.`);
    app?.render();
    return;
  }

  const { DialogV2 } = foundry.applications.api;
  const confirmed = await DialogV2.confirm({
    window: { title: "Delete Item" },
    content: `<p>Permanently delete <strong>${escapeHtml(item.name)}</strong> from the vault?</p>
              <p>This cannot be undone.</p>`,
    rejectClose: false,
    modal: true
  });
  if (!confirmed) return;

  try {
    await withItemMutationLock(async () => {
      requireActiveStorageGM();
      if (!actor.items.get(itemId)) throw new Error("item-no-longer-in-vault");
      await actor.deleteEmbeddedDocuments("Item", [itemId]);
      if (actor.items.get(itemId)) throw new Error("delete-did-not-remove-item");
    });

    await writeEntry({
      type: "hidden.deleted",
      requestId: `qm-inv-delete-${itemId}-${Date.now()}`,
      userId: game.user.id,
      itemId,
      itemName: item.name,
      backingActorId: actor.id
    });

    ui.notifications.info(`"${item.name}" deleted from the vault.`);
    // inventory popup auto-refreshes via deleteItem hook
  } catch (err) {
    console.error(`${MODULE_TITLE} | delete item error`, err);
    ui.notifications.error(`${MODULE_TITLE}: delete failed — ${err.message}`);
  }
}
