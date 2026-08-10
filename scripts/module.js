/**
 * Quartermaster — Entry Point
 *
 * Loaded as an ES module by Foundry on world startup. Registers settings
 * during `init`, ensures the backing actor exists during `ready`, and wires
 * up hook listeners for the Actors directory.
 *
 * Author: Paul Miscavage
 * Repo:   https://github.com/Lipton1010/quartermaster
 */

import {
  MODULE_ID,
  MODULE_TITLE,
  STORAGE_SCHEMA_VERSION,
  SYSTEM_ADAPTER_API_VERSION,
  FLAGS
} from "./constants.js";
import { registerSettings } from "./settings.js";
import {
  ensureStorageActors,
  getBackingActor,
  getStagingActor,
  suppressBackingActorFromDirectory,
  registerStoragePrivacyHooks,
  suppressBackingActorFromOpenUserConfigs,
  preventBackingActorDeletion,
  preventInactiveGmStorageItemMutation
} from "./backing-actor.js";
import { injectSidebarButtons } from "./sidebar.js";
import {
  initializeCoordinator,
  executeOperation,
  diagnostics as coordinatorDiagnostics
} from "./operation-coordinator.js";
import * as TransactionLog from "./transaction-log.js";
import {
  registerSocketHandler,
  submitRequest,
  isActiveGM,
  diagnostics as socketDiagnostics
} from "./socket-handler.js";
import {
  openInventoryApp,
  closeInventoryApp,
  isInventoryAppOpen,
  forceInventoryRefresh,
  scheduleInventoryRefresh,
  registerInventoryRefreshHooks
} from "./apps/inventory-app.js";
import {
  openLootPrepApp,
  closeLootPrepApp,
  isLootPrepAppOpen,
  registerLootPrepRefreshHooks
} from "./apps/loot-prep-app.js";
import {
  openTransactionLogApp,
  closeTransactionLogApp,
  isTransactionLogAppOpen,
  registerLogRefreshHooks
} from "./apps/transaction-log-app.js";
import * as Sanitization from "./sanitization.js";
import * as WeightCache from "./weight-cache.js";
import * as ClaimCommit from "./claim-commit.js";
import { registerEgressInterceptor } from "./drag-drop.js";
import * as TransactionLogQuery from "./transaction-log-query.js";
import * as ApprovalPolicy from "./approval-policy.js";
import * as Resources from "./resources.js";
import * as HiddenItems from "./hidden-items.js";
import * as HiddenCurrency from "./hidden-currency.js";
import * as LootPrepFolders from "./loot-prep-folders.js";
import * as LootPrepNotes from "./loot-prep-notes.js";
import * as ContextMenu from "./context-menu.js";
import { registerCompendiumContextMenu } from "./compendium-menu.js";
import * as InventoryToken from "./inventory-token.js";
import * as Currencies from "./currencies.js";
import { openCurrencyManager, closeCurrencyManager } from "./apps/currency-manager-app.js";
import * as RecoveryRecords from "./recovery-records.js";
import { isActiveStorageGM } from "./storage-ledger.js";
import {
  initializeSystemAdapters,
  registerSystemAdapter,
  registerAdapter,
  getSystemAdapter,
  getActiveSystemAdapter,
  getSystemAdapterDiagnostics,
  normalizeItem as normalizeSystemItem
} from "./system-adapters/registry.js";

// UserConfig may render before Foundry reaches `ready`. Register only the
// selector and assignment privacy guards immediately; mutation hooks still
// wait for verified runtime storage below.
registerStoragePrivacyHooks();

/**
 * Foundry lifecycle: init
 * Fires once during world initialization, before any data is loaded.
 * Used for settings registration and any pre-data hooks.
 */
Hooks.once("init", () => {
  console.log(`${MODULE_TITLE} | Init`);
  installPublicApi({ runtimeReady: false });
  const adapter = initializeSystemAdapters();
  registerSettings(adapter);
});

/**
 * Foundry lifecycle: ready
 * Fires once after all data is loaded and the canvas is drawn.
 * Used for actor/document-dependent setup.
 */
Hooks.once("ready", async () => {
  console.log(`${MODULE_TITLE} | Ready`);

  // Cover a UserConfig which was already open before the Actor collection and
  // storage settings became available to the privacy render hook.
  suppressBackingActorFromOpenUserConfigs();

  if (game.user?.isGM && !isActiveStorageGM()) {
    installPublicApi({ runtimeReady: false });
    deferInactiveGMRuntimeActivation();
    console.warn(
      `${MODULE_TITLE} | This GM is not Foundry's active GM; storage and runtime `
      + "mutation hooks remain disabled until this client is elected"
    );
    return;
  }

  try {
    await prepareRuntimeStorage();
  } catch (error) {
    console.error(`${MODULE_TITLE} | Storage initialization failed safely`, error);
    installPublicApi({ runtimeReady: false });
    if (!game.user?.isGM) {
      deferPlayerRuntimeActivation();
      console.warn(
        `${MODULE_TITLE} | Waiting for the GM to finish storage migration; `
        + "runtime mutation and UI hooks remain disabled"
      );
      return;
    }
    if (!isActiveStorageGM()) {
      deferInactiveGMRuntimeActivation();
      console.warn(
        `${MODULE_TITLE} | Active-GM ownership changed during startup; `
        + "this client will wait without mutating storage"
      );
      return;
    }
    ui.notifications?.error?.(
      `${MODULE_TITLE}: storage setup or migration did not complete. No legacy data was removed; see the console for details.`,
      { permanent: true }
    );
    console.warn(`${MODULE_TITLE} | Runtime mutation and UI hooks remain disabled until storage is ready`);
    return;
  }

  if (!registerRuntimeHooks()) {
    installPublicApi({ runtimeReady: false });
    if (game.user?.isGM) deferInactiveGMRuntimeActivation();
    return;
  }
  registerGmElectionHooks();
  gmRuntimeSuspended = false;
  installPublicApi({ runtimeReady: true });
  logRuntimeLoaded();
});

let runtimeHooksRegistered = false;
let storageReadinessHookId = null;
let runtimeActivationPromise = null;
let gmElectionHookIds = [];
let gmRuntimeSuspended = false;

async function prepareRuntimeStorage() {
  if (game.user?.isGM) {
    if (!isActiveStorageGM()) throw new Error("active-gm-required");
    const storage = await ensureStorageActors();
    if (!hasCurrentStorageSchema(storage.backingActor)
        || !hasCurrentStorageSchema(storage.stagingActor)) {
      throw new Error("storage-schema-not-ready");
    }
    if (!isActiveStorageGM()) throw new Error("active-gm-required");
    await Currencies.ensureCurrencyConfig(storage.backingActor);
    if (!await TransactionLog.refreshPublicProjection()) {
      throw new Error("transaction-log-projection-refresh-failed");
    }
    return storage;
  }

  // Players cannot read the private staging Actor. The shared marker advances
  // last during migration, so its current value is the public readiness proof.
  const backingActor = getBackingActor();
  if (!hasCurrentStorageSchema(backingActor)) throw new Error("storage-schema-not-ready");
  return { backingActor, stagingActor: null, migrated: false };
}

function hasCurrentStorageSchema(actor) {
  return Number(actor?.getFlag?.(MODULE_ID, FLAGS.STORAGE_SCHEMA_VERSION))
    === STORAGE_SCHEMA_VERSION;
}

/**
 * A player can reach ready while the active GM is still migrating storage.
 * Observe only the shared backing Actor and activate after its marker advances;
 * the marker is written last, so no mutation or UI hooks are registered early.
 */
function deferPlayerRuntimeActivation() {
  if (game.user?.isGM || runtimeHooksRegistered || storageReadinessHookId !== null) return;
  storageReadinessHookId = Hooks.on("updateActor", actor => {
    void tryActivateDeferredPlayerRuntime(actor);
  });

  // Close the race where the schema update arrived between the ready check and
  // hook registration.
  void tryActivateDeferredPlayerRuntime();
}

/**
 * A second GM must not race the elected active GM's setup. Listen for Foundry
 * user-presence/election changes and activate only after this exact client is
 * the collection's activeGM.
 */
function deferInactiveGMRuntimeActivation() {
  if (!game.user?.isGM || isActiveStorageGM() || runtimeHooksRegistered) {
    if (isActiveStorageGM()) void tryActivateDeferredGMRuntime();
    return;
  }
  registerGmElectionHooks();
  gmRuntimeSuspended = true;

  // Close the race where the election changed between the ready check and
  // hook registration.
  void tryActivateDeferredGMRuntime();
}

async function tryActivateDeferredGMRuntime() {
  if (!game.user?.isGM || !isActiveStorageGM()) return false;
  if (runtimeActivationPromise) return runtimeActivationPromise;

  runtimeActivationPromise = (async () => {
    try {
      await prepareRuntimeStorage();
      if (!isActiveStorageGM()) return false;
      if (!runtimeHooksRegistered && !registerRuntimeHooks()) return false;
      gmRuntimeSuspended = false;
      installPublicApi({ runtimeReady: true });
      registerGmElectionHooks();
      try {
        ui.actors?.render?.({ force: true });
      } catch { /* directory refresh is best-effort */ }
      logRuntimeLoaded();
      return true;
    } catch (error) {
      console.warn(`${MODULE_TITLE} | Deferred active-GM runtime activation is still waiting`, error);
      return false;
    } finally {
      runtimeActivationPromise = null;
    }
  })();
  return runtimeActivationPromise;
}

async function tryActivateDeferredPlayerRuntime(updatedActor = null) {
  if (game.user?.isGM || runtimeHooksRegistered) return false;
  const backingActor = getBackingActor();
  if (!backingActor || (updatedActor && updatedActor.id !== backingActor.id)) return false;
  if (!hasCurrentStorageSchema(backingActor)) return false;
  if (runtimeActivationPromise) return runtimeActivationPromise;

  runtimeActivationPromise = (async () => {
    try {
      await prepareRuntimeStorage();
      if (!registerRuntimeHooks()) return false;
      installPublicApi({ runtimeReady: true });
      clearPlayerRuntimeActivationHook();
      logRuntimeLoaded();
      return true;
    } catch (error) {
      console.warn(`${MODULE_TITLE} | Deferred runtime activation is still waiting`, error);
      return false;
    } finally {
      runtimeActivationPromise = null;
    }
  })();
  return runtimeActivationPromise;
}

function clearPlayerRuntimeActivationHook() {
  if (storageReadinessHookId === null) return;
  Hooks.off("updateActor", storageReadinessHookId);
  storageReadinessHookId = null;
}

function registerGmElectionHooks() {
  if (!game.user?.isGM || gmElectionHookIds.length > 0) return;
  const onElectionChange = () => {
    if (isActiveStorageGM()) {
      if (gmRuntimeSuspended || !runtimeHooksRegistered) void tryActivateDeferredGMRuntime();
    }
    else suspendInactiveGmRuntime();
  };
  gmElectionHookIds = [
    ["updateUser", Hooks.on("updateUser", onElectionChange)],
    ["userConnected", Hooks.on("userConnected", onElectionChange)]
  ];
}

function suspendInactiveGmRuntime() {
  if (!game.user?.isGM || isActiveStorageGM()) return false;
  if (gmRuntimeSuspended) return true;
  installPublicApi({ runtimeReady: false });
  void closeInventoryApp();
  void closeLootPrepApp();
  void closeTransactionLogApp();
  void closeCurrencyManager();
  try {
    ui.actors?.render?.({ force: true });
  } catch { /* directory refresh is best-effort */ }
  if (!gmRuntimeSuspended) {
    console.warn(
      `${MODULE_TITLE} | This client is no longer the active GM; mutable APIs and `
      + "Quartermaster GM windows are suspended until reelection"
    );
  }
  gmRuntimeSuspended = true;
  return true;
}

function logRuntimeLoaded() {
  console.log(`${MODULE_TITLE} | v${game.modules.get(MODULE_ID)?.version ?? "unknown"} loaded`);
}

function registerRuntimeHooks() {
  if (runtimeHooksRegistered) return true;
  if (game.user?.isGM && !isActiveStorageGM()) return false;
  runtimeHooksRegistered = true;

  initializeCoordinator();
  registerSocketHandler();
  registerInventoryRefreshHooks();
  WeightCache.registerWeightCacheHooks();
  registerEgressInterceptor();
  registerLogRefreshHooks();
  registerLootPrepRefreshHooks();
  registerCompendiumContextMenu();
  InventoryToken.registerInventoryTokenShortcutHooks();

  Hooks.on("renderActorDirectory", (app, html) => {
    suppressBackingActorFromDirectory(app, html);
    if (!game.user?.isGM || isActiveStorageGM()) injectSidebarButtons(app, html);
  });
  Hooks.on("preDeleteActor", preventBackingActorDeletion);
  Hooks.on("preCreateItem", preventInactiveGmStorageItemMutation);
  Hooks.on("preUpdateItem", preventInactiveGmStorageItemMutation);
  Hooks.on("preDeleteItem", preventInactiveGmStorageItemMutation);

  // The Actors directory can finish its first render before GM storage and
  // runtime hooks are ready. Force one post-registration render so the vaults
  // are suppressed and Quartermaster controls appear immediately on a fresh
  // world instead of waiting for an unrelated directory refresh.
  try {
    ui.actors?.render?.({ force: true });
  } catch (error) {
    console.warn(`${MODULE_TITLE} | Could not refresh the Actors directory`, error);
  }
  return true;
}

/** Install the stable public facade early enough for integration modules. */
function installPublicApi({ runtimeReady = false } = {}) {
  const module = game.modules.get(MODULE_ID);
  if (!module) return null;

  const api = {
    version: module.version ?? "unknown",
    runtimeReady,
    system: {
      apiVersion: SYSTEM_ADAPTER_API_VERSION,
      registerAdapter,
      registerSystemAdapter,
      getAdapter: getSystemAdapter,
      getActiveAdapter: getActiveSystemAdapter,
      normalizeItem: normalizeSystemItem,
      diagnostics: getSystemAdapterDiagnostics
    },
    storage: {
      getSharedActor: getBackingActor,
      getStagingActor
    }
  };

  if (runtimeReady) {
    Object.assign(api.storage, {
      ensure: ensureStorageActors,
      recovery: RecoveryRecords
    });
    Object.assign(api, {
      coordinator: {
        executeOperation,
        diagnostics: coordinatorDiagnostics
      },
      socket: {
        submitRequest,
        isActiveGM,
        diagnostics: socketDiagnostics
      },
      ui: {
        openInventory: openInventoryApp,
        closeInventory: closeInventoryApp,
        isInventoryOpen: isInventoryAppOpen,
        refreshInventory: forceInventoryRefresh,
        scheduleInventoryRefresh,
        openCurrencyManager,
        openLootPrep: openLootPrepApp,
        closeLootPrep: closeLootPrepApp,
        isLootPrepOpen: isLootPrepAppOpen,
        openTransactionLog: openTransactionLogApp,
        closeTransactionLog: closeTransactionLogApp,
        isTransactionLogOpen: isTransactionLogAppOpen
      },
      transactionLog: TransactionLog,
      transactionLogQuery: TransactionLogQuery,
      approvalPolicy: ApprovalPolicy,
      resources: Resources,
      hiddenItems: HiddenItems,
      hiddenCurrency: HiddenCurrency,
      lootPrepFolders: LootPrepFolders,
      lootPrepNotes: LootPrepNotes,
      contextMenu: ContextMenu,
      inventoryToken: InventoryToken,
      currencies: Currencies,
      sanitization: Sanitization,
      weightCache: WeightCache,
      claimCommit: ClaimCommit
    });
  }

  module.api = api;
  return api;
}
