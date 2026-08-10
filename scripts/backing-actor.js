/**
 * Quartermaster — Storage Actor Lifecycle
 *
 * Quartermaster uses two actors with deliberately different ownership:
 *
 *   - Quartermaster Vault: player-readable shared inventory (OBSERVER)
 *   - Quartermaster Staging: GM-only private loot and audit data (NONE)
 *
 * The original getBackingActor()/ensureBackingActor() facade remains intact.
 * Calling ensureBackingActor() as a GM now ensures the complete storage pair
 * and runs the restartable storage migration before returning the shared vault.
 */

import {
  MODULE_ID,
  MODULE_TITLE,
  FLAGS,
  SETTINGS,
  STORAGE_SCHEMA_VERSION
} from "./constants.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";
import { migrateStorageSchema } from "./storage-migration.js";
import { isActiveStorageGM, requireActiveStorageGM } from "./storage-ledger.js";

const BACKING_ACTOR_NAME = "Quartermaster Vault";
const BACKING_ACTOR_IMG = "icons/containers/bags/sack-leather-tan.webp";
const STAGING_ACTOR_NAME = "Quartermaster Staging";
const STAGING_ACTOR_IMG = "icons/containers/chest/chest-reinforced-steel-brown.webp";
const DATA_VERSION_FLAG = "dataVersion";

let ensureStoragePromise = null;
let storagePrivacyHooksRegistered = false;

/** Return the shared, player-readable vault actor, or null. */
export function getBackingActor() {
  return getStorageActor(SETTINGS.BACKING_ACTOR_ID, FLAGS.BACKING_ACTOR_MARKER);
}

/** Return the GM-only staging actor, or null when inaccessible/not created. */
export function getStagingActor() {
  return getStorageActor(SETTINGS.STAGING_ACTOR_ID, FLAGS.STAGING_ACTOR_MARKER);
}

function getStorageActor(settingKey, markerFlag) {
  const storedId = safeGetSetting(settingKey);
  if (storedId) {
    const actor = game.actors?.get?.(storedId);
    if (actor?.getFlag?.(MODULE_ID, markerFlag)) return actor;
  }
  return findStorageActorByFlag(markerFlag);
}

function findStorageActorByFlag(markerFlag) {
  return game.actors?.find?.(actor => actor.getFlag?.(MODULE_ID, markerFlag)) ?? null;
}

/**
 * Ensure both storage actors exist and schema migration has completed.
 * Concurrent calls in one client share a single promise.
 *
 * @returns {Promise<{backingActor: Actor|null, stagingActor: Actor|null, migrated: boolean}>}
 */
export async function ensureStorageActors() {
  if (!isActiveStorageGM()) {
    return {
      backingActor: getBackingActor(),
      stagingActor: getStagingActor(),
      migrated: false
    };
  }

  if (ensureStoragePromise) return ensureStoragePromise;
  ensureStoragePromise = ensureStorageActorsInternal();
  try {
    return await ensureStoragePromise;
  } finally {
    ensureStoragePromise = null;
  }
}

/** Preserve the original public facade while ensuring the storage pair. */
export async function ensureBackingActor() {
  if (!isActiveStorageGM()) return getBackingActor();
  const storage = await ensureStorageActors();
  return storage.backingActor;
}

/** Ensure storage and return only the private staging actor. */
export async function ensureStagingActor() {
  if (!isActiveStorageGM()) return getStagingActor();
  const storage = await ensureStorageActors();
  return storage.stagingActor;
}

async function ensureStorageActorsInternal() {
  requireActiveStorageGM();
  let backingActor = findStorageActorByFlag(FLAGS.BACKING_ACTOR_MARKER);
  let stagingActor = findStorageActorByFlag(FLAGS.STAGING_ACTOR_MARKER);

  const systemMismatch = [backingActor, stagingActor]
    .filter(Boolean)
    .find(actor => !isStorageSystemCompatible(actor));
  if (systemMismatch) {
    warnSystemConversion(systemMismatch);
    return { backingActor: null, stagingActor: null, migrated: false };
  }

  const existing = backingActor ?? stagingActor;
  if (existing && !isStorageActorCompatible(existing)) {
    warnIncompatibleStorage(existing);
    return { backingActor: null, stagingActor: null, migrated: false };
  }

  const actorType = existing?.type ?? await resolveVaultActorType();
  if (!actorType) {
    const message = `${MODULE_TITLE}: storage was not created because no Actor type was confirmed.`;
    console.warn(`${MODULE_TITLE} | ${message}`);
    ui.notifications?.warn?.(message);
    return { backingActor: null, stagingActor: null, migrated: false };
  }

  if (!backingActor) {
    requireActiveStorageGM();
    backingActor = await createStorageActor({ purpose: "shared", type: actorType });
    console.log(`${MODULE_TITLE} | Backing actor created: ${backingActor.name} (${backingActor.id})`);
  } else {
    console.log(`${MODULE_TITLE} | Backing actor present: ${backingActor.name} (${backingActor.id})`);
  }
  await reconcileStoredId(SETTINGS.BACKING_ACTOR_ID, backingActor);

  if (!stagingActor) {
    requireActiveStorageGM();
    stagingActor = await createStorageActor({ purpose: "staging", type: actorType });
    console.log(`${MODULE_TITLE} | Staging actor created: ${stagingActor.name} (${stagingActor.id})`);
  } else {
    console.log(`${MODULE_TITLE} | Staging actor present: ${stagingActor.name} (${stagingActor.id})`);
  }
  await reconcileStoredId(SETTINGS.STAGING_ACTOR_ID, stagingActor);

  // Some systems override Actor ownership defaults during creation (PF2e
  // loot Actors are one example). Reassert the privacy boundary before any
  // private document is copied into staging, and on every later startup.
  await reconcileStorageOwnership(backingActor, "shared");
  await reconcileStorageOwnership(stagingActor, "staging");

  if (!isStorageActorCompatible(backingActor) || !isStorageActorCompatible(stagingActor)) {
    warnIncompatibleStorage(!isStorageActorCompatible(backingActor) ? backingActor : stagingActor);
    return { backingActor: null, stagingActor: null, migrated: false };
  }

  const result = await migrateStorageSchema(backingActor, stagingActor);
  requireActiveStorageGM();
  await persistStorageSystemId(backingActor);
  await persistStorageSystemId(stagingActor);
  await updateModuleDataVersion(backingActor);
  await updateModuleDataVersion(stagingActor);
  return { backingActor, stagingActor, migrated: result.migrated };
}

/** Return false only when a storage Actor is explicitly bound to another system. */
export function isStorageSystemCompatible(actor, systemId = globalThis.game?.system?.id) {
  const storedSystemId = actor?.getFlag?.(MODULE_ID, FLAGS.STORAGE_SYSTEM_ID);
  return !storedSystemId || storedSystemId === systemId;
}

async function reconcileStoredId(settingKey, actor) {
  requireActiveStorageGM();
  const storedId = safeGetSetting(settingKey);
  if (storedId === actor.id) return;
  console.log(
    `${MODULE_TITLE} | Storage actor ID drift detected; ` +
    `updating ${settingKey} from "${storedId ?? ""}" to "${actor.id}"`
  );
  await safeSetSetting(settingKey, actor.id);
}

async function createStorageActor({ purpose, type }) {
  requireActiveStorageGM();
  const cls = getDocumentClass("Actor");
  return cls.create(buildStorageActorData({ purpose, type }));
}

/** Pure storage document data builder used by setup diagnostics and tests. */
export function buildStorageActorData({
  purpose,
  type,
  users = globalThis.game?.users ?? [],
  moduleVersion = globalThis.game?.modules?.get?.(MODULE_ID)?.version ?? "0.0.0"
}) {
  const isShared = purpose === "shared";
  const levels = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS ?? {
    NONE: 0,
    OBSERVER: 2,
    OWNER: 3
  };
  const ownership = buildStorageOwnership({ purpose, users, levels });

  const moduleFlags = {
    [DATA_VERSION_FLAG]: moduleVersion,
    [FLAGS.STORAGE_SYSTEM_ID]: globalThis.game?.system?.id ?? null,
    [FLAGS.STORAGE_SCHEMA_VERSION]: isShared ? 0 : STORAGE_SCHEMA_VERSION,
    cachedWeight: { value: 0, dirtyAt: 0 }
  };

  if (isShared) {
    moduleFlags[FLAGS.BACKING_ACTOR_MARKER] = true;
    moduleFlags[FLAGS.CUSTOM_RESOURCES] = [];
    moduleFlags[FLAGS.TRANSACTION_LOG] = [];
  } else {
    moduleFlags[FLAGS.STAGING_ACTOR_MARKER] = true;
    moduleFlags[FLAGS.HIDDEN_CURRENCY] = [];
    moduleFlags[FLAGS.LOOT_PREP_FOLDERS] = [];
    moduleFlags[FLAGS.MIGRATED_ITEM_METADATA] = [];
    moduleFlags[FLAGS.TRANSACTION_LOG] = [];
    moduleFlags[FLAGS.RECOVERY_RECORDS] = [];
    moduleFlags[FLAGS.OPERATION_TOMBSTONES] = [];
  }

  return {
    name: isShared ? BACKING_ACTOR_NAME : STAGING_ACTOR_NAME,
    type,
    img: isShared ? BACKING_ACTOR_IMG : STAGING_ACTOR_IMG,
    ownership,
    flags: { [MODULE_ID]: moduleFlags }
  };
}

/** Pure ownership builder shared by creation, reconciliation, and tests. */
export function buildStorageOwnership({
  purpose,
  users = globalThis.game?.users ?? [],
  levels = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS ?? {
    NONE: 0,
    OBSERVER: 2,
    OWNER: 3
  }
}) {
  const isShared = purpose === "shared";
  const ownership = { default: isShared ? levels.OBSERVER : levels.NONE };
  for (const user of users) {
    ownership[user.id] = user.isGM
      ? levels.OWNER
      : isShared ? levels.OBSERVER : levels.NONE;
  }
  return ownership;
}

async function reconcileStorageOwnership(actor, purpose) {
  requireActiveStorageGM();
  if (!actor) throw new Error(`${purpose}-storage-actor-required`);
  const expected = buildStorageOwnership({ purpose });
  const current = actor.ownership ?? {};
  const changes = {};
  for (const [key, value] of Object.entries(expected)) {
    if (Number(current[key]) !== Number(value)) changes[`ownership.${key}`] = value;
  }
  if (Object.keys(changes).length > 0) await actor.update(changes);

  // Verify from the live document after the write. Private staging must fail
  // closed instead of relying on UI hiding when a system rejects ownership.
  for (const [key, value] of Object.entries(expected)) {
    if (Number(actor.ownership?.[key]) !== Number(value)) {
      throw new Error(`${purpose}-storage-ownership-verification-failed-${key}`);
    }
  }
}

async function persistStorageSystemId(actor) {
  requireActiveStorageGM();
  const systemId = game.system?.id;
  if (!systemId) throw new Error("active-system-id-unavailable");
  if (actor.getFlag(MODULE_ID, FLAGS.STORAGE_SYSTEM_ID) === systemId) return;
  await actor.setFlag(MODULE_ID, FLAGS.STORAGE_SYSTEM_ID, systemId);
}

async function updateModuleDataVersion(actor) {
  requireActiveStorageGM();
  const targetVersion = game.modules.get(MODULE_ID)?.version ?? "0.0.0";
  if (actor.getFlag(MODULE_ID, DATA_VERSION_FLAG) === targetVersion) return;
  await actor.setFlag(MODULE_ID, DATA_VERSION_FLAG, targetVersion);
}

function availableActorTypes() {
  const candidates = [
    CONFIG.Actor?.dataModels,
    CONFIG.Actor?.typeLabels,
    game.system?.model?.Actor
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const types = Object.keys(candidate);
      if (types.length > 0) return types;
    }
  }
  return [];
}

async function resolveVaultActorType() {
  const types = availableActorTypes();
  const stored = safeGetSetting(SETTINGS.VAULT_ACTOR_TYPE);
  const adapter = getActiveSystemAdapter?.();
  const recommended = adapter?.getRecommendedVaultActorType?.(types)
    ?? adapter?.getVaultActorType?.({ purpose: "shared", actorTypes: types })
    ?? adapter?.vaultActorType;
  const systemId = game.system?.id ?? "";
  const hasSystemAdapter = adapter?.systemId === systemId;
  if (stored && types.includes(stored) && (!hasSystemAdapter || stored === recommended)) return stored;
  const validRecommendation = types.includes(recommended)
    ? recommended
    : hasSystemAdapter ? null : types[0] ?? null;

  if (!validRecommendation) return null;
  if (hasSystemAdapter || types.length === 1) {
    await safeSetSetting(SETTINGS.VAULT_ACTOR_TYPE, validRecommendation);
    return validRecommendation;
  }

  const selected = await promptForVaultActorType(types, validRecommendation);
  if (!selected) return null;
  await safeSetSetting(SETTINGS.VAULT_ACTOR_TYPE, selected);
  return selected;
}

async function promptForVaultActorType(types, recommended) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) {
    console.warn(`${MODULE_TITLE} | DialogV2 unavailable; cannot confirm generic vault Actor type`);
    return null;
  }

  const options = types.map(type => {
    const selected = type === recommended ? " selected" : "";
    return `<option value="${escapeHtml(type)}"${selected}>${escapeHtml(type)}</option>`;
  }).join("");
  const content = `
    <form class="quartermaster">
      <p><strong>${escapeHtml(game.system?.title ?? game.system?.id ?? "This system")}</strong>
      does not have a built-in Quartermaster adapter.</p>
      <p>Choose the Actor type Quartermaster should use for its private and shared storage.</p>
      <div class="form-group"><label>Storage Actor type</label>
        <select name="actorType">${options}</select>
      </div>
      <p class="hint">Quartermaster will preserve system data, but unsupported fields remain hidden.</p>
    </form>`;

  return new Promise(resolve => {
    let value = null;
    let done = false;
    let closeHookId = null;
    const finish = result => {
      if (done) return;
      done = true;
      if (closeHookId !== null) Hooks.off("closeDialogV2", closeHookId);
      resolve(result);
    };
    const dialog = new DialogV2({
      window: { title: `${MODULE_TITLE}: Confirm Storage Type`, icon: "fa-solid fa-box-archive" },
      content,
      rejectClose: false,
      buttons: [
        {
          action: "confirm",
          label: "Create Storage",
          icon: "fa-solid fa-check",
          default: true,
          callback: (event, button, dlg) => {
            const selected = dlg.element?.querySelector?.("[name='actorType']")?.value;
            value = types.includes(selected) ? selected : null;
          }
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", callback: () => { value = null; } }
      ]
    });
    closeHookId = Hooks.on("closeDialogV2", closed => {
      if (closed === dialog) finish(value);
    });
    dialog.render({ force: true });
  });
}

function isStorageActorCompatible(actor) {
  if (!actor) return false;
  const adapter = getActiveSystemAdapter?.();
  if (typeof adapter?.isCompatibleActor === "function") {
    try {
      return adapter.isCompatibleActor(actor, { role: "vault" });
    } catch (error) {
      console.warn(`${MODULE_TITLE} | Adapter compatibility check failed`, error);
      return false;
    }
  }
  return availableActorTypes().includes(actor.type);
}

function warnIncompatibleStorage(actor) {
  const message = `${MODULE_TITLE}: existing storage Actor "${actor?.name ?? "unknown"}" uses type ` +
    `"${actor?.type ?? "unknown"}", which is incompatible with ${game.system?.title ?? game.system?.id}. ` +
    "No documents were converted. A GM must resolve the storage type before continuing.";
  console.error(`${MODULE_TITLE} | ${message}`);
  ui.notifications?.error?.(message, { permanent: true });
}

function warnSystemConversion(actor) {
  const storedSystemId = actor?.getFlag?.(MODULE_ID, FLAGS.STORAGE_SYSTEM_ID) ?? "unknown";
  const currentSystemId = game.system?.id ?? "unknown";
  const message = `${MODULE_TITLE}: storage belongs to system "${storedSystemId}" but this world is `
    + `running "${currentSystemId}". Automatic world-system conversion is not supported; no storage `
    + "documents were changed.";
  console.error(`${MODULE_TITLE} | ${message}`);
  ui.notifications?.error?.(message, { permanent: true });
}

function safeGetSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return null;
  }
}

async function safeSetSetting(key, value) {
  try {
    await game.settings.set(MODULE_ID, key, value);
    return true;
  } catch (error) {
    console.error(`${MODULE_TITLE} | Unable to persist setting ${key}`, error);
    throw error;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getRenderedElement(html) {
  if (typeof html?.querySelectorAll === "function") return html;
  if (typeof html?.[0]?.querySelectorAll === "function") return html[0];
  return null;
}

function getStorageActors() {
  return [getBackingActor(), getStagingActor()].filter(Boolean);
}

/** Hide both Quartermaster storage documents from the Actors directory. */
export function suppressBackingActorFromDirectory(app, html) {
  const rootEl = getRenderedElement(html);
  if (!rootEl) return;
  for (const actor of getStorageActors()) {
    for (const selector of [
      `[data-entry-id="${actor.id}"]`,
      `[data-document-id="${actor.id}"]`
    ]) {
      for (const element of rootEl.querySelectorAll(selector)) element.remove();
    }
  }
}

/** Hide storage documents from the Player Character selector. */
export function suppressBackingActorFromUserConfig(app, html) {
  const rootEl = getRenderedElement(html);
  if (!rootEl) return;
  for (const actor of getStorageActors()) {
    const optionGroups = new Set();
    for (const selector of [
      `select[name="character"] option[value="${actor.id}"]`,
      `select[name="character"] option[value="${actor.uuid}"]`
    ]) {
      for (const option of rootEl.querySelectorAll(selector)) {
        const group = option.closest("optgroup");
        option.remove();
        if (group) optionGroups.add(group);
      }
    }
    for (const group of optionGroups) {
      if (!group.querySelector("option")) group.remove();
    }
  }
}

/**
 * Install selector privacy independently of the mutation runtime.
 *
 * UserConfig can render before Foundry's `ready` hook. These guards therefore
 * must not wait for storage migration, sockets, or the rest of Quartermaster's
 * runtime to activate.
 */
export function registerStoragePrivacyHooks() {
  if (storagePrivacyHooksRegistered) return;
  storagePrivacyHooksRegistered = true;
  Hooks.on("renderUserConfig", suppressBackingActorFromUserConfig);
  Hooks.on("preUpdateUser", preventBackingActorCharacterAssignment);
  // Storage boundaries are safety/privacy invariants, not optional runtime UI.
  // Register them before `ready` so a deferred player client or non-active GM
  // cannot see/delete storage Actors or mutate their embedded Items while the
  // adapter/migration runtime is still unavailable.
  Hooks.on("renderActorDirectory", suppressBackingActorFromDirectory);
  Hooks.on("preDeleteActor", preventBackingActorDeletion);
  Hooks.on("preCreateItem", preventInactiveGmStorageItemMutation);
  Hooks.on("preUpdateItem", preventInactiveGmStorageItemMutation);
  Hooks.on("preDeleteItem", preventInactiveGmStorageItemMutation);
}

/** Remove storage choices from any UserConfig which rendered before `ready`. */
export function suppressBackingActorFromOpenUserConfigs(root = globalThis.document) {
  if (typeof root?.querySelectorAll !== "function") return;
  suppressBackingActorFromUserConfig(null, root);
}

/** Prevent either storage actor being assigned as a user's character. */
export function preventBackingActorCharacterAssignment(user, changes) {
  const selected = changes.character;
  const selectedId = typeof selected === "string"
    ? selected
    : selected?.id ?? selected?.uuid;
  const actor = getStorageActors().find(candidate =>
    selectedId === candidate.id || selectedId === candidate.uuid
  );
  if (!actor) return;

  // Mutate the pending payload as a secondary safeguard, then cancel the
  // document update. Returning false is Foundry's fail-closed pre-update path.
  changes.character = null;
  ui.notifications?.warn?.(`${MODULE_TITLE}: storage actors cannot be selected as player characters.`);
  return false;
}

/** Prevent deletion of either storage actor while the module is active. */
export function preventBackingActorDeletion(actor, options, userId) {
  const isStorage = actor.getFlag?.(MODULE_ID, FLAGS.BACKING_ACTOR_MARKER)
    || actor.getFlag?.(MODULE_ID, FLAGS.STAGING_ACTOR_MARKER);
  if (!isStorage) return;

  ui.notifications?.warn?.(
    `${MODULE_TITLE} storage cannot be deleted while the module is active. ` +
    "Disable the module first if you intend to remove it."
  );
  console.log(
    `${MODULE_TITLE} | Blocked deletion of storage actor "${actor.name}" ` +
    `(${actor.id}) attempted by user ${userId}`
  );
  return false;
}

/**
 * Final document-boundary guard for storage Item mutations.
 *
 * Runtime hooks remain registered when a GM loses Foundry's active-GM
 * election. This pre-hook therefore protects writes whose UI callback began
 * while active but resumed after an awaited dialog, UUID lookup, or sheet
 * operation. Player reads/renders and non-storage Items are unaffected.
 */
export function preventInactiveGmStorageItemMutation(item, changes, options, userId) {
  if (!game.user?.isGM || isActiveStorageGM()) return;
  // Foundry's preCreate/preUpdate hooks pass userId fourth; preDelete passes it
  // third. Never let an inactive observer cancel the active GM's remote write.
  const initiatingUserId = [userId, options, changes]
    .find(value => typeof value === "string" && value);
  if (initiatingUserId && initiatingUserId !== game.user.id) return;
  const actor = item?.parent;
  if (!actor) return;
  const isStorage = actor.getFlag?.(MODULE_ID, FLAGS.BACKING_ACTOR_MARKER)
    || actor.getFlag?.(MODULE_ID, FLAGS.STAGING_ACTOR_MARKER);
  if (!isStorage) return;

  console.warn(
    `${MODULE_TITLE} | Blocked storage Item mutation from a non-active GM`,
    { itemId: item.id ?? null, actorId: actor.id ?? null }
  );
  return false;
}
