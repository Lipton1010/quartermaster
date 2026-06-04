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

import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { registerSettings } from "./settings.js";
import {
  ensureBackingActor,
  suppressBackingActorFromDirectory,
  suppressBackingActorFromUserConfig,
  preventBackingActorDeletion,
  preventBackingActorCharacterAssignment
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
import {
  runStep3Tests,
  showDiagnostics,
  cleanupTestLogEntries
} from "./test-step3.js";
import {
  runStep4Tests,
  showSocketDiagnostics
} from "./test-step4.js";
import {
  runStep7Tests
} from "./test-step7.js";
import {
  runStep8Tests,
  cleanupStep8Fixtures
} from "./test-step8.js";
import {
  runStep9Tests,
  cleanupStep9Fixtures
} from "./test-step9.js";
import {
  runStep10Tests,
  cleanupStep10Fixtures
} from "./test-step10.js";
import {
  runStep11Tests
} from "./test-step11.js";
import {
  runStep13Tests,
  simulatePlayerCurrencyRequest
} from "./test-step13.js";
import {
  runStep14Tests,
  cleanupStep14Fixtures
} from "./test-step14.js";
import {
  runStep15Tests,
  cleanupStep15Fixtures
} from "./test-step15.js";
import {
  runStep16Tests,
  cleanupStep16Fixtures
} from "./test-step16.js";
import {
  runStep17Tests,
  cleanupStep17Fixtures
} from "./test-step17.js";
import {
  runStep18Tests,
  cleanupStep18Fixtures
} from "./test-step18.js";
import * as TransactionLogQuery from "./transaction-log-query.js";
import * as ApprovalPolicy from "./approval-policy.js";
import * as Resources from "./resources.js";
import * as HiddenItems from "./hidden-items.js";
import * as HiddenCurrency from "./hidden-currency.js";
import * as LootPrepFolders from "./loot-prep-folders.js";
import * as ContextMenu from "./context-menu.js";
import { registerCompendiumContextMenu } from "./compendium-menu.js";

/**
 * Foundry lifecycle: init
 * Fires once during world initialization, before any data is loaded.
 * Used for settings registration and any pre-data hooks.
 */
Hooks.once("init", () => {
  console.log(`${MODULE_TITLE} | Init`);
  registerSettings();
  registerSocketHandler();
});

/**
 * Foundry lifecycle: ready
 * Fires once after all data is loaded and the canvas is drawn.
 * Used for actor/document-dependent setup.
 */
Hooks.once("ready", async () => {
  console.log(`${MODULE_TITLE} | Ready`);

  await ensureBackingActor();
  initializeCoordinator();
  registerInventoryRefreshHooks();
  WeightCache.registerWeightCacheHooks();
  registerEgressInterceptor();
  registerLogRefreshHooks();
  registerLootPrepRefreshHooks();
  registerCompendiumContextMenu();

  // Expose a public API on the module for other scripts and the test harness
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      version: "0.1.0",
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
      contextMenu: ContextMenu,
      sanitization: Sanitization,
      weightCache: WeightCache,
      claimCommit: ClaimCommit,
      test: {
        runStep3Tests,
        runStep4Tests,
        runStep7Tests,
        runStep8Tests,
        runStep9Tests,
        runStep10Tests,
        runStep11Tests,
        runStep13Tests,
        runStep14Tests,
        runStep15Tests,
        runStep16Tests,
        runStep17Tests,
        runStep18Tests,
        simulatePlayerCurrencyRequest,
        showDiagnostics,
        showSocketDiagnostics,
        cleanupTestLogEntries,
        cleanupStep8Fixtures,
        cleanupStep9Fixtures,
        cleanupStep10Fixtures,
        cleanupStep14Fixtures,
        cleanupStep15Fixtures,
        cleanupStep16Fixtures,
        cleanupStep17Fixtures,
        cleanupStep18Fixtures
      }
    };
  }

  console.log(`${MODULE_TITLE} | v0.1.0 loaded (step 18 ready)`);
});

/**
 * Hook: renderActorDirectory
 * Fires every time the Actors sidebar tab renders. Used to:
 *   1. Inject the two Quartermaster buttons (sidebar.js)
 *   2. Suppress the backing actor from the visible actor list (backing-actor.js)
 */
Hooks.on("renderActorDirectory", (app, html, data) => {
  suppressBackingActorFromDirectory(app, html);
  injectSidebarButtons(app, html);
});

/**
 * Hook: renderUserConfig
 * Removes the Quartermaster backing actor from the Player Character selector.
 */
Hooks.on("renderUserConfig", (app, html, data) => {
  suppressBackingActorFromUserConfig(app, html);
});

/**
 * Hook: preUpdateUser
 * Prevents the Quartermaster backing actor from being saved as a user character.
 */
Hooks.on("preUpdateUser", preventBackingActorCharacterAssignment);

/**
 * Hook: preDeleteActor
 * Fires before any actor is deleted. Used to protect the backing actor
 * from accidental deletion while the module is active.
 */
Hooks.on("preDeleteActor", preventBackingActorDeletion);
