# Quartermaster

A shared party inventory and resource manager for D&D 5e on Foundry Virtual Tabletop.

## Features

- Shared party inventory accessible from a sidebar button
- Drag-and-drop item sharing between character sheets, the party stash, and compendiums
- Multi-currency tracking (PP, GP, EP, SP, CP) with optional GM approval workflow
- Configurable approval modes: free, threshold-based, or all-required — with timeout and audit trail
- GM Loot Prep tab with folder organization by encounter or location
- Currency loot staging — prep GP/SP/CP payouts in Loot Prep, reveal to merge into the vault
- One-click or bulk loot reveal; Shift+click reveal posts a chat announcement
- Drag items from Loot Prep directly to character sheets to distribute loot
- Custom counter resources (ammunition, charges, consumables) with CRUD UI
- Sort-by dropdown: A–Z, By Type with section headers, Loot First, or Manual drag-to-reorder
- Double-click items to open their sheet
- Item value display (GP/SP/CP) on every row
- Full transaction log with filtering, search, grouping by operation, and rollback reference
- Capacity tracking (Bag of Holding 500 lb default, or unlimited)
- Optional currency weight tracking
- Per-user preferences (sort order, entry size, hide zero balances, hide Electrum)

## Requirements

- Foundry VTT v13 or newer (verified on v14.363)
- dnd5e system 5.0.0 or newer (verified on 5.3.3)

## Installation

Manual installation during pre-release. Once v1.0 is published to the Foundry package repository, install via the standard module browser.

Manual install: paste this manifest URL into Foundry's "Install Module" dialog: https://github.com/Lipton1010/quartermaster/releases/download/v0.1.2/module.json

## Compatibility

- **Tidy 5e Sheets:** Compatible. No integration shim required.
- **Item Piles:** Not yet tested. Likely coexists without conflict since data lives on a private backing actor.
- **fvtt-party-resources:** Replaces this module. Uninstall party-resources before enabling Quartermaster.

## Status

v0.1.2 — Active development. Core functionality is complete and stable. Item identification flow and Foundry package listing pending for v1.0.

## License

MIT — see LICENSE file.

## Author

Paul Miscavage — [GitHub](https://github.com/Lipton1010)
