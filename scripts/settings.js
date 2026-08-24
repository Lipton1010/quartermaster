/**
 * Quartermaster — Settings Registration
 *
 * Registers all world-scope and client-scope settings. Called once during `init`.
 */

import { MODULE_ID, MODULE_TITLE, SETTINGS, CHOICES, HOOKS } from "./constants.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";
import * as TransactionLog from "./transaction-log.js";

export function registerSettings(adapter = getActiveSystemAdapter()) {
  const capacitySupported = adapter.defaultCapacity?.enforced === true;
  const currencyLoadSupported = adapter.capabilities?.currencyWeight === true;
  const identificationSupported = adapter.capabilities?.identification === true;
  const itemValueSupported = adapter.capabilities?.itemValue === true;
  // ============================================================
  // Capacity
  // ============================================================

  game.settings.register(MODULE_ID, SETTINGS.ENFORCE_CAPACITY, {
    name: "quartermaster.settings.enforceCapacity.name",
    hint: "quartermaster.settings.enforceCapacity.hint",
    scope: "world",
    config: capacitySupported,
    type: Boolean,
    default: capacitySupported
  });

  game.settings.register(MODULE_ID, SETTINGS.CAPACITY_LIMIT, {
    name: "quartermaster.settings.capacityLimit.name",
    hint: "quartermaster.settings.capacityLimit.hint",
    scope: "world",
    config: capacitySupported,
    type: Number,
    default: adapter.defaultCapacity?.limit ?? 0,
    range: { min: 0, max: 10000, step: 10 }
  });

  game.settings.register(MODULE_ID, SETTINGS.APPLY_CURRENCY_WEIGHT, {
    name: "quartermaster.settings.applyCurrencyWeight.name",
    hint: "quartermaster.settings.applyCurrencyWeight.hint",
    scope: "world",
    config: currencyLoadSupported,
    type: Boolean,
    default: false
  });

  // ============================================================
  // Currency Approval
  // ============================================================

  game.settings.register(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_MODE, {
    name: "quartermaster.settings.currencyApprovalMode.name",
    hint: "quartermaster.settings.currencyApprovalMode.hint",
    scope: "world",
    config: true,
    type: String,
    default: CHOICES.CURRENCY_APPROVAL.ALL_REQUIRED,
    choices: {
      [CHOICES.CURRENCY_APPROVAL.FREE]: "quartermaster.choices.currencyApprovalMode.free",
      [CHOICES.CURRENCY_APPROVAL.THRESHOLD]: "quartermaster.choices.currencyApprovalMode.threshold",
      [CHOICES.CURRENCY_APPROVAL.ALL_REQUIRED]: "quartermaster.choices.currencyApprovalMode.allRequired"
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.CURRENCY_APPROVAL_THRESHOLD, {
    name: "quartermaster.settings.currencyApprovalThreshold.name",
    hint: "quartermaster.settings.currencyApprovalThreshold.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 50
  });

  game.settings.register(MODULE_ID, SETTINGS.USE_APPROVAL_TIMEOUT, {
    name: "quartermaster.settings.useApprovalTimeout.name",
    hint: "quartermaster.settings.useApprovalTimeout.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.APPROVAL_TIMEOUT_SECONDS, {
    name: "quartermaster.settings.approvalTimeoutSeconds.name",
    hint: "quartermaster.settings.approvalTimeoutSeconds.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 300,
    range: { min: 30, max: 3600, step: 30 }
  });

  game.settings.register(MODULE_ID, SETTINGS.DENIAL_NOTIFICATION, {
    name: "quartermaster.settings.denialNotification.name",
    hint: "quartermaster.settings.denialNotification.hint",
    scope: "world",
    config: true,
    type: String,
    default: CHOICES.DENIAL_NOTIFICATION.GROUP,
    choices: {
      [CHOICES.DENIAL_NOTIFICATION.GROUP]: "quartermaster.choices.denialNotification.group",
      [CHOICES.DENIAL_NOTIFICATION.PLAYER]: "quartermaster.choices.denialNotification.player"
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.REASON_FIELD_ENABLED, {
    name: "quartermaster.settings.reasonFieldEnabled.name",
    hint: "quartermaster.settings.reasonFieldEnabled.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.RESEND_COOLDOWN_SECONDS, {
    name: "quartermaster.settings.resendCooldownSeconds.name",
    hint: "quartermaster.settings.resendCooldownSeconds.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 60,
    range: { min: 0, max: 600, step: 10 }
  });

  // ============================================================
  // Display
  // ============================================================

  game.settings.register(MODULE_ID, SETTINGS.UNIDENTIFIED_DISPLAY, {
    name: "quartermaster.settings.unidentifiedDisplay.name",
    hint: "quartermaster.settings.unidentifiedDisplay.hint",
    scope: "world",
    config: identificationSupported,
    type: String,
    default: CHOICES.UNIDENTIFIED_DISPLAY.UNIDENTIFIED,
    choices: {
      [CHOICES.UNIDENTIFIED_DISPLAY.UNIDENTIFIED]: "quartermaster.choices.unidentifiedDisplay.unidentified",
      [CHOICES.UNIDENTIFIED_DISPLAY.IDENTIFIED]: "quartermaster.choices.unidentifiedDisplay.identified",
      [CHOICES.UNIDENTIFIED_DISPLAY.PER_ITEM]: "quartermaster.choices.unidentifiedDisplay.perItem"
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.INVENTORY_BUTTON_LABEL, {
    name: "quartermaster.settings.inventoryButtonLabel.name",
    hint: "quartermaster.settings.inventoryButtonLabel.hint",
    scope: "world",
    config: true,
    type: String,
    default: "Shared Party Inventory",
    onChange: () => {
      ui.actors?.render?.();
      Hooks.callAll(HOOKS.PREFERENCES_CHANGED, { keys: [SETTINGS.INVENTORY_BUTTON_LABEL] });
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.INVENTORY_BACKGROUND_IMAGE, {
    name: "quartermaster.settings.inventoryBackgroundImage.name",
    hint: "quartermaster.settings.inventoryBackgroundImage.hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    filePicker: "image",
    onChange: () => {
      Hooks.callAll(HOOKS.PREFERENCES_CHANGED, { keys: [SETTINGS.INVENTORY_BACKGROUND_IMAGE] });
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.HIDE_PRICES_FROM_PLAYERS, {
    name: "quartermaster.settings.hidePricesFromPlayers.name",
    hint: "quartermaster.settings.hidePricesFromPlayers.hint",
    scope: "world",
    config: itemValueSupported,
    type: Boolean,
    default: false,
    onChange: () => {
      Hooks.callAll(HOOKS.PREFERENCES_CHANGED, { keys: [SETTINGS.HIDE_PRICES_FROM_PLAYERS] });
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.ENABLE_INVENTORY_TOKEN, {
    name: "quartermaster.settings.enableInventoryToken.name",
    hint: "quartermaster.settings.enableInventoryToken.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      ui.actors?.render?.();
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.INVENTORY_TOKEN_NAME, {
    name: "quartermaster.settings.inventoryTokenName.name",
    hint: "quartermaster.settings.inventoryTokenName.hint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.INVENTORY_TOKEN_IMAGE, {
    name: "quartermaster.settings.inventoryTokenImage.name",
    hint: "quartermaster.settings.inventoryTokenImage.hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    filePicker: "image"
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_ENTRY_SIZE, {
    name: "quartermaster.settings.defaultEntrySize.name",
    hint: "quartermaster.settings.defaultEntrySize.hint",
    scope: "client",
    config: false,
    type: String,
    default: CHOICES.ENTRY_SIZE.MEDIUM,
    choices: {
      [CHOICES.ENTRY_SIZE.COMPACT]: "quartermaster.choices.entrySize.compact",
      [CHOICES.ENTRY_SIZE.MEDIUM]: "quartermaster.choices.entrySize.medium",
      [CHOICES.ENTRY_SIZE.LARGE]: "quartermaster.choices.entrySize.large"
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.SORT_ORDER, {
    name: "quartermaster.settings.sortOrder.name",
    hint: "quartermaster.settings.sortOrder.hint",
    scope: "client",
    config: false,
    type: String,
    default: CHOICES.SORT_ORDER.CURRENCY_FIRST,
    choices: {
      [CHOICES.SORT_ORDER.CURRENCY_FIRST]: "quartermaster.choices.sortOrder.currencyFirst",
      [CHOICES.SORT_ORDER.ALPHABETICAL]: "quartermaster.choices.sortOrder.alphabetical",
      [CHOICES.SORT_ORDER.BY_TYPE]: "quartermaster.choices.sortOrder.byType",
      [CHOICES.SORT_ORDER.CUSTOM]: "quartermaster.choices.sortOrder.custom"
    }
  });

  game.settings.register(MODULE_ID, SETTINGS.HIDE_ZERO_BALANCES, {
    name: "quartermaster.settings.hideZeroBalances.name",
    hint: "quartermaster.settings.hideZeroBalances.hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

  // ============================================================
  // Transaction Log
  // ============================================================

  game.settings.register(MODULE_ID, SETTINGS.TRANSACTION_LOG_CAP, {
    name: "quartermaster.settings.transactionLogCap.name",
    hint: "quartermaster.settings.transactionLogCap.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 500,
    range: { min: 0, max: 10000, step: 50 }
  });

  game.settings.register(MODULE_ID, SETTINGS.TRANSACTION_LOG_VISIBILITY, {
    name: "quartermaster.settings.transactionLogVisibility.name",
    hint: "quartermaster.settings.transactionLogVisibility.hint",
    scope: "world",
    config: true,
    type: String,
    default: CHOICES.LOG_VISIBILITY.ALL,
    choices: {
      [CHOICES.LOG_VISIBILITY.ALL]: "quartermaster.choices.logVisibility.all",
      [CHOICES.LOG_VISIBILITY.GM_ONLY]: "quartermaster.choices.logVisibility.gmOnly"
    },
    onChange: async () => {
      if (!game.user?.isGM) return;
      try {
        await TransactionLog.refreshPublicProjection();
      } catch (error) {
        console.error(`${MODULE_TITLE} | Could not refresh the public transaction-log projection`, error);
      }
    }
  });

  // ============================================================
  // Operation Coordinator (advanced)
  // ============================================================

  game.settings.register(MODULE_ID, SETTINGS.REQUEST_AGE_MAX_SECONDS, {
    name: "quartermaster.settings.requestAgeMaxSeconds.name",
    hint: "quartermaster.settings.requestAgeMaxSeconds.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 30,
    range: { min: 5, max: 300, step: 5 }
  });

  game.settings.register(MODULE_ID, SETTINGS.RECENT_REQUEST_CACHE_SIZE, {
    name: "quartermaster.settings.recentRequestCacheSize.name",
    hint: "quartermaster.settings.recentRequestCacheSize.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 5000,
    range: { min: 100, max: 50000, step: 100 }
  });

  game.settings.register(MODULE_ID, SETTINGS.MUTATION_RATE_LIMIT_MAX, {
    name: "quartermaster.settings.mutationRateLimitMax.name",
    hint: "quartermaster.settings.mutationRateLimitMax.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 30,
    range: { min: 0, max: 200, step: 1 }
  });

  game.settings.register(MODULE_ID, SETTINGS.MUTATION_RATE_LIMIT_WINDOW_MS, {
    name: "quartermaster.settings.mutationRateLimitWindowMs.name",
    hint: "quartermaster.settings.mutationRateLimitWindowMs.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 10000,
    range: { min: 1000, max: 120000, step: 1000 }
  });

  game.settings.register(MODULE_ID, SETTINGS.UI_REFRESH_DEBOUNCE_MS, {
    name: "quartermaster.settings.uiRefreshDebounceMs.name",
    hint: "quartermaster.settings.uiRefreshDebounceMs.hint",
    scope: "world",
    config: true,
    type: Number,
    default: 100,
    range: { min: 0, max: 1000, step: 25 }
  });

  game.settings.register(MODULE_ID, SETTINGS.HIDE_ELECTRUM, {
    name: "quartermaster.settings.hideElectrum.name",
    hint: "quartermaster.settings.hideElectrum.hint",
    scope: "client",
    // Legacy setting retained only to seed the new world-level currency
    // visibility configuration on first use.
    config: false,
    type: Boolean,
    default: false
  });

  // ============================================================
  // Transaction Log Defaults (client-scope, step 17)
  // ============================================================

  game.settings.register(MODULE_ID, SETTINGS.LOG_DEFAULT_PHASE_FILTER, {
    name: "quartermaster.settings.logDefaultPhaseFilter.name",
    hint: "quartermaster.settings.logDefaultPhaseFilter.hint",
    scope: "client",
    config: false,
    type: String,
    default: "all"
  });

  game.settings.register(MODULE_ID, SETTINGS.LOG_DEFAULT_CATEGORY_FILTER, {
    name: "quartermaster.settings.logDefaultCategoryFilter.name",
    hint: "quartermaster.settings.logDefaultCategoryFilter.hint",
    scope: "client",
    config: false,
    type: String,
    default: "all"
  });

  game.settings.register(MODULE_ID, SETTINGS.LOG_AUTO_EXPAND_GROUPS, {
    name: "quartermaster.settings.logAutoExpandGroups.name",
    hint: "quartermaster.settings.logAutoExpandGroups.hint",
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

  // ============================================================
  // Internal storage (no config UI)
  // ============================================================

  game.settings.register(MODULE_ID, SETTINGS.BACKING_ACTOR_ID, {
    name: "Backing Actor ID (internal)",
    hint: "Stored automatically. Do not edit manually.",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.STAGING_ACTOR_ID, {
    name: "Staging Actor ID (internal)",
    hint: "Stored automatically. Do not edit manually.",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTINGS.VAULT_ACTOR_TYPE, {
    name: "Vault Actor Type (internal)",
    hint: "Selected automatically by the active system adapter or confirmed by the GM.",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  console.log(`${MODULE_TITLE} | Settings registered`);
}
