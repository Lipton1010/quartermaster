/**
 * Quartermaster - Inventory Token Shortcut
 *
 * Optional scene token that opens the Shared Party Inventory when double-clicked.
 */

import { MODULE_ID, MODULE_TITLE, FLAGS, SETTINGS } from "./constants.js";
import { getBackingActor } from "./backing-actor.js";
import { openInventoryApp } from "./apps/inventory-app.js";
import { getInventoryButtonLabel } from "./inventory-rendering.js";

const DEFAULT_TOKEN_IMAGE = "icons/containers/chest/chest-reinforced-brown.webp";
const PATCHED_KEY = Symbol.for("quartermaster.inventoryTokenShortcutPatched");
const ORIGINAL_LEFT_DOUBLE_CLICK_KEY = Symbol.for("quartermaster.inventoryTokenShortcutOriginalLeftDoubleClick");

export function registerInventoryTokenShortcutHooks() {
  const TokenClass = foundry?.canvas?.placeables?.Token ?? globalThis.Token;
  const prototype = TokenClass?.prototype;
  if (!prototype || prototype[PATCHED_KEY]) return;

  const original = prototype._onClickLeft2;
  if (typeof original !== "function") {
    console.warn(`${MODULE_TITLE} | Token double-click handler was not found; inventory tokens will not open automatically.`);
    return;
  }

  Object.defineProperty(prototype, ORIGINAL_LEFT_DOUBLE_CLICK_KEY, {
    value: original,
    configurable: true
  });

  prototype._onClickLeft2 = function(event) {
    if (isInventoryTokenShortcut(this)) {
      event?.stopPropagation?.();
      handleInventoryTokenDoubleClick();
      return;
    }

    return original.call(this, event);
  };

  Object.defineProperty(prototype, PATCHED_KEY, {
    value: true,
    configurable: true
  });
}

export async function createInventoryTokenShortcut() {
  if (!game.user.isGM) return null;

  if (!game.settings.get(MODULE_ID, SETTINGS.ENABLE_INVENTORY_TOKEN)) {
    ui.notifications.warn(`${MODULE_TITLE}: enable the inventory token shortcut setting first.`);
    return null;
  }

  if (!canvas?.ready || !canvas.scene) {
    ui.notifications.warn(`${MODULE_TITLE}: open a scene before placing an inventory token.`);
    return null;
  }

  const actor = getBackingActor();
  if (!actor) {
    ui.notifications.warn(`${MODULE_TITLE}: the backing actor is not ready yet.`);
    return null;
  }

  const placement = getTokenPlacement();
  const tokenData = {
    name: getInventoryTokenName(),
    actorId: actor.id,
    actorLink: true,
    x: placement.x,
    y: placement.y,
    width: 1,
    height: 1,
    rotation: 0,
    hidden: false,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    texture: {
      src: getInventoryTokenImage(actor)
    },
    flags: {
      [MODULE_ID]: {
        [FLAGS.INVENTORY_TOKEN_SHORTCUT]: true
      }
    }
  };

  const [token] = await canvas.scene.createEmbeddedDocuments("Token", [tokenData]);
  ui.notifications.info(`${MODULE_TITLE}: inventory token placed on the scene.`);
  return token;
}

export function isInventoryTokenShortcut(documentOrToken) {
  const document = documentOrToken?.document ?? documentOrToken;
  return Boolean(document?.getFlag?.(MODULE_ID, FLAGS.INVENTORY_TOKEN_SHORTCUT));
}

function handleInventoryTokenDoubleClick() {
  if (!game.settings.get(MODULE_ID, SETTINGS.ENABLE_INVENTORY_TOKEN)) {
    ui.notifications.warn(`${MODULE_TITLE}: the inventory token shortcut is disabled.`);
    return;
  }

  openInventoryApp().catch(err => {
    console.error(`${MODULE_TITLE} | Failed to open inventory from token`, err);
    ui.notifications.error(`${MODULE_TITLE}: could not open the inventory from this token.`);
  });
}

function getInventoryTokenName() {
  const configured = game.settings.get(MODULE_ID, SETTINGS.INVENTORY_TOKEN_NAME);
  return configured?.trim() || getInventoryButtonLabel();
}

function getInventoryTokenImage(actor) {
  const configured = game.settings.get(MODULE_ID, SETTINGS.INVENTORY_TOKEN_IMAGE);
  return configured?.trim()
    || actor.prototypeToken?.texture?.src
    || actor.img
    || DEFAULT_TOKEN_IMAGE;
}

function getTokenPlacement() {
  const dimensions = canvas.scene?.dimensions ?? {};
  const gridSize = getGridSize(dimensions);
  const center = getCurrentViewCenter(dimensions);
  const x = snapToGrid(center.x - gridSize / 2, gridSize);
  const y = snapToGrid(center.y - gridSize / 2, gridSize);

  return {
    x: clamp(x, 0, Math.max(0, (dimensions.width ?? gridSize) - gridSize)),
    y: clamp(y, 0, Math.max(0, (dimensions.height ?? gridSize) - gridSize))
  };
}

function getCurrentViewCenter(dimensions) {
  const pivot = canvas.stage?.pivot;
  const x = Number.isFinite(pivot?.x) ? pivot.x : (dimensions.width ?? 0) / 2;
  const y = Number.isFinite(pivot?.y) ? pivot.y : (dimensions.height ?? 0) / 2;
  return { x, y };
}

function getGridSize(dimensions) {
  const size = canvas.grid?.size ?? dimensions.size ?? 100;
  return Number.isFinite(size) && size > 0 ? size : 100;
}

function snapToGrid(value, gridSize) {
  return Math.round(value / gridSize) * gridSize;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
