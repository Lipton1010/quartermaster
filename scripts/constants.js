/**
 * Quartermaster — Constants
 *
 * Central registry of module identifiers, flag keys, setting keys, and enum values.
 * Importing from this module means no hardcoded strings sprinkled through the codebase.
 */

export const MODULE_ID = "quartermaster";
export const MODULE_TITLE = "Quartermaster";

/**
 * Flag keys used on the backing actor and on items.
 * All flags are stored under `actor.flags["quartermaster"]` or `item.flags["quartermaster"]`.
 */
export const FLAGS = {
  CUSTOM_RESOURCES: "customResources",
  TRANSACTION_LOG: "transactionLog",
  HIDDEN: "hidden",
  PER_ITEM_PERMISSION: "permission",
  HIDDEN_CURRENCY: "hiddenCurrency",
  CURRENCY_CONFIG: "currencyConfig",
  LOOT_PREP_FOLDERS: "lootPrepFolders",
  LOOT_PREP_FOLDER: "lootPrepFolder",
  LOOT_PREP_NOTE: "lootPrepNote",
  MIGRATED_ITEM_METADATA: "migratedItemMetadata",
  BACKING_ACTOR_MARKER: "isQuartermasterBackingActor",
  STAGING_ACTOR_MARKER: "isQuartermasterStagingActor",
  STORAGE_SCHEMA_VERSION: "storageSchemaVersion",
  STORAGE_SYSTEM_ID: "storageSystemId",
  MIGRATION_STATE: "migrationState",
  RECOVERY_RECORDS: "recoveryRecords",
  OPERATION_TOMBSTONES: "operationTombstones",
  INVENTORY_TOKEN_SHORTCUT: "isInventoryTokenShortcut"
};

/**
 * Setting keys. Used with game.settings.get/set.
 */
export const SETTINGS = {
  // Capacity
  ENFORCE_CAPACITY: "enforceCapacity",
  CAPACITY_LIMIT: "capacityLimit",
  APPLY_CURRENCY_WEIGHT: "applyCurrencyWeight",
  // Currency approval
  CURRENCY_APPROVAL_MODE: "currencyApprovalMode",
  CURRENCY_APPROVAL_THRESHOLD: "currencyApprovalThreshold",
  USE_APPROVAL_TIMEOUT: "useApprovalTimeout",
  APPROVAL_TIMEOUT_SECONDS: "approvalTimeoutSeconds",
  DENIAL_NOTIFICATION: "denialNotification",
  REASON_FIELD_ENABLED: "reasonFieldEnabled",
  RESEND_COOLDOWN_SECONDS: "resendCooldownSeconds",
  // Display
  UNIDENTIFIED_DISPLAY: "unidentifiedDisplay",
  INVENTORY_BUTTON_LABEL: "inventoryButtonLabel",
  INVENTORY_BACKGROUND_IMAGE: "inventoryBackgroundImage",
  HIDE_PRICES_FROM_PLAYERS: "hidePricesFromPlayers",
  ENABLE_INVENTORY_TOKEN: "enableInventoryToken",
  INVENTORY_TOKEN_NAME: "inventoryTokenName",
  INVENTORY_TOKEN_IMAGE: "inventoryTokenImage",
  DEFAULT_ENTRY_SIZE: "defaultEntrySize",
  SORT_ORDER: "sortOrder",
  HIDE_ZERO_BALANCES: "hideZeroBalances",
  HIDE_ELECTRUM: "hideElectrum",
  // Transaction log
  TRANSACTION_LOG_CAP: "transactionLogCap",
  TRANSACTION_LOG_VISIBILITY: "transactionLogVisibility",
  // Coordinator (step 3)
  REQUEST_AGE_MAX_SECONDS: "requestAgeMaxSeconds",
  RECENT_REQUEST_CACHE_SIZE: "recentRequestCacheSize",
  // UI rendering (step 6)
  UI_REFRESH_DEBOUNCE_MS: "uiRefreshDebounceMs",
  // Transaction log defaults (client-scope, step 17)
  LOG_DEFAULT_PHASE_FILTER: "logDefaultPhaseFilter",
  LOG_DEFAULT_CATEGORY_FILTER: "logDefaultCategoryFilter",
  LOG_AUTO_EXPAND_GROUPS: "logAutoExpandGroups",
  // Internal (no config UI)
  BACKING_ACTOR_ID: "backingActorId",
  STAGING_ACTOR_ID: "stagingActorId",
  VAULT_ACTOR_TYPE: "vaultActorType"
};

/**
 * Enum values used by choice-type settings and runtime logic.
 */
export const CHOICES = {
  CURRENCY_APPROVAL: {
    FREE: "free",
    THRESHOLD: "threshold",
    ALL_REQUIRED: "all-required"
  },
  DENIAL_NOTIFICATION: {
    GROUP: "group",
    PLAYER: "player"
  },
  UNIDENTIFIED_DISPLAY: {
    UNIDENTIFIED: "unidentifiedName",
    IDENTIFIED: "identifiedName",
    PER_ITEM: "perItem"
  },
  ENTRY_SIZE: {
    COMPACT: "compact",
    MEDIUM: "medium",
    LARGE: "large"
  },
  SORT_ORDER: {
    CURRENCY_FIRST: "currencyFirst",
    ALPHABETICAL: "alphabetical",
    BY_TYPE: "byType",
    CUSTOM: "custom"
  },
  LOG_VISIBILITY: {
    ALL: "all",
    GM_ONLY: "gm-only"
  }
};

/**
 * Custom hook names exposed for other modules to listen to.
 */
export const HOOKS = {
  ITEM_MOVED: "quartermaster.itemMoved",
  CURRENCY_CHANGED: "quartermaster.currencyChanged",
  LOOT_REVEALED: "quartermaster.lootRevealed",
  LOG_ENTRY_ADDED: "quartermaster.logEntryAdded",
  PREFERENCES_CHANGED: "quartermaster.preferencesChanged",
  REGISTER_SYSTEM_ADAPTERS: "quartermaster.registerSystemAdapters"
};

export const STORAGE_SCHEMA_VERSION = 1;
export const SYSTEM_ADAPTER_API_VERSION = 2;

/** Maximum tolerated positive client clock skew for authenticated mutations. */
export const REQUEST_FUTURE_SKEW_MS = 30_000;

/**
 * Per-item permission override values. Mirrors CURRENCY_APPROVAL with an additional
 * "global" mode that defers to the world setting.
 */
export const ITEM_PERMISSIONS = {
  GLOBAL: "global",
  ALL_ALLOWED: "all-allowed",
  THRESHOLD: "threshold",
  ALL_REQUIRED: "all-required"
};
