# Quartermaster

A shared party inventory and resource manager for D&D 5e on Foundry Virtual Tabletop.

Support development: [Ko-fi](https://ko-fi.com/paulmiscavage)

## When to use Quartermaster

Quartermaster is a persistent party-state ledger. Its primary concern is *what the party currently owns and how that changed over time* — a shared inventory popup, a currency tile, a transaction log. If your group asks questions like "who picked up the wand of magic missiles after the fight in session 7?" or "how much gold did we have before we paid the innkeeper?", Quartermaster is built for that.

It is not a replacement for, and does not compete with, modules that handle world loot on the map (drop-and-pick-up piles, merchant tokens, treasure chests). If you want immersive world loot, use a dedicated loot module like Item Piles alongside Quartermaster — they coexist cleanly (see Compatibility below).

A simple way to think about it:

- **World loot on the map** — what's in this chest, what does the shopkeeper sell — is a job for Item Piles or a similar module.
- **Persistent party state** — what the party owns right now, what the party's currency is, who took what — is a job for Quartermaster.
- **Both at once** is a supported setup.

## Features

- Shared party inventory accessible from a sidebar button or optional scene token shortcut
- Drag-and-drop item sharing between character sheets, the party stash, and compendiums
- Multi-currency tracking with PP, GP, EP, SP, CP, and unlimited GM-defined custom currencies
- Per-currency visibility, optional tile images, decimal balances, configurable exchange rates, and optional custom-currency weight
- Configurable approval modes: free, threshold-based, or all-required — with timeout and audit trail
- GM Loot Prep tab with folder organization and inherited folder/item notes for encounter locations
- Currency loot staging for built-in and custom currencies, revealed directly into the shared balance
- One-click or bulk loot reveal; Shift+click reveal posts a chat announcement
- Drag items from Loot Prep or Shared Party Inventory directly to any character-sheet tab or an Actor-directory character entry to distribute loot
- Custom counter resources (ammunition, charges, consumables) with CRUD UI
- Sort-by dropdown: A–Z, By Type with section headers, Loot First, or Manual drag-to-reorder
- Double-click items to open their sheet
- Item value display (GP/SP/CP) on every row
- GM settings to customize the inventory button/window name, add a subtle popup watermark image, hide prices from players, and enable an optional inventory shortcut token
- Full transaction log with filtering, search, grouping by operation, and rollback reference
- Capacity tracking (Bag of Holding 500 lb default, or unlimited)
- Optional currency weight tracking
- Per-user preferences (sort order, entry size, and hide zero balances)

## Requirements

- Foundry VTT v13 or newer (verified on v14.367)
- dnd5e system 5.0.0 or newer (verified on 5.3.3)

## Installation

### Standard Installation (Recommended)
Quartermaster is available directly through the Foundry VTT package browser. 
1. In the Foundry VTT Setup menu, navigate to the **Add-on Modules** tab.
2. Click **Install Module**.
3. Search for **Quartermaster** and click **Install**.

### Manual Installation
If you need to install a specific build or are testing a pre-release version, paste this manifest URL into Foundry's "Install Module" dialog:
`https://github.com/Lipton1010/quartermaster/releases/download/v0.1.11/module.json`

## Macro integration

You can open the Shared Party Inventory from a Foundry macro or a landing-page trigger:

1. Create a new macro and set its type to **Script**.
2. Paste the following code:

```js
await game.modules.get("quartermaster").api.ui.openInventory();
```

3. Run that macro directly, place it on the macro hotbar, or configure another module's trigger to execute it.

The macro works for both players and GMs while Quartermaster is active.

## Compatibility

- **Tidy 5e Sheets:** Compatible. No integration shim required.
- **Actor-directory integrations:** Quartermaster detects directory refreshes from other modules and re-applies its controls and private Vault suppression. Monk's Active Tile Triggers is included in the v0.1.9 live smoke-test matrix.
- **Item Piles:** Compatible. Quartermaster and Item Piles solve different problems and coexist cleanly — different actors, different flag namespaces (`flags.quartermaster.*` vs `flags.item-piles.*`), and different drop hooks (`dropActorSheetData` vs `dropCanvasData`). Recommended setup: use Item Piles for world loot, merchant tokens, and bank vaults on the map; use Quartermaster for the party's persistent shared inventory, currency, and transaction history. **Do not enable Item Piles configuration on the Quartermaster Vault actor** — it is a private storage actor managed by Quartermaster and is not intended to be a pile.
- **fvtt-party-resources:** Replaces this module. Uninstall party-resources before enabling Quartermaster.

## Status

**v0.1.11 — Pre-release.** Core feature set complete: shared party inventory, drag-and-drop item sharing, configurable built-in and custom currency tracking with a selectable reference currency and optional GM approval flow, custom resources, GM Loot Prep (with collapsible folders, inherited notes, hidden items, currency staging, and compendium integration), full transaction log, per-user preferences, configurable display options, and an optional inventory shortcut token. v1.0 will follow after a period of community testing and feedback, plus the item identification flow and Foundry package listing.

## License

MIT — see LICENSE file.

## Author

Paul Miscavage — [GitHub](https://github.com/Lipton1010)
