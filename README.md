# Quartermaster

A shared party inventory and resource manager for D&D 5e on Foundry Virtual Tabletop.

## When to use Quartermaster

Quartermaster is a persistent party-state ledger. Its primary concern is *what the party currently owns and how that changed over time* — a shared inventory popup, a currency tile, a transaction log. If your group asks questions like "who picked up the wand of magic missiles after the fight in session 7?" or "how much gold did we have before we paid the innkeeper?", Quartermaster is built for that.

It is not a replacement for, and does not compete with, modules that handle world loot on the map (drop-and-pick-up piles, merchant tokens, treasure chests). If you want immersive world loot, use a dedicated loot module like Item Piles alongside Quartermaster — they coexist cleanly (see Compatibility below).

A simple way to think about it:

- **World loot on the map** — what's in this chest, what does the shopkeeper sell — is a job for Item Piles or a similar module.
- **Persistent party state** — what the party owns right now, what the party's currency is, who took what — is a job for Quartermaster.
- **Both at once** is a supported setup.

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

### Standard Installation (Recommended)
Quartermaster is available directly through the Foundry VTT package browser. 
1. In the Foundry VTT Setup menu, navigate to the **Add-on Modules** tab.
2. Click **Install Module**.
3. Search for **Quartermaster** and click **Install**.

### Manual Installation
If you need to install a specific build or are testing a pre-release version, paste this manifest URL into Foundry's "Install Module" dialog:
`https://github.com/Lipton1010/quartermaster/releases/download/v0.1.4/module.json`

## Compatibility

- **Tidy 5e Sheets:** Compatible. No integration shim required.
- **Item Piles:** Compatible. Quartermaster and Item Piles solve different problems and coexist cleanly — different actors, different flag namespaces (`flags.quartermaster.*` vs `flags.item-piles.*`), and different drop hooks (`dropActorSheetData` vs `dropCanvasData`). Recommended setup: use Item Piles for world loot, merchant tokens, and bank vaults on the map; use Quartermaster for the party's persistent shared inventory, currency, and transaction history. **Do not enable Item Piles configuration on the Quartermaster Vault actor** — it is a private storage actor managed by Quartermaster and is not intended to be a pile.
- **fvtt-party-resources:** Replaces this module. Uninstall party-resources before enabling Quartermaster.

## Status

**v0.1.4 — Pre-release.** Core feature set complete: shared party inventory, drag-and-drop item sharing, multi-currency tracking with optional GM approval flow, custom resources, GM Loot Prep (with folders, hidden items, currency staging, and compendium integration), full transaction log, per-user preferences. v1.0 will follow after a period of community testing and feedback, plus the item identification flow and Foundry package listing.

## License

MIT — see LICENSE file.

## Author

Paul Miscavage — [GitHub](https://github.com/Lipton1010)
