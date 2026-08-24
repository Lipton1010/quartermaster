# Changelog

All notable changes to Quartermaster will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Build steps referenced in early entries are development-time milestones. Build steps 1–18 all shipped in v0.1.0; subsequent work is tracked by version going forward.


## [Unreleased]

_(Merge, installation, tagging, and publication remain gated on review of the migration and compatibility evidence.)_


## [1.0.0] - Unreleased

### Added
- Add a versioned system-adapter registry with built-in generic, D&D 5e, and PF2e adapters and a public registration API.
- Add normalized Item metadata, recipient compatibility, transfer preparation, load formatting, and native-currency capabilities behind adapters.
- Add a generic fallback with one editable `Currency` (`CUR`) balance and graceful omission of unsupported metadata.
- Add native PF2e loot Actor, coin, quantity, Bulk, value, identification, and coin-item handling.
- Add a GM-only staging Actor for unrevealed Items, staged currency, folders, notes, canonical logs, and recovery records.
- Add restartable storage-schema migration and automated adapter, authorization, privacy, migration, manifest, and package-integrity checks.
- Add a single adapter-aware development test runner and repaired GitHub Actions workflows.
- Add a capture-phase document `drop` interceptor in `scripts/drag-drop.js` for Quartermaster-marked egress drags, resolving destination Actors via `foundry.applications.instances` and legacy `ui.windows` (required for PF2e `CharacterSheetPF2e` on ApplicationV1).
- Add a per-user sliding-window mutation rate limiter (`scripts/mutation-rate-limit.js`) with world settings for max requests and window duration.
- Add `scripts/query-sender.js` to resolve authenticated `CONFIG.queries` sender identity on Foundry v13 from the server-rewritten `userQuery` socket argument.

### Changed
- Use Actor and Item UUIDs for transfers, including unlinked Token Actors, while accepting permission-checked legacy IDs during v1.
- Allow players to select any compatible Actor they own, with their assigned Actor retained as the default.
- Move hidden loot between private staging and the visible shared vault instead of relying on client-side filtering.
- Preserve D&D 5e native balances and existing 500 lb capacity behavior while routing system data through its adapter.
- Display PF2e Bulk with initial capacity enforcement disabled.
- Hide load, price, and identification controls when the active adapter cannot provide accurate values.
- Remove the D&D-only manifest relationship and use a version-specific v1.0.0 download URL.
- Remove D&D 5e's native-currency whole-coin restriction (`Number.isInteger(delta)` check, added earlier in this same branch and never shipped) to preserve v0.1.8's decimal-currency compatibility. D&D 5e's currency fields genuinely support fractional values; only PF2e's coin APIs actually require whole units, and that requirement is now expressed per-currency via the adapter-declared `wholeUnitsOnly` flag (see Fixed, below) instead of being hardcoded into the D&D adapter.

### Known limitations
- PF2e native coin Bulk is separated from the Actor inventory aggregate to avoid double-counting optional currency load. Coin Items inside Bulk-reducing containers can make that separation approximate. PF2e capacity enforcement remains disabled.
- Mutation rate limiting is in-memory only and does not persist across server reload.
- Foundry v13 `CONFIG.queries` ack routing can race when multiple Gamemaster clients are connected; live Player2 checks require a single GM client.
- Query-sender identity capture uses LIFO stack ordering when multiple queries overlap.
- Player privacy for canonical logs and staging data is enforced at the application layer; Foundry still syncs full Actor/flag data to connected clients.
- Custom System Builder first boot on the generic adapter may require setting `quartermaster.vaultActorType=character` when no headed DialogV2 is available (operator note, not a product defect).

### Security
- Remove the unauthenticated raw-socket mutation fallback and fail closed without Foundry's authenticated query transport.
- Revalidate sender identity, document ownership, transfer direction, system compatibility, and storage boundaries under GM authority.
- Create and verify destination Items before deleting sources, compensate failed operations, and retain private recovery data when needed.
- Redact player-readable transaction projections while retaining the canonical audit log in GM-only storage.
- On Foundry v13, resolve query sender identity from the server-authenticated `userQuery` connection context only; never trust `payload.userId` or bare `options.userId` (fail closed to `null` when identity cannot be established).

### Migration
- Introduce integer storage schema version 1 and currency-config version 3.
- Copy and verify legacy private data before deleting legacy values, and advance the schema marker only after complete success.
- Preserve legacy D&D native and custom balances, rates, approval settings, resources, visible Items, notes, folders, logs, settings, and shortcut-token data.
- Scrub `lootPrepNote`/`lootPrepFolder` flags left on already-visible v0.1.8 Items instead of leaving GM notes readable by players; `verifyPrivateStorageCleared` now asserts this.
- Detect a migrated hidden-currency amount that is fractional for a native currency whose adapter requires whole units, record it on the migration state, and warn the GM instead of leaving it silently unrevealable.

### Fixed
- Register the storage-Actor deletion guard and Actors-directory suppression at module scope instead of inside the ready-gated runtime hooks, so an unelected GM (or one whose storage failed to initialize) can no longer see or delete either storage Actor.
- Make a failed staged-currency reveal retryable instead of permanently reusing a stale request id that could hit `request-too-old` or replay a terminal failure forever.
- Run the currency-approval prompt under its own lock instead of the shared `currency-ledger` lock, so an unanswered approval dialog can no longer stall every currency mutation and staged-currency reveal world-wide.
- Reject fractional `addHiddenCurrency` amounts for native currencies whose adapter requires whole units (PF2e).
- Serialize hidden-Item move/delete/stage operations under the storage ledger lock and disable the Loot Prep reveal control while a request is in flight, closing a double-click duplication path.
- Derive `release.yml`'s version, compatibility minimum, and compatibility-verified values from `module.json` instead of hardcoding them, and move the actual Foundry publish step into a separate, manually authorized `publish-foundry.yml` workflow.
- Exclude `docs/` from the packaged archive via `.gitattributes`.
- Broaden `validate-release.mjs`'s system-coupling check to catch a hardcoded `"loot"` Item-type default outside `scripts/system-adapters` (previously missed).
- Keep `api.ui.openInventory()` and friends available to a GM who is not the active storage GM, per the documented macro surface.
- Key GM-only inventory and Loot Prep controls off the active storage-GM election instead of raw `user.isGM`, so a non-active GM no longer sees clickable no-op controls.
- Normalize primitive-only array fields (e.g. a system's Set-backed Item property list) to deduplicated, order-independent content before the migration's per-Item write-verification check, found via live rehearsal against Foundry 14.365/D&D 5e 5.3.3: recreating an Item during migration could benignly round-trip a duplicate entry in such a field, which the exact-array-equality check wrongly treated as corrupted data and aborted the migration on.
- Filter `undefined`-valued object keys (and convert `undefined` array elements to `null`) before every write-then-verify comparison against a Foundry actor flag, matching real JSON/Foundry persistence semantics. Found via live matrix testing against Pathfinder 2e and Custom System Builder: a raw Item snapshot with even one schema-defined-but-unset field (always true for PF2e's native Treasure/coin Items and every Custom System Builder Item) made every transfer involving that Item fail with `canonical-transaction-log-verification-failed`, since Foundry silently drops such keys on persist but the comparison never accounted for that. Fixed everywhere this write-verification pattern is duplicated: transaction log, storage migration, recovery records, operation coordinator, operation tombstones, and loot-prep folders/notes.
- Close the Custom System Builder native-sheet egress bypass: a capture-phase document listener gated on Quartermaster drag markers intercepts marked drops before system sheets that override `_onDrop` without calling `dropActorSheetData`, including CSB `CharacterSheetV2` and PF2e `CharacterSheetPF2e` registered only in `ui.windows`.

### Verification
- On 2026-08-24, committed candidate on `feat/system-agnostic` passed syntax checks, **117/117** headless tests (`npm test`), and the release/system-boundary validator. Coverage includes `query-sender`, `drag-drop` capture interceptor, and `mutation-rate-limit` unit tests.
- Validated release package built from the committed tree via `npm run package` + `tools/validate-package.mjs`. Evidence (archive, SHA-256, manifest copy, complete file list) is retained beside the archive under `artifacts/system-agnostic/`; see [RELEASE-GATE.md](docs/RELEASE-GATE.md) for the current checksum.
- All six required live Foundry matrix cells **Passed** on interceptor SHA-256 `51E7246FE2CB008F9FC443B577CE665B2C81866DFEF31BD16B83CAE0A154FDCD` (2026-08-24): Foundry **v14.367** (D&D 5e 5.3.3, PF2e 8.4.0, CSB 6.0.2) and Foundry **v13.351** (D&D 5e 5.3.3, PF2e 7.12.2, CSB 5.2.1). Not every sub-check was re-run on this interceptor in the final session; carried-forward evidence is annotated in [RELEASE-GATE.md](docs/RELEASE-GATE.md).
- The live v0.1.8-to-v1 migration rehearsal **passed** against a synthetic fixture world. See the [release gate](docs/RELEASE-GATE.md) and [migration report](docs/MIGRATION-REPORT.md) for full evidence.
- Version 1.0.0 remains **unreleased**. Merge, installation, tagging, and publication have **not** been authorized.


## [0.1.8] - 2026-07-22

### Added
- Document the public macro command for opening the Shared Party Inventory from landing pages, hotbars, and other triggers.

### Fixed
- Scope dialog dropdown colors to Quartermaster preference selects so other modules, including Item Piles, retain their own select styling.


## [0.1.7] - 2026-07-18

### Added
- Add GM Loot Prep notes through right-click folder and item editors. Folder notes apply to every item in the folder, while individual item notes take precedence.
- Add a selectable reference currency and editable reference-relative conversion rates for every built-in and custom currency.
- Add an optional per-unit weight to custom currencies; built-in currencies remain fixed at 50 coins per pound.
- Add a Manage Currencies shortcut to GM Loot Prep and make folder-note indicators clickable for editing.

### Changed
- Rebase currency rates and the configured approval threshold automatically when the reference currency changes, preserving established economic relationships.
- Show inventory equivalent totals and evaluate approval thresholds in the selected reference currency.
- Migrate existing custom-currency conversions to the new reference model without changing their effective GP value.
- Update verified Foundry VTT compatibility metadata to v14.365.


## [0.1.6] - 2026-07-10

### Added
- Add unlimited GM-defined custom currencies with configurable names, short labels, decimal balances, and optional tile background images.
- Add optional custom-currency conversion rates using PP, GP, EP, SP, or CP as the target denomination.
- Add a GM currency manager for creating, editing, deleting, hiding, and restoring currencies.
- Add a visible GM-only Manage Currencies button to the inventory item toolbar.
- Add GM right-click actions on currency tiles to hide, edit, restore, or manage currencies.
- Support custom currencies in GM Loot Prep staging, reveal operations, approval dialogs, and the transaction log.
- Allow optional tile background images for the five built-in currencies.

### Changed
- Hidden currencies are omitted from the inventory, converted GP total, and visible currency-weight calculation for all users.
- Threshold approval mode now compares converted GP value when a conversion is available.
- Preserve the former Hide Electrum preference as a one-time seed for the new shared currency visibility configuration.

### Fixed
- Fix currency right-click actions being canceled before their click handlers could run.


## [0.1.5] - 2026-06-29

### Added
- Add GM settings to customize the Shared Party Inventory button/window name and optional popup watermark image.
- Add a GM setting to hide item prices from player Shared Party Inventory views while keeping prices visible to GMs.
- Add an optional GM-only scene token shortcut for the Shared Party Inventory.
- Double-clicking a Quartermaster inventory shortcut token opens the configured inventory window.
- Add a Create Item button to GM Loot Prep for quickly staging hidden loot.

### Changed
- Update verified Foundry VTT compatibility metadata to v14.364.

### Fixed
- Improve Shared Party Inventory right-click menu contrast on dark themes.
- Exclude hidden GM Loot Prep items from Shared Party Inventory capacity and item-weight totals.
- Filter duplicate temporary wildshape/wildform actors out of the GM Add to Character picker.
- Display the configured inventory background image through a dedicated watermark layer.
- Remove hard-coded Shared Party Inventory wording from configurable inventory setting hints.


## [0.1.4] - 2026-06-07

### Added
- Players can right-click Shared Party Inventory items and choose **Add to Character** to transfer the item to their assigned character without dragging.
- GMs can use **Add to Character** from the Shared Party Inventory context menu and choose the target character from a dialog.

## [0.1.3] - 2026-06-04

### Fixed
- Hide the Quartermaster Vault from Foundry's Player Character selector and prevent it from being saved as a user's assigned character.
- Filter hidden loot staging and deletion entries out of player transaction log views while preserving GM audit visibility.
- Record a GM-only staging log entry when a visible Shared Party Inventory item is moved back into GM Loot Prep.

## [0.1.2] — 2026-05-24

Major feature update.

### Added
- **Loot Prep Folders** — organize hidden loot by encounter or location
- **Currency Loot staging** — stage GP/SP/CP entries in Loot Prep, reveal to merge into vault
- **Compendium integration** — drag or right-click compendium items to import
- Create Item button in inventory header
- Sort-by dropdown in items header (A–Z, By Type with headers, Loot First, Manual)
- Manual drag-to-reorder sorting
- Double-click items to open their sheet
- Drag from Loot Prep to inventory or character sheets to reveal
- Delete Selected button for bulk deletion in Loot Prep
- Item value display (GP/SP/CP) on all item rows
- Hide Electrum option (per-user, also in Game Settings)

### Improved
- Always-visible GM action buttons (no hover required)
- Drag items by their icon, not just text
- Empty amount field in currency/resource dialogs
- Currency rail auto-centers when EP is hidden
- Scroll position preserved on re-render
- Folder header accepts drops
- No duplicate items when dragging within Loot Prep

### Compatibility
- Foundry VTT v13–v14.363
- dnd5e 5.0.0+


## [0.1.1] — 2026-05-19

### Changed
- Release metadata cleanup: tagged as a proper release rather than a GitHub pre-release. No functional code changes from 0.1.0.


## [0.1.0] — 2026-05-18

Initial public release. Core feature set complete through build step 18.

### Added
- **Compendium Integration (build step 18):**
  - Drag items from any compendium directory directly onto the Shared Party Inventory popup (GM-only, creates visible item on backing actor)
  - Right-click context menu on compendium item entries: "Send to Party Inventory" (visible) and "Send to GM Staging" (hidden)
  - `importCompendiumItem()` shared helper in `drag-drop.js` used by all import paths (drop zone, context menu, Loot Prep drop)
  - Transaction log entry type `import.direct` for compendium-to-inventory imports; `hidden.staged` reused for staging
  - `transaction-log-query.js` extended: `ENTRY_CATEGORIES.IMPORT`, `formatImport`, icon for `import.direct`
  - "Import" category added to Transaction Log filter dropdown and preferences dialog
  - `scripts/compendium-menu.js`: `registerCompendiumContextMenu()` hooks into `getCompendiumEntryContext`
  - `scripts/test-step18.js` test harness

### Changed (BREAKING — pre-release)
- **Settings scope migration (build step 17):** `sortOrder`, `defaultEntrySize`, and `hideZeroBalances` changed from `scope: "world"` to `scope: "client"`. Each user now has their own value. Pre-existing off-default values will reset to the registered defaults.

### Added
- **Per-user preferences (build step 17):**
  - Gear icon in the Inventory popup header opens an Inventory Preferences dialog (sort order, entry size, hide-zero-balances)
  - Gear icon in the Transaction Log popup header opens a Transaction Log Preferences dialog (default phase/category filter, auto-expand groups)
  - Three new client-scope settings: `logDefaultPhaseFilter`, `logDefaultCategoryFilter`, `logAutoExpandGroups`
  - Transaction Log reads filter defaults from client settings on each window open; auto-expand groups pre-expands all entries on first render
  - Custom hook `quartermaster.preferencesChanged` fires when preferences are saved, triggering live re-render of any open popup
  - `scripts/apps/preferences-dialog.js`: `promptInventoryPreferences`, `promptTransactionLogPreferences`
  - `scripts/test-step17.js` test harness (scope verification, round-trip, hook firing, world-scope guard)


### Added
- **Inventory GM Actions (build step 16):**
  - GM-only hide / trash buttons appear on item row hover in the Shared Party Inventory
  - Right-click context menu on inventory item rows: "Hide (send to Loot Prep)" and "Delete Item"
  - Both button and context menu actions share the same underlying handler (`context-menu.js`)
  - Hide flow: sets `flags.quartermaster.hidden = true` on the item — inventory auto-excludes it, Loot Prep auto-picks it up via existing `updateItem` hook
  - Re-hide drag: dragging an item from Shared Party Inventory onto the Loot Prep Hidden Items drop zone re-hides it without creating a copy
  - Delete flow: DialogV2.confirm → `deleteEmbeddedDocuments` → `hidden.deleted` log entry
  - `scripts/context-menu.js`: `attachInventoryContextMenu`, `handleInventoryGMAction`
  - `scripts/test-step16.js` test harness
  - `api.contextMenu` namespace exposed


### Added
- **Hidden Items — GM Loot Prep (build step 15):**
  - `scripts/hidden-items.js`: `getHiddenItems`, `setItemHidden`, `revealItem`, `revealItems`, `deleteHiddenItem`, `stageHiddenItem` — all GM-only
  - Loot Prep popup now shows a full Hidden Items section with thumbnail, name, qty, weight, and compendium source
  - Per-row Reveal and Delete buttons; Reveal Selected and Reveal All bulk actions with confirmation dialog
  - Drag-drop from compendium directories into the Hidden Items section stages items with the hidden flag set
  - Shift+click Reveal triggers an optional chat message announcing the reveal to players
  - Transaction log entries: `hidden.staged`, `hidden.revealed`, `hidden.deleted`
  - `transaction-log-query.js` extended: `ENTRY_CATEGORIES.HIDDEN`, `formatHidden`, icons for all three hidden phases
  - Auto-refresh hooks in `loot-prep-app.js` now respond to `createItem`, `deleteItem`, and `updateItem` (hidden flag changes) on the backing actor
  - `scripts/test-step15.js` test harness (snapshot/restore pattern, 17 assertions)
  - `api.hiddenItems` namespace exposed on the module API


### Added
- Initial module scaffold
- module.json with Foundry V14 / dnd5e v5.x compatibility
- Full settings registry (capacity, currency approval, display, transaction log)
- English localization file
- Hook registrations: `init`, `ready`, `renderActorDirectory`, `preDeleteActor`
- **Backing actor lifecycle (build step 2):**
  - Auto-creation on first world load with proper ownership (OBSERVER default, OWNER per-GM)
  - Recovery by flag marker on every load (handles ID drift across world export/import)
  - Suppression from the Actors directory sidebar render
  - Deletion safeguard via `preDeleteActor` hook
  - Migration framework integration (baseline no-op; structure in place for future schema changes)
- **Operation coordinator (build step 3):**
  - `AsyncLock` class with per-resource keys, FIFO serialization, and sorted multi-key acquisition for ABBA deadlock prevention
  - `RecentRequestCache` LRU for fast in-memory idempotency
  - `executeOperation()` central choke point: age check, two-layer idempotency (LRU + transaction log), mutex acquire, fn execution with consistent error wrapping, result caching, transaction log write
  - Minimal `transaction-log.js` with `findByRequestId`, `writeEntry`, `readAll`, `count`, `clear`
  - `test-step3.js` in-console verification suite with 10 tests covering serialization, parallelism, idempotency, age rejection, multi-key overlap, and direct AsyncLock and LRU behavior
  - Two new settings: `requestAgeMaxSeconds` (default 30), `recentRequestCacheSize` (default 5000)
  - Module API surface exposed at `game.modules.get("quartermaster").api`
- **Socket pipeline (build step 4):**
  - `socket-handler.js` with primary `CONFIG.queries` mechanism (Foundry V13+) and raw `game.socket.emit` fallback
  - Authoritative sender identity taken from Foundry's connection context, not the payload field
  - `submitRequest(payload)` public API: routes locally on GM clients, queries the active GM from player clients
  - Three payload type dispatchers (item transfer, currency change, custom resource change) with placeholder `fn` stubs that return `{ notImplemented: true }` envelopes; real implementations land in steps 7 through 13
  - `test-step4.js` in-console verification suite with 9 tests covering stub round-trips, validation, idempotency, serialization, identity mismatch warning, and active GM detection
- **Sidebar buttons and skeleton popups (build step 5):**
  - `apps/inventory-app.js` and `apps/loot-prep-app.js` as ApplicationV2 + HandlebarsApplicationMixin classes with the PARTS system in place for step 6 to extend
  - `sidebar.js` injection: idempotent button rendering into the Actors directory header, defensive selector handling for V14 ApplicationV2 vs jQuery
  - GM Loot Prep button is GM-only at three layers: button visibility, open-function gate, and template context flag
  - Singleton open/close helpers prevent duplicate windows; second click brings the existing window forward
  - Placeholder templates render the current state (backing actor presence, ID) and the roadmap for what's coming
  - Scoped CSS under `.quartermaster-sidebar-actions` and `.quartermaster` root classes; no bleed-through into character sheets
  - UI surface exposed via `game.modules.get("quartermaster").api.ui` for console-driven testing
- **Read-only inventory rendering (build step 6):**
  - `inventory-rendering.js` helper: context builder with currency rail, custom resources, items list, weight totals, and capacity state
  - `templates/inventory.hbs` replaced with real layout: header strip with capacity bar and gp total, 5-tile currency rail, optional resources section, items list with icons / names / quantities / weights, footer with version and actor ID
  - Defensive weight extraction handles both dnd5e v3 scalar and v5 object weight schemas
  - Unidentified item display modes respected (unidentifiedName / identifiedName / perItem)
  - Sort orders: alphabetical (default), byType (group then alpha), currencyFirst (treated as alpha for items section), custom (deferred to v1.1, falls through to alpha)
  - Debounced re-rendering driven by `updateActor`, `createItem`, `updateItem`, `deleteItem` hooks; collapses bulk operations into one render per `uiRefreshDebounceMs` window (default 100 ms)
  - Drag-aware deferral: re-render skipped while `document.body` has `qm-dragging` class, retried after 200 ms
  - Three entry-size variants (compact / medium / large) selectable via setting
  - `isInventoryAppOpen` and `isLootPrepAppOpen` corrected from V1-style `rendered` property to V14-reliable `element.isConnected` check
  - New setting: `uiRefreshDebounceMs` (default 100 ms)
  - API additions: `refreshInventory` (forced immediate render) and `scheduleInventoryRefresh` (debounced)
- **Item sanitization pipeline (build step 7):**
  - `sanitization.js`: pure-function pipeline for pre-create transformation of item data, called before `createEmbeddedDocuments`
  - `sanitizeItemForTransfer(sourceData, destActor, options)` is the main entry; returns a new object, never mutates inputs
  - Pre-generates destination `_id` via `foundry.utils.randomID(16)` so callers can compute the destination UUID before the create fires (required for the Claim-and-Commit pattern in step 8)
  - `buildItemUuid(actor, itemId)` composes world-actor item UUIDs
  - Owner-specific state stripping: `equipped`, `attuned` (legacy boolean), `attunement` (numeric, 2 → 1), `preparation.prepared`
  - Item characteristics preserved: quantity, weight, price, rarity, identified state, current charges, damage, properties
  - Module cache stripping: midi-qol runtime caches (advantage, disadvantage, lastSelectedTokenIds, macroCalls, cached), dae cached state, our own quartermaster flags (except `hidden` if `preserveHiddenFlag: true`)
  - Selective effect origin rewriting: effects whose origin matches the source item UUID (or starts with it for sub-references like `.ActiveEffect.X`) get their origin prefix swapped to the destination UUID; effects with unrelated origins are left untouched
  - Effects without `_id` get one pre-generated for predictable destination structure
- **Weight cache and Claim-and-Commit engine (build step 8):**
  - `weight-cache.js`: per-actor cache of raw aggregate totals (`itemWeight`, `coinSum`, `coinValues`); settings-derived values like currency weight and capacity percent are computed by callers at read time so settings toggles don't require cache invalidation
  - Cache miss triggers full recompute and stores; subsequent reads return the cached object by reference
  - Invalidation hooks: `createItem`, `updateItem`, `deleteItem` (for any actor), and `updateActor` (only when `system.currency` changed); non-currency actor updates do NOT invalidate
  - Diagnostics: `size`, `peek`, `cachedActorIds`
  - `inventory-rendering.js` updated to consume `getRawTotals` instead of looping items inline on every render
  - `claim-commit.js`: durable two-phase transfer engine with direction-specific ordering
  - **Egress (bag → player):** delete source first, then create destination. Bag is the contended resource so atomic delete-first ensures only one race winner. If the create fails after the delete, the claim entry preserves the full item data for GM recovery
  - **Ingress (player → bag):** create destination first, then delete source. Bag is the safe accumulator so create-first avoids losing the item. If the delete fails, the item briefly duplicates and GM can manually reconcile
  - All transfers write three categories of log entries: `*_CLAIM` (intent, with full item data), `*_COMMIT` (success), `*_FAILED` (failure with stage and error). Same `requestId` ties them together
  - Sanitization runs BEFORE the claim write so the predicted destination UUID is in the log entry
  - `createEmbeddedDocuments` always called with `{ keepId: true }` so the predicted UUID holds
  - `getTransferTrace(requestId)` diagnostic returns `{ claim, commit, failures }` for inspection
  - Input validation throws on missing `sourceItem`, `destActor`, or `requestId`, and on non-GM callers
  - `transaction-log.js` extended with `updateEntry(requestId, updates)` for future flows that prefer status transitions (approval flow in step 13 will use this)
  - `test-step8.js`: 30+ integration tests creating temporary fixture actors, exercising the full transfer pipeline, then cleaning up actors and log entries; test fixture flag and requestId prefix make orphan cleanup safe
  - API additions: `weightCache` and `claimCommit` namespaces, `test.runStep8Tests`, `test.cleanupStep8Fixtures`
- **Item drag-drop wiring (build step 9):**
  - `drag-drop.js`: connects user gestures on the popup and on character sheets to the Claim-and-Commit engine via the socket pipeline
  - **Ingress (drop on popup):** dragenter/dragover/drop listeners on the inventory root catch drops from anywhere; payload is parsed from standard Foundry drag data (`{type: "Item", uuid: "..."}`); compendium drops rejected with a clear message (v1.1 enhancement); self-drops (item already on backing actor) silently noop
  - **Egress (drag from popup):** each item row marked draggable with custom drag data including a `qmEgressDrag` marker plus standard Foundry fields so receiving sheets recognize it as an item
  - **Egress interception:** `dropActorSheetData` hook checks for the marker; if present, returns false to stop Foundry's default drop handling and routes through our pipeline instead; this prevents the default behavior of duplicating the item (default would create on receiving sheet without deleting from source)
  - `socket-handler.js` `stubItemTransfer` replaced with `realItemTransfer` that resolves source/dest actors and item from the payload, then dispatches to `performIngress` or `performEgress` based on the action field; failures returned as structured envelopes with specific error codes (`source-actor-not-found`, `destination-actor-not-found`, `source-item-not-found`, `source-item-not-on-source-actor`, `unknown-action`, plus underlying claim-commit errors propagated)
  - Payload schema accepts both legacy `itemId` (from step 4 tests) and new `sourceItemId` / `sourceItemUuid` fields; validation error code preserved as `missing-item-id`
  - Resource keys extended to include both `sourceActorId` and `destActorId` so concurrent transfers serialize correctly on either side
  - Visual feedback: drop target shows a dashed amber outline when something is over the popup; the dragged row fades to 40% opacity; cursor changes to grab/grabbing on hover and active states
  - `test-step9.js`: 16+ integration tests covering successful ingress and egress via the socket pipeline, error handling for unknown actors / items / actions, source item state preservation on failed transfers, and idempotency (duplicate requestId returns cached result without re-running the transfer)
  - `test-step4.js` updated: item transfer test now expects routing to the real pipeline (with structured failure on missing docs) instead of the old `notImplemented: true` stub response
  - API additions: `test.runStep9Tests`, `test.cleanupStep9Fixtures`
- **Currency change UI and dispatcher (build step 10):**
  - `currency-buttons.js`: button click handlers and amount-picker dialog
  - Each currency tile now shows a +/− button row below the value
  - Normal click opens a DialogV2 amount picker with quick-pick buttons (1, 5, 10, 25, 100) and a custom number input
  - Shift+click skips the dialog and applies ±1 immediately for fast small adjustments
  - `socket-handler.js` `stubCurrencyChange` replaced with `realCurrencyChange` that resolves the backing actor, validates currency type and delta, checks for insufficient funds, writes claim/commit transaction log entries, and updates `system.currency.<type>`; no approval flow at this stage (approval ships in step 13)
  - Zero delta is a no-op success with `noop: true` in the result envelope, so the dispatcher path can be exercised in tests without mutating vault state
  - Error codes: `no-backing-actor`, `invalid-currency-type`, `invalid-delta`, `insufficient-funds` (with `currentBalance` and `requested` in the envelope for the UI to format)
  - Notification toasts: success messages report the amount added/removed and the new balance; insufficient-funds shows current balance and the attempted amount
  - Transaction log entries: `currency.claim`, `currency.commit`, `currency.failed`, all tied by `requestId` for trace reconstruction
  - Egress transfer toast wording fix (step 9 holdover): was "taken from {destName}" which referenced the wrong actor; now reads "given to {destName}" which correctly names the receiver
  - `test-step4.js` updates: test 2 changed to use `delta: 0` no-op since the stub is gone; test 6 (idempotency) switched to `CUSTOM_RESOURCE_CHANGE` (still stubbed) to keep it state-non-mutating
  - `test-step10.js`: 20+ integration tests covering add, remove, no-op zero delta, insufficient-funds rejection, invalid inputs, idempotency via duplicate requestId, and transaction log entry validation; snapshots vault currency at start and restores at end so the suite leaves no persistent effects
  - CSS additions for the button row (subtle hover states, green tint for +, red tint for −) and the dialog (current-balance display, horizontal quick-pick row, custom-amount input)
  - API additions: `test.runStep10Tests`, `test.cleanupStep10Fixtures`
- **Transaction log query and formatting infrastructure (build step 11):**
  - `transaction-log-query.js`: read-side helpers built on top of the raw write layer; no document mutations
  - `classifyEntry(entry)` parses the `type` field into `{ category, direction, phase }` enums; handles all transfer/currency/resource variants plus untyped legacy entries
  - `formatEntry(entry)` returns a display-ready object with raw timestamp, formatted absolute time, relative time ("just now" / "5m ago" / "2h ago" / "3d ago" / locale date), resolved user name, icon class, short title, longer description, signed amount string, error flag, and error message; never throws on malformed input, always falls back to "Unknown entry" labels
  - `queryEntries(options)` filters by category / phase / direction / userId / requestId / time range / case-insensitive search, sorts by timestamp asc or desc, paginates with limit/offset; returns `{ entries, total, hasMore }`
  - `canUserAccessLog(user)` respects the `transactionLogVisibility` setting: GM always yes; player yes when setting is "all", no when "gm-only"; defaults to permissive on missing setting
  - `isEntryVisibleToUser(entry, user)` and `getVisibleEntries(user, options)` combine the query with visibility for one-call use by the upcoming log window
  - `groupByRequestId(formattedEntries)` clusters claim/commit/failed entries from the same operation into one group; representative entry chosen by phase rank (commit > failed > claim) so the row reads coherently mid-operation
  - `getStats(formattedEntries)` aggregates: total count, counts by category and phase, counts by user, failure count, earliest/latest timestamps
  - Relative time uses thresholds at 30s / 1h / 1d / 7d for human-friendly granularity; older entries fall back to locale date string
  - User name resolution gracefully degrades from `game.users.get(id).name` to a truncated ID display when the user no longer exists
  - `test-step11.js`: 40+ pure-function tests covering classification, formatting (each entry type plus malformed inputs), all query filters and combinations, sort direction, pagination, search, grouping (multi-entry requestId clusters and phase-rank representative selection), stats aggregation, and visibility logic
  - API additions: `transactionLogQuery` namespace, `test.runStep11Tests`
- **Transaction Log window UI (build step 12):**
  - `apps/transaction-log-app.js`: ApplicationV2 + HandlebarsApplicationMixin popup with filter controls, search, expandable rows, and a Clear button (GM only with confirmation dialog)
  - `templates/transaction-log.hbs`: layout with stats strip (totals by category, failures count), filter row (category select, phase select, debounced search input, refresh button, GM-only clear), summary line, and grouped entry list
  - Each entry row shows icon (category-tinted), title, user, description, amount, and relative time; clicking expands to show each individual claim/commit/failed entry with phase badge
  - Filter state and expanded-rows state persist across renders; search input keeps focus and cursor position after debounced re-render so typing isn't interrupted
  - Failed operations get a red border-left accent and warning-colored icon; expanded view shows the error message
  - Auto-refresh on log writes: `updateActor` hook listens for changes to the backing actor's `transactionLog` flag and triggers a 200 ms-debounced re-render if the window is open
  - GM-only operations: Clear button removes all entries after a DialogV2 confirm prompt; requestId shown in expanded detail only to GMs
  - Sidebar gets a third button: "Transaction Log" (using the `fa-list-check` icon); visibility respects `transactionLogVisibility` setting via `canUserAccessLog`, hidden from players when set to "gm-only"
  - `transaction-log-query.js`: `groupByRequestId` now includes `timeAgo` and `timestampFormatted` on the group object so the template can render row times without extra plumbing
  - Localization: `quartermaster.buttons.log` updated from "Log" to "Transaction Log" for clarity
  - API additions: `ui.openTransactionLog`, `ui.closeTransactionLog`, `ui.isTransactionLogOpen`
- **Currency approval flow (build step 13):**
  - `approval-policy.js`: pure decision functions reading the `currencyApprovalMode` (free / threshold / all-required), `currencyApprovalThreshold`, `useApprovalTimeout`, and `approvalTimeoutSeconds` world settings; GM requests auto-approve (GMs can't approve themselves); threshold mode uses `|delta| >= threshold`
  - `approval-dialog.js`: DialogV2 prompt shown on the active GM with originator name, currency change summary, current and projected vault balance, optional reason, optional countdown timer that auto-denies on timeout, and an insufficient-funds warning when the projected balance would be negative
  - Approval check integrated into `realCurrencyChange` in `socket-handler.js`: runs after zero-delta short-circuit and before the claim entry, so denied requests don't pollute the log with mid-flight claim entries
  - New entry type `currency.denied` with `denialReason` field ("deny" or "timeout"); stored in the transaction log so denials are auditable
  - New result status `"denied"` distinct from `"failed"`: `error: "denied-by-gm"` or `error: "approval-timeout"`; the player UI handles this separately with a `ui.notifications.warn` instead of error toast
  - Player-side: `currency-buttons.js` shows a permanent "waiting for GM approval..." pending toast when `needsApprovalForCurrentUser` returns true; toast dismisses when the result returns (success, denial, or failure)
  - Log window: new "Denied" filter option in the status dropdown; denied entries render with `fa-ban` icon, warning-tinted phase badge, and red border accent like failures
  - `transaction-log-query.js`: `ENTRY_PHASES.DENIED` added; phase rank updated so denied groups display the denied entry as the representative; stats now include `byPhase.denied` count; `hasError` is true for denied entries so the row gets the warning visual
  - `test-step13.js`: 18 tests covering free / all-required / threshold modes, threshold boundary cases (below, at, above), negative deltas in threshold mode, threshold of 0 edge case, GM auto-approve in every mode, runtime threshold changes respected, and timeout config reads; settings snapshot/restore so the suite leaves no persistent change
  - **Bug fix from step 9/12:** transaction log commit and failed entries now carry `userId`, `sourceActorName`, `sourceItemName`, and `destActorName`; previously only the claim entries had these fields, so the log window showed "(unknown item) ← vault" / "(source) to (destination)" for grouped operations because `groupByRequestId` picks the commit (highest phase rank) as the representative and the formatter fell back to placeholder text
  - API additions: `approvalPolicy` namespace, `test.runStep13Tests`
- **Approval dialog close-detection fix (folded into step 14):**
  - The `close` config callback on V14 DialogV2 doesn't reliably fire when the user clicks the header X button or presses Escape; the dialog DOM is removed but the callback is skipped, leaving the approval Promise unresolved until the timeout countdown fires
  - Switched to the `closeDialogV2` Foundry hook, which fires on every close path (button click, X, Escape, programmatic close); the hook is registered before render and torn down inside `finish()` regardless of resolution path
  - Reordered the timeout path: `finish("timeout")` now runs before `dialog.close()` so the closeDialogV2 hook firing from the programmatic close sees `resolved=true` and is a no-op
  - Same hook-based close detection applied to the resource amount picker dialog for consistency
- **Custom resources (build step 14):**
  - `resources.js`: CRUD module for custom resources stored as a flag array on the backing actor; schema `{ id, name, icon, value, max, description, createdAt, order }`; GM-only writes; `applyDelta(id, delta)` validates bounds (insufficient-resource, max-exceeded) and returns a structured envelope
  - `socket-handler.js`: `stubCustomResourceChange` replaced with `realResourceChange` that validates the payload, calls `Resources.applyDelta`, writes claim/commit/failed transaction log entries, no approval flow at this stage (resources are GM-curated)
  - `resource-buttons.js`: +/− button handlers for the inventory popup; shift+click applies ±1 immediately, normal click opens an amount picker dialog with quick-picks (1, 2, 3, 5, 10) and a custom number input; uses the closeDialogV2 hook for reliable close detection
  - `apps/loot-prep-app.js`: rewritten from placeholder; Custom Resources section lists existing resources with icon, name, description, value/max display, edit and delete buttons; "Add Resource" button opens the create-or-edit dialog; auto-refresh hook listens for changes to the `customResources` flag
  - `apps/resource-edit-dialog.js`: dialog for creating or editing a resource with name, icon (with file picker via `foundry.applications.apps.FilePicker.implementation`), current value, max (blank = unbounded), and description; live icon preview as the path changes; validation prevents empty names; closeDialogV2 hook handles cancel paths reliably
  - `inventory-rendering.js`: `buildResources` updated to align with the new schema (was using old `imagePath` / `count` / `sortIndex` field names); display fields include `displayValue` (X or X/Y), `atMax` and `atZero` boolean flags for styling
  - `templates/inventory.hbs`: resources section now shows +/− buttons in each row, uses `displayValue` for X / Y formatting, has hover tooltip with description
  - `templates/loot-prep.hbs`: rewritten with a Custom Resources section (header with Add button, list of rows with icon/name/desc/value/edit/delete) and a Hidden Items placeholder section for step 15
  - `styles/module.css`: added ~250 lines for resource rows (inventory popup), resource management UI (loot prep popup), and the resource edit dialog with icon picker control
  - Localization: existing `quartermaster.buttons.gmLootPrep` reused
  - New transaction log entry types: `resource.claim`, `resource.commit`, `resource.failed`; the existing query module's classifyEntry and formatEntry already handle the "resource" category (formatResource was previously dead code; now it's live)
  - **Step 4 test updates:** test 3 (custom resource stub) now expects routing to the real pipeline with `resource-not-found` error for a fake resourceId; test 6 (idempotency) switched to `CURRENCY_CHANGE` with `delta: 0` since both currency and resource stubs have been replaced and zero-delta currency is the only remaining state-non-mutating path through the dispatcher
  - `test-step14.js`: 30+ tests covering CRUD operations (create, get, update, delete), max-clamp behavior on update, applyDelta for all paths (add, remove, insufficient, max-exceeded, zero delta noop, invalid delta, resource not found), socket pipeline integration, transaction log entry shape, and idempotency via duplicate requestId; snapshots resources flag before mutating, restores in finally block, prunes test log entries
  - API additions: `resources` namespace, `ui.openLootPrep` already existed but now opens a real UI, `test.runStep14Tests`, `test.cleanupStep14Fixtures`
- Sidebar injection stubs (pending step 4 of Build Sequence)


[Unreleased]: https://github.com/Lipton1010/quartermaster/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Lipton1010/quartermaster/compare/v0.1.8...v1.0.0
[0.1.8]: https://github.com/Lipton1010/quartermaster/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Lipton1010/quartermaster/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Lipton1010/quartermaster/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Lipton1010/quartermaster/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Lipton1010/quartermaster/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Lipton1010/quartermaster/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Lipton1010/quartermaster/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Lipton1010/quartermaster/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Lipton1010/quartermaster/releases/tag/v0.1.0
