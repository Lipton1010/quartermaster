/**
 * Quartermaster — Backing Actor Lifecycle
 *
 * The Shared Party Inventory is backed by a single hidden Actor that stores
 * all items, currencies, and custom resources for the party. This module
 * handles:
 *
 *   - Auto-creation on first world load (GM only)
 *   - Recovery by flag marker (survives ID drift across world export/import)
 *   - Suppression from the Actors directory render
 *   - Prevention of accidental deletion via the preDeleteActor hook
 *   - Migration framework integration (baseline no-op for v0.1.0)
 *
 * The actor is configured at creation with OBSERVER as default ownership
 * (players can read, cannot write) and OWNER overrides for each GM user.
 * Write operations are routed through the operation coordinator implemented
 * in build step 3; this module is concerned only with the actor's existence
 * and lifecycle.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS, SETTINGS } from "./constants.js";

const BACKING_ACTOR_NAME = "Quartermaster Vault";
const BACKING_ACTOR_IMG = "icons/containers/bags/sack-leather-tan.webp";
const DATA_VERSION_FLAG = "dataVersion";

/**
 * Return the backing actor, or null if not yet created or not found.
 *
 * Tries the stored settings ID first (fast path), then falls back to a
 * flag-based search across game.actors (handles ID drift after world
 * import/export, or recovery from a corrupted setting).
 *
 * Safe to call from any user context (GM or player) and at any lifecycle
 * point after `ready`.
 *
 * @returns {Actor|null}
 */
export function getBackingActor() {
  const storedId = game.settings.get(MODULE_ID, SETTINGS.BACKING_ACTOR_ID);
  if (storedId) {
    const actor = game.actors.get(storedId);
    if (actor && actor.getFlag(MODULE_ID, FLAGS.BACKING_ACTOR_MARKER)) {
      return actor;
    }
  }
  return findBackingActorByFlag();
}

/**
 * Search game.actors for any actor carrying the backing-actor marker flag.
 * Used during recovery when the stored ID does not point to a valid actor.
 *
 * @returns {Actor|null}
 */
function findBackingActorByFlag() {
  return game.actors.find(a => a.getFlag(MODULE_ID, FLAGS.BACKING_ACTOR_MARKER)) ?? null;
}

/**
 * Ensure the backing actor exists. GM-only operation; players see a no-op
 * and should consume the actor read-only via getBackingActor().
 *
 * Called from the `ready` hook in module.js. Order of operations:
 *   1. Try to find an existing backing actor by flag marker (recovery path)
 *   2. If found: reconcile stored ID, run migrations, return
 *   3. If not found: create new actor, persist its ID, return
 *
 * @returns {Promise<Actor|null>}
 */
export async function ensureBackingActor() {
  if (!game.user.isGM) {
    return getBackingActor();
  }

  let actor = findBackingActorByFlag();

  if (actor) {
    // Reconcile stored ID with the discovered actor (handles ID drift)
    const storedId = game.settings.get(MODULE_ID, SETTINGS.BACKING_ACTOR_ID);
    if (storedId !== actor.id) {
      console.log(
        `${MODULE_TITLE} | Backing actor ID drift detected; ` +
        `updating stored ID from "${storedId}" to "${actor.id}"`
      );
      await game.settings.set(MODULE_ID, SETTINGS.BACKING_ACTOR_ID, actor.id);
    }

    console.log(`${MODULE_TITLE} | Backing actor present: ${actor.name} (${actor.id})`);
    await runMigrations(actor);
    return actor;
  }

  actor = await createBackingActor();
  await game.settings.set(MODULE_ID, SETTINGS.BACKING_ACTOR_ID, actor.id);
  console.log(`${MODULE_TITLE} | Backing actor created: ${actor.name} (${actor.id})`);
  return actor;
}

/**
 * Create the backing actor with proper ownership configuration and initial
 * flag state.
 *
 * Ownership model:
 *   - default:  OBSERVER (level 2) — players can read, cannot write
 *   - each GM:  OWNER (level 3)    — explicit override for every current GM
 *
 * GM-role users have inherent full access to all actors regardless of
 * ownership, so the per-GM OWNER overrides are belt-and-suspenders. They
 * also make the permission model self-documenting in the actor sheet's
 * ownership pane.
 *
 * @returns {Promise<Actor>}
 */
async function createBackingActor() {
  const ownership = {
    default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER
  };

  for (const user of game.users) {
    if (user.isGM) {
      ownership[user.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    }
  }

  const moduleVersion = game.modules.get(MODULE_ID)?.version ?? "0.0.0";

  const data = {
    name: BACKING_ACTOR_NAME,
    type: "npc",
    img: BACKING_ACTOR_IMG,
    ownership: ownership,
    flags: {
      [MODULE_ID]: {
        [FLAGS.BACKING_ACTOR_MARKER]: true,
        [DATA_VERSION_FLAG]: moduleVersion,
        [FLAGS.CUSTOM_RESOURCES]: [],
        [FLAGS.TRANSACTION_LOG]: [],
        cachedWeight: { value: 0, dirtyAt: 0 }
      }
    }
  };

  const cls = getDocumentClass("Actor");
  return await cls.create(data);
}

/**
 * Run data migrations between schema versions, if needed.
 *
 * Reads the actor's stored data version flag and compares against the
 * current module version. Applies migration functions in order for any
 * intermediate versions.
 *
 * For v0.1.0 this is a baseline no-op stub — no migrations are defined
 * yet. The structure is in place so future versions can append entries
 * without retrofitting.
 *
 * @param {Actor} actor
 */
async function runMigrations(actor) {
  const currentDataVersion = actor.getFlag(MODULE_ID, DATA_VERSION_FLAG) ?? "0.0.0";
  const targetVersion = game.modules.get(MODULE_ID)?.version ?? "0.0.0";

  if (currentDataVersion === targetVersion) return;

  console.log(
    `${MODULE_TITLE} | Data version ${currentDataVersion} -> ${targetVersion} ` +
    `(no migrations defined for v0.1.0; flag will be updated)`
  );

  // Future migrations are appended here as version-gated blocks, e.g.:
  //
  //   if (foundry.utils.isNewerVersion("0.2.0", currentDataVersion)) {
  //     await migrateTo_0_2_0(actor);
  //   }

  await actor.setFlag(MODULE_ID, DATA_VERSION_FLAG, targetVersion);
}

/**
 * Hook: renderActorDirectory
 *
 * Suppresses the backing actor's entry from the visible Actors sidebar by
 * removing its DOM element after the directory renders. The actor still
 * exists in game.actors and is accessible via getBackingActor(); it simply
 * does not appear in the UI.
 *
 * Handles both V14 ApplicationV2 directories (raw HTMLElement) and earlier
 * jQuery-wrapped versions defensively.
 *
 * @param {ActorDirectory} app
 * @param {HTMLElement|jQuery} html
 */
export function suppressBackingActorFromDirectory(app, html) {
  const actor = getBackingActor();
  if (!actor) return;

  const rootEl = (html instanceof HTMLElement) ? html
                : (html?.[0] instanceof HTMLElement) ? html[0]
                : null;
  if (!rootEl) return;

  // V14 uses data-entry-id; earlier versions used data-document-id
  const selectors = [
    `[data-entry-id="${actor.id}"]`,
    `[data-document-id="${actor.id}"]`
  ];

  for (const selector of selectors) {
    const elements = rootEl.querySelectorAll(selector);
    for (const el of elements) {
      el.remove();
    }
  }
}

/**
 * Hook: preDeleteActor
 *
 * Aborts any deletion attempt on the backing actor while the module is
 * active. Returns false from the hook to cancel the delete operation in
 * Foundry V13+.
 *
 * A GM who genuinely wants to remove the backing actor must disable the
 * module first, then delete the actor manually.
 *
 * @param {Actor} actor
 * @param {object} options
 * @param {string} userId
 * @returns {false|undefined} false to abort the deletion, undefined to allow
 */
export function preventBackingActorDeletion(actor, options, userId) {
  if (!actor.getFlag(MODULE_ID, FLAGS.BACKING_ACTOR_MARKER)) {
    return; // not our actor; allow deletion to proceed normally
  }

  ui.notifications.warn(
    `The ${MODULE_TITLE} backing actor cannot be deleted while the module is active. ` +
    `Disable the module first if you intend to remove it.`
  );

  console.log(
    `${MODULE_TITLE} | Blocked deletion of backing actor "${actor.name}" ` +
    `(${actor.id}) attempted by user ${userId}`
  );

  return false;
}
