# Quartermaster

Quartermaster is a system-agnostic shared party inventory and resource ledger for Foundry Virtual Tabletop.

It gives a group one persistent vault for visible items, balances, resources, and an audit trail, plus a private GM staging area for unrevealed loot and recovery records. Quartermaster tracks what the party owns and how that changed over time; it does not replace map-based loot piles, merchants, or treasure chests.

Support development: [Ko-fi](https://ko-fi.com/paulmiscavage)

## v1.0 release-candidate status

This branch prepares Quartermaster 1.0.0. The release gate is currently **closed**. An isolated Foundry v14.365 / D&D 5e 5.3.3 session has produced partial live smoke evidence, but it does not complete that matrix cell. The other five matrix combinations and the live v0.1.8 migration rehearsal remain pending.

Review the [release gate](docs/RELEASE-GATE.md) and [migration report](docs/MIGRATION-REPORT.md) for the exact evidence status. This candidate must not be merged, tagged, installed in a production world, or published until those records are completed and separately approved.

## System support

- **D&D 5e:** full native PP/GP/EP/SP/CP support, item quantity, weight, value, and identification metadata. Existing 500 lb default capacity behavior is preserved.
- **Pathfinder 2e:** native coin support, loot actors, quantity, Bulk, value, identification metadata, and coin-item filtering. Quartermaster separates canonical coin Bulk from the Actor inventory aggregate so optional currency load is not counted twice. Coin Items inside Bulk-reducing containers can make that separation approximate; capacity enforcement is disabled initially, and this case remains a required live check.
- **Other systems:** a safe generic adapter preserves complete Item data and supplies one editable `Currency` (`CUR`) custom balance. Unsupported weight, value, and identification fields are omitted instead of displayed as zero.
- **Third-party integrations:** modules may register adapters during the `quartermaster.registerSystemAdapters` hook or through `game.modules.get("quartermaster").api.system.registerAdapter(...)`.

If a generic system exposes more than one usable Actor type, a GM chooses the vault type during setup. Quartermaster stores that choice for the world and fails safely when no compatible type exists.

## Features

- Shared party inventory available from the Actors sidebar or optional scene shortcut token
- Whole-document Item transfers between the vault and compatible Actors owned by the requesting user
- Support for linked Actors and unlinked Token Actors through document UUIDs
- D&D 5e and PF2e native currency, plus unlimited custom currencies
- Configurable exchange rates, currency visibility, approval thresholds, and optional custom-currency load
- Custom counter resources, inventory sorting, and transaction history
- GM Loot Prep with folders, inherited notes, staged currency, compendium imports, and bulk reveal
- A GM-only staging Actor for hidden loot, notes, canonical logs, and failed-transfer recovery records
- Capacity/load display only when the active system adapter can provide accurate metadata
- Restartable v0.1.8-to-v1 storage migration that copies and verifies data before removing legacy values

Whole Item documents or stacks transfer together. Partial-stack transfers and automatic conversion of a world from one game system to another are outside the v1 scope.

## Requirements

- Foundry VTT v13 or v14
- A game system with at least one Actor type capable of holding embedded Items

The required live matrix covers Foundry v14.365 with D&D 5e 5.3.3, PF2e 8.3.0, and Custom System Builder 6.0.2, plus Foundry v13.351 with D&D 5e 5.3.3, PF2e 7.12.2, and Custom System Builder 5.2.1. The v14.365 / D&D 5e 5.3.3 cell has partial smoke evidence but is not complete; the other five cells are unprovisioned and pending. See the [release gate](docs/RELEASE-GATE.md).

## Installation

After v1.0.0 is reviewed and published, install Quartermaster from Foundry's **Add-on Modules** browser. Its version-specific manifest will be:

```text
https://github.com/Lipton1010/quartermaster/releases/download/v1.0.0/module.json
```

That URL is not release evidence and may not exist until publication. Do not use a feature-branch artifact in a production world. Back up the Foundry data directory before upgrading an existing world.

## Migration and privacy

On first GM startup, v1 creates a player-readable shared vault and a separate GM-only staging Actor. Legacy hidden Items, staged currency, folders, notes, and canonical logs are copied to private storage, verified, and only then removed from their legacy location. A schema marker advances only after the complete migration succeeds, so an interrupted migration can be run again safely. Recovery records are a new v1 concept written when a v1 transfer needs one; v0.1.8 has no recovery data to migrate.

Visible Items, balances, resources, redacted log entries, settings, and shortcut-token links remain available to players as before. Disabling Quartermaster does not delete either storage Actor.

Never test migration against the only copy of a production world. Clone the world or use a synthetic fixture.

## Macro and integration API

The documented inventory macro remains stable:

```js
await game.modules.get("quartermaster").api.ui.openInventory();
```

The existing currency, resource, and transaction-log API facades remain available. Adapter integrations can register during setup:

```js
Hooks.on("quartermaster.registerSystemAdapters", ({ registerAdapter }) => {
  registerAdapter("my-system", myAdapter);
});
```

An adapter registration is versioned and validated; invalid adapters are rejected without replacing the generic fallback.

## Security model

Player mutations use Foundry's authenticated query transport. Quartermaster fails closed if that transport is unavailable; it does not accept unauthenticated raw-socket mutation messages. The active GM re-checks sender identity, ownership, transfer direction, system compatibility, and storage boundaries before changing documents.

Transfers preflight and create the destination Item before deleting the source. If reconciliation cannot complete, the private staging Actor retains a recovery record for a GM.

## Development and release checks

```text
npm test
npm run package
```

On 2026-08-10, the committed candidate passed syntax checks for 80 JavaScript files, all 90/90 headless tests, and the release/system-boundary validator. Headless checks do not replace the live Foundry matrix or migration rehearsal.

The package command writes `artifacts/system-agnostic/module.zip` outside the worktree. It builds from the committed tree, so commit completeness and a clean working tree are part of the gate. The validated candidate archive contained 67 clean entries and emitted a manifest, SHA-256 checksum, and complete file list; exact final-build evidence, including the current commit and checksum, is retained beside the archive in `BUILD-REPORT.md`. Publishing, tagging, installation, and merging are intentionally separate operations.

## Compatibility

Quartermaster can coexist with map-loot modules such as Item Piles because it uses its own Actors and `flags.quartermaster` namespace. Do not configure either Quartermaster storage Actor as an Item Piles pile.

## License

MIT — see [LICENSE](LICENSE).

## Author

Paul Miscavage — [GitHub](https://github.com/Lipton1010)
