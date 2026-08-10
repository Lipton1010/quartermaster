# Quartermaster 1.0.0 Release Gate

Quartermaster 1.0.0 is a release candidate. This gate is **closed** until every required check below has reviewable evidence. Nothing in this document authorizes merging, tagging, publication, or installation in a production world.

## Current decision

**Not approved for release.** One isolated Foundry v14.365 / D&D 5e 5.3.3 session has produced substantial partial smoke evidence, but it does not complete that matrix cell. Five other compatibility cells, the live v0.1.8 migration rehearsal, the final committed test run, and committed package evidence remain pending.

## Gate summary

| Gate | Status | Evidence and next action |
| --- | --- | --- |
| Version and system-agnostic manifest | Passed on the final pre-commit working tree | `module.json` reported version `1.0.0`, no system relationship, and a version-specific download URL. Rerun on the final committed candidate. |
| Headless automated suite | Passed on the final pre-commit working tree | On 2026-08-10, `npm test` reported 78/78 tests passed, syntax checks for 79 JavaScript files passed, and the release/system-boundary validator passed. This is not yet exact-commit evidence. |
| Final automated rerun | Pending | Run `npm test` on the exact committed candidate that will be reviewed. Record the commit and complete output. |
| Clean release package | Pending | Run `npm run package` only after the complete candidate is committed. Inspect and retain the validated ZIP, checksum, and file list from that same commit. |
| Live Foundry compatibility matrix | In progress | The v14.365 / D&D 5e 5.3.3 cell has partial smoke evidence but is incomplete. The other five required environments are unprovisioned and pending. |
| Live v0.1.8-to-v1 migration rehearsal | Pending | Use a backed-up clone or a representative synthetic Foundry world. The fresh-world schema initialization described below is not a legacy migration rehearsal. See [MIGRATION-REPORT.md](MIGRATION-REPORT.md). |
| Documentation review | In progress | README and changelog identify the build as unreleased and point to this gate. Final release date and evidence must be added only after approval. |
| Merge, tag, manual installation, and publication | Not authorized | Each remains a separate user-authorized operation after this gate is approved. |

## Required live Foundry matrix

`Partial` means useful live evidence exists but one or more required checks remain incomplete. `Pending` means no matrix result has been supplied. `Unprovisioned` describes the current test environment, not product compatibility.

| Foundry VTT | Game system | Required system version | Test status | Environment | Result notes |
| --- | --- | --- | --- | --- | --- |
| 14.365 | D&D 5e | 5.3.3 | Partial | Isolated local data path | The smoke checks below passed, but post-restart module client recovery and the full cell checklist were not completed. |
| 14.365 | Pathfinder 2e | 8.3.0 | Pending | Unprovisioned | No live result supplied. |
| 14.365 | Custom System Builder | 6.0.2 | Pending | Unprovisioned | No live result supplied. |
| 13.351 | D&D 5e | 5.3.3 | Pending | Unprovisioned | No live result supplied. |
| 13.351 | Pathfinder 2e | 7.12.2 | Pending | Unprovisioned | No live result supplied. |
| 13.351 | Custom System Builder | 5.2.1 | Pending | Unprovisioned | No live result supplied. |

## Partial v14.365 / D&D 5e 5.3.3 evidence

The 2026-08-10 smoke session used a separate Foundry data path under `test-data/v14-dnd5e`; it did not open a production world or modify the installed module. It verified:

- fresh schema-1 initialization and creation of separate shared and private storage Actors;
- storage-Actor suppression from the sidebar and the expected shared, Loot Prep, and transaction-log buttons;
- the D&D 5e `0 / 500 lb` load display and a native GP mutation;
- a GM linked-Actor Item round trip and a player-owned linked-Actor egress;
- GM hide to private staging, Player2 invisibility, and GM reveal back to shared storage;
- Player2 storage privacy and absence of GM-only controls;
- rejection of a hostile same-Actor/direction request as `invalid-transfer-boundary`, with no Item mutation;
- synthetic Token Actor ingress and egress, with the Item returned to its source;
- a healthy client reload before the server restart; and
- a process-level server/world restart whose world databases reached `Complete`.

Browser safety policy prevented reconnecting a client after that process restart. Therefore this evidence does **not** establish post-restart module client recovery, and the matrix cell remains incomplete.

## Minimum live checks for every matrix cell

- Start Foundry with only the required system, Quartermaster, and unavoidable dependencies enabled.
- Create or select compatible storage Actors and open the shared inventory and GM staging interfaces.
- Transfer a complete Item into and out of the vault using both an owned linked Actor and an unlinked Token Actor; confirm source and destination state and the transaction log.
- Exercise the system's native currency path when supported, or the generic `Currency` (`CUR`) balance otherwise.
- Confirm load, value, quantity, and identification fields appear only when the adapter supplies accurate data.
- Confirm a player cannot read private staging Items, notes, canonical logs, or recovery records.
- Submit hostile ownership, direction, same-boundary, and storage-boundary requests; confirm they are rejected without mutation.
- Hide and reveal a representative Item; confirm it moves between shared and private Actors and remains invisible to the player while staged.
- Reload the client, restart the server/world, reconnect a client, and confirm persisted data and module startup remain healthy.
- Record pass/fail, tester, date, platform, clean-console observations, and any deviations in the matrix.

## Final evidence required before approval

1. The final commit identifier and a clean working tree.
2. Complete output from `npm test` on that commit.
3. A validated `artifacts/system-agnostic/module.zip` built from that commit, with its checksum and inspected file list.
4. Results for all six live matrix cells.
5. A completed live migration report for a disposable v0.1.8 world clone or representative synthetic fixture.
6. A dated `1.0.0` changelog entry reviewed against the final diff.
7. Separate, explicit authorization for merge, tag creation, manual installation, and publication.

Automated headless tests support this decision but do not substitute for the live Foundry matrix or migration rehearsal.
