# Quartermaster 1.0.0 Migration Report

## Status

**Live rehearsal on 2026-08-10 against commit `6237480` FAILED; a fix has since landed in commit `523f78801727c283e8c317f275483c766d7e3eac` and re-rehearsal is in progress.** A synthetic v0.1.8 fixture world (isolated v14.365 / D&D 5e 5.3.3, disposable data path) was populated with representative hidden items, loot-prep notes/folders, staged hidden currency (including a fractional amount), a leaked loot-prep flag on an already-visible Item, and transaction-log entries, then upgraded in place to the v1 candidate at commit `6237480bca9ba9d69116216d30da731dbce604ec` (package checksum `5e7f0b7eca6dfe9e63a272c669d02c964615107a6f12f6d3c40e8ffec384c76e`). The automatic first-GM-startup migration **did not complete**: it failed deterministically in the "items" phase with `hidden-item-verification-failed-<itemId>` on the first hidden Item it tried to copy. See "Live rehearsal record" and "Authorized rehearsal result" below for the full evidence and root-cause detail from that run.

The migration failed safely — no source data was deleted and the shared/private actors were left in a consistent, retryable state. Root cause: `verifyMigratedItem` compared a Set-backed system field (e.g. dnd5e's `properties` tag set) with exact array equality, and dnd5e's document-preparation pipeline can benignly round-trip that field with a duplicate entry on `createEmbeddedDocuments` — not data loss, but the strict comparison treated it as one. Commit `523f78801727c283e8c317f275483c766d7e3eac` normalizes primitive-only array fields to deduplicated, order-independent content for this comparison (covered by two new unit tests: one reproducing the exact duplicate-tolerant case, one confirming a genuinely different array value still fails verification). The migration gate remains closed until this fix is re-rehearsed live and confirmed.

This report does not approve migration of a production world. Never test against the only copy of a world or Foundry data directory.

## Migration under review

The v1 migration separates player-readable shared storage from GM-only staging storage. It is intended to copy and verify private legacy data before removing the legacy values, and to advance the storage-schema marker only after the complete migration succeeds.

The review must cover migration from the published v0.1.8 data shape to storage schema 1, including:

- hidden Items and their folder and note flags;
- loot-prep notes and folder assignments left on already-visible Items;
- staged currency and loot-prep folders;
- canonical and player-readable transaction-log projections;
- visible Items, native and custom balances, exchange configuration, approval settings, resources, user/world settings, and shortcut-token links that should remain available;
- safe restart after an interrupted or failed migration.

## Automated evidence available

On 2026-08-10, the committed candidate (`6237480bca9ba9d69116216d30da731dbce604ec`) completed `npm test` with syntax checks for 79 JavaScript files, all 86/86 tests passing, and the release/system-boundary validator passing. The migration coverage demonstrated successful copy-and-verify behavior, idempotent reruns, staging-marker repair, scrubbing of loot-prep notes/folders left on already-visible legacy Items, detection of migrated fractional hidden-currency amounts that a whole-units-only native currency cannot reveal, and recovery after a simulated deletion failure without advancing the shared schema marker prematurely.

That run was headless and used synthetic Actor and Item doubles. It is exact-commit regression evidence accompanied by a validated package, but it is not a live Foundry migration result.

## Fresh-world live evidence (not a migration rehearsal)

An isolated Foundry v14.365 / D&D 5e 5.3.3 world successfully created schema-1 shared and private storage, preserved the privacy boundary during GM hide/reveal and Player2 access checks, and loaded its world databases to `Complete` after a process-level server restart. Browser safety policy prevented a client reconnection after that restart, so module client recovery was not established. Because the world began fresh rather than with v0.1.8 data, none of this proves legacy data preservation, migration idempotency, or interruption recovery in Foundry.

## Live rehearsal record

| Check | Status | Evidence |
| --- | --- | --- |
| Back up or clone a representative v0.1.8 world | Done (substitute) | No real v0.1.8 world exists to clone (the only live data is the user's production campaign, which is off-limits). A clean v0.1.8 module package was rebuilt read-only from tag commit `14ee13c4efbcf9cfdfd71d5b71102d77b9e8b260` via `git archive`, installed into a fresh, isolated Foundry v14.365 data path (`test-data/v14-migration`, port 30002), and used to create a synthetic legacy world (`migration-rehearsal`) bound to D&D 5e 5.3.3. |
| Record pre-migration Items, balances, resources, folders, notes, logs, settings, and token links | Done | Captured via the module's own public API (`game.modules.get('quartermaster').api`) on the single v0.1.8 backing actor "Quartermaster Vault" (`SsBbV5Zl3M8VFfeX`): 5 total Items (3 hidden, 2 visible); 1 loot-prep folder "Dragon Hoard Prep"; 3 staged hidden-currency entries including one fractional amount (2.5 gp, plus 40 sp and 3 pp); native visible currency `pp2 gp85 ep0 sp30 cp12`; 1 custom resource "Rations (party)" 12/20; 3 transaction-log entries. One visible Item ("Masterwork Longsword") was deliberately left carrying stray `lootPrepNote`/`lootPrepFolder` flags to simulate the pre-fix leak scenario. Full inventory JSON preserved for this rehearsal's record. |
| Mount the reviewed candidate in the disposable test world | Done | Foundry was stopped, `Data/modules/quartermaster` in the isolated data path was replaced wholesale with the extracted contents of the validated `artifacts/system-agnostic/module.zip` (SHA-256 verified to match `5e7f0b7eca6dfe9e63a272c669d02c964615107a6f12f6d3c40e8ffec384c76e` both before and after use), and Foundry was relaunched on the same isolated path/port. The Setup screen confirmed Quartermaster now reports version 1.0.0. |
| Run first-GM-startup migration | **FAILED** | On GM login, `ensureStorageActors` created a new private "Quartermaster Staging" actor and began `migrateStorageSchema`. It failed deterministically in the `items` phase with `hidden-item-verification-failed-9YWdBk75W65TiCHU` (the "Ruby Pendant" hidden Item, the first one processed). Root cause identified: `verifyMigratedItem` compares projected `system` data between the cloned source and the newly created staging-actor copy, but creating the Item on the staging actor via `createEmbeddedDocuments` caused dnd5e 5.3.3 to duplicate an entry in the `system.properties` set — source had `properties: ["gear"]`, the staging copy came back `properties: ["gear","gear"]` — so `deepEqual` failed. This reproduced identically (`attempts: 2`, same error, same phase) after a full Foundry process restart, confirming it is deterministic, not a race. Module runtime (`Runtime mutation and UI hooks`) remained disabled for the rest of the session as a result, per the console warning logged. |
| Verify shared storage remains player-readable | Blocked | Not reached — the migration never advanced past the first hidden Item, so the shared/private split and post-migration read paths were never exercised. |
| Verify private staging data is inaccessible to players | Blocked | Not reached, for the same reason. |
| Verify all expected data against the pre-migration inventory | **FAILED** | Cannot be verified as migrated: the backing actor still holds all 5 original Items, the original 3 hidden-currency entries (2.5 gp fractional included), and the original 3 transaction-log entries, because the migration aborted before touching them (fails safe — no data was lost or corrupted). The private staging actor holds exactly one partially-migrated, verification-failing copy of "Ruby Pendant" and nothing else. |
| Interrupt and resume a disposable migration | Not attempted | Skipped given the base migration path was already blocking; the nice-to-have interruption rehearsal was not pursued. |
| Restart Foundry and recheck persistence and idempotency | Partially done | The full Foundry process was stopped and relaunched once, and the GM logged back in. The migration re-ran automatically, failed identically (attempt counter advanced 1 → 2, same phase and error), and — importantly — did **not** create a duplicate staging Item or lose/duplicate any backing-actor data on retry. So the restart-safety/no-duplication property held even under this failure, but true post-success persistence/idempotency (schema marker advancing once and staying put) could not be exercised because the migration never succeeded. |

## Procedure for the authorized rehearsal

1. Copy the world and its relevant Foundry data to a disposable test location; record the backup path and checksum or timestamp.
2. On v0.1.8, inventory the shared vault, hidden loot, currencies, resources, folders, notes, transaction logs, settings, and shortcut token links. Capture counts and representative values without including private campaign content in public evidence.
3. Install the exact validated v1 candidate only in the disposable environment.
4. Start the world as a GM and retain the console and server logs.
5. Compare post-migration shared and private storage with the pre-migration inventory. Verify that private records are absent from player-readable storage and views.
6. Reopen the world as both GM and player, exercise representative transfers and balances, and restart Foundry once more.
7. If testing interruption, use another disposable copy. Confirm the schema marker remains unset after failure and that a rerun completes without duplicate records.
8. Record tester, date, platform, Foundry version, system/version, candidate commit, package checksum, outcome, and any anomalies below.

## Authorized rehearsal result

| Field | Value |
| --- | --- |
| Tester | background verification agent |
| Date | 2026-08-10 |
| Platform | Windows 11 Pro (10.0.26200), local machine |
| Foundry VTT | v14 Build 365, isolated data path `test-data/v14-migration`, port 30002 |
| Game system and version | dnd5e 5.3.3 |
| Candidate commit | 6237480bca9ba9d69116216d30da731dbce604ec |
| Package checksum | 5e7f0b7eca6dfe9e63a272c669d02c964615107a6f12f6d3c40e8ffec384c76e (verified via `sha256sum` before and after use) |
| Result | **FAIL** |
| Notes or defects | Blocking defect: `migrateStorageSchema`'s per-item `verifyMigratedItem` check fails deterministically on hidden dnd5e Items whose `system.properties` set is non-empty (e.g. `["gear"]`). Recreating the Item on the staging actor via `createEmbeddedDocuments(..., {keepId:true})` causes dnd5e 5.3.3 to duplicate an existing entry in that `SetField` (`["gear"] → ["gear","gear"]`), so the exact-shape `deepEqual` comparison against the cloned source data fails and the migration throws `hidden-item-verification-failed-<itemId>` in the `items` phase. Confirmed deterministic across a full process restart (attempt 1 and attempt 2 failed identically on the same item). No data loss occurred — the shared backing actor retained all original Items, hidden-currency entries (including the 2.5 gp fractional entry), and transaction-log entries; the private staging actor was left with exactly one non-duplicated, still-failing partial copy, so retries do not accumulate duplicates. Because the migration never completes, none of the following could be exercised in this rehearsal: shared-vault player-readability post-migration, private-staging inaccessibility to players, loot-prep-note/folder scrubbing from the shared visible Item ("Masterwork Longsword"), the fractional-currency-warning surfacing (`migrationState.fractionalCurrencyWarnings`), transaction-log projection, or the schema-version-advance/idempotency-after-success checks. Recommend the fix normalize/deduplicate Set-type system fields (or compare via a system-aware/tolerant diff) before the exact-equality verification, then re-run this full rehearsal end to end. |

Until this section is completed and reviewed, the migration gate remains closed.
