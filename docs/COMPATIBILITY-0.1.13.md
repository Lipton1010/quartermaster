# Quartermaster v0.1.13 compatibility verification

Verified on 2026-11-06 against the installed stable Foundry VTT 14.370 and D&D 5e 6.0.6. Testing used a disposable copy of the existing isolated test world, with separate GM and Player2 browser contexts. Production world data was not used or changed.

## Source comparison

Trail-code queries used Quartermaster's indexed stable scripts and the supplied Foundry reference graph captured on 2026-11-06. The indexed stable scripts matched the current `main` checkout after normalizing line endings. SHA-256 checks confirmed the reference graph's core ApplicationV2, DialogV2, ActorSheetV2, and User sources matched the installed runtime.

Foundry's native query dispatcher invokes `CONFIG.queries[queryName](queryData, { ...queryOptions, user })`. Quartermaster previously read only `options.userId`, then fell back to the receiving GM. A real player currency request bypassed the configured all-required approval policy and was logged as the GM. The fix reads `options.user.id` first and preserves the existing legacy fallbacks. It does not change the raw-socket fallback or claim to harden older transports.

Sources: [Foundry 14.370 release notes](https://foundryvtt.com/releases/14.370), [D&D 5e 6.0.6 release](https://github.com/foundryvtt/dnd5e/releases/tag/release-6.0.6).

## Runtime suites

| Suite | Passed |
| --- | ---: |
| 3 | 10 |
| 4 | 10 |
| 7 | 44 |
| 8 | 52 |
| 9 | 20 |
| 10 | 25 |
| 11 | 53 |
| 13 | 21 |
| 14 | 34 |
| 15 | 33 |
| 16 | 13 |
| 17 | 26 |
| 18 | 16 |
| **Total** | **357** |

The added Step 4 regression calls the registered query handler with a native player User, a conflicting legacy sender ID, and a conflicting payload ID. It checks the persisted operation's requester. It failed on v0.1.12 and passed after the fix.

## Separate-client checks

- An all-required player currency request claiming the GM's payload ID still displayed Player2 in the GM approval dialog. Denial returned `denied-by-gm`, logged Player2, and wrote no currency commit.
- An approved player currency request changed the balance once and attributed its claim, commit, and operation result to Player2.
- Player Item ingress removed the complete stack from the character and created one sanitized copy in the vault.
- A marked Item drop dispatched onto the character sheet's Details tab returned the complete stack to the character: one destination copy, zero vault copies, quantity preserved at two.
- Inventory, Loot Prep, Transaction Log, and the Actors-directory controls rendered successfully.

The release package uses an explicit runtime/documentation allowlist. Git history, editor state, test-world databases, and development artifacts are excluded. Foundry v13's existing minimum remains unchanged; this release does not claim a fresh v13 test pass.
