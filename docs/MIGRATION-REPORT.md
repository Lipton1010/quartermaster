# Quartermaster 1.0.0 Migration Report

## Status

**Live v0.1.8 rehearsal pending.** A fresh isolated v14.365 / D&D 5e 5.3.3 world has exercised schema-1 initialization and storage privacy, but no representative v0.1.8 clone or synthetic legacy fixture has been migrated in Foundry.

This report does not approve migration of a production world. Never test against the only copy of a world or Foundry data directory.

## Migration under review

The v1 migration separates player-readable shared storage from GM-only staging storage. It is intended to copy and verify private legacy data before removing the legacy values, and to advance the storage-schema marker only after the complete migration succeeds.

The review must cover migration from the published v0.1.8 data shape to storage schema 1, including:

- hidden Items and their folder and note flags;
- staged currency and loot-prep folders;
- canonical and player-readable transaction-log projections;
- recovery data;
- visible Items, native and custom balances, exchange configuration, approval settings, resources, user/world settings, and shortcut-token links that should remain available;
- safe restart after an interrupted or failed migration.

## Automated evidence available

On 2026-08-10, the committed candidate completed `npm test` with syntax checks for 79 JavaScript files, all 78/78 tests passing, and the release/system-boundary validator passing. The migration coverage demonstrated successful copy-and-verify behavior, idempotent reruns, staging-marker repair, and recovery after a simulated deletion failure without advancing the shared schema marker prematurely.

That run was headless and used synthetic Actor and Item doubles. It is exact-commit regression evidence accompanied by a validated package, but it is not a live Foundry migration result.

## Fresh-world live evidence (not a migration rehearsal)

An isolated Foundry v14.365 / D&D 5e 5.3.3 world successfully created schema-1 shared and private storage, preserved the privacy boundary during GM hide/reveal and Player2 access checks, and loaded its world databases to `Complete` after a process-level server restart. Browser safety policy prevented a client reconnection after that restart, so module client recovery was not established. Because the world began fresh rather than with v0.1.8 data, none of this proves legacy data preservation, migration idempotency, or interruption recovery in Foundry.

## Live rehearsal record

| Check | Status | Evidence |
| --- | --- | --- |
| Back up or clone a representative v0.1.8 world | Pending | No representative legacy clone or fixture has been prepared. |
| Record pre-migration Items, balances, resources, folders, notes, logs, settings, and token links | Pending | No live inventory captured. |
| Mount the reviewed candidate in the disposable test world | Pending | The feature code was exercised only in a newly created isolated world, not a v0.1.8 rehearsal world. Production installation remains unauthorized. |
| Run first-GM-startup migration | Pending | Fresh schema-1 initialization passed, but no legacy data migration was attempted. |
| Verify shared storage remains player-readable | Pending | Demonstrated only in the fresh smoke world, not after migration. |
| Verify private staging data is inaccessible to players | Pending | Demonstrated for Player2 only in the fresh smoke world, not after migration. |
| Verify all expected data against the pre-migration inventory | Pending | No live result supplied. |
| Interrupt and resume a disposable migration | Pending | Covered only by headless tests so far. |
| Restart Foundry and recheck persistence and idempotency | Pending | The fresh world's databases loaded to `Complete` after restart, but browser safety prevented client reconnection; no post-migration restart was attempted. |

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
| Tester | Pending |
| Date | Pending |
| Platform | Pending |
| Foundry VTT | Pending |
| Game system and version | Pending |
| Candidate commit | Pending |
| Package checksum | Pending |
| Result | Pending |
| Notes or defects | No live result supplied. |

Until this section is completed and reviewed, the migration gate remains closed.
