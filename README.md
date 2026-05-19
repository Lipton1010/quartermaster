# Quartermaster

An `ApplicationV2`-native shared party inventory and resource manager for Foundry VTT (dnd5e).

[Support Development on Patreon 🪙](https://patreon.com/Lipton101) | [Report a Bug](https://github.com/Lipton1010/quartermaster/issues)

**v0.1.0** · Foundry VTT v13–v14 · dnd5e 5.0.0+

---

## Features

- **Shared Party Inventory** — a sidebar-accessible popup showing all items, currencies, and custom resources in the party vault
- **Drag-and-Drop Item Sharing** — drag items between character sheets and the vault; drag from compendium directories directly into the inventory or GM staging
- **Currency Tracking** — standard D&D 5e currencies (PP, GP, EP, SP, CP) with per-tile +/− buttons; shift+click for quick ±1 adjustments
- **GM Approval Workflow** — configurable approval modes for currency changes: free, threshold-based, or all-required; includes optional timeout with auto-deny
- **Custom Resources** — create named counters (ammunition, charges, consumables) with optional max values, icons, and descriptions
- **GM Loot Prep** — stage hidden loot from compendiums; reveal items to players individually, in bulk, or all at once; optional chat announcements on reveal
- **Compendium Integration** — drag compendium items onto the inventory or Loot Prep; right-click compendium entries for "Send to Party Inventory" or "Send to GM Staging"
- **Transaction Log** — auditable record of every change (transfers, currency, resources, imports, reveals) with filtering by category, phase, and search; GM-only clear
- **Per-User Preferences** — each player controls their own sort order, entry size, and zero-balance visibility via a gear icon on each popup
- **Capacity Tracking** — configurable weight limit (default 500 lb) with a visual capacity bar; optional currency weight
- **Item Identification** — respects dnd5e identification state; configurable display modes (unidentified name, identified name, or per-item GM override)

## Requirements

- Foundry VTT v13 or newer (verified on v14.361)
- dnd5e system 5.0.0 or newer (verified on 5.3.3)

## Installation

**Manual install** (pre-release): paste this manifest URL into Foundry's "Install Module" dialog:

```
https://github.com/Lipton1010/quartermaster/releases/latest/download/module.json
```

Once published to the Foundry module repository, install via the standard module browser.

## Quick Start

1. Enable the module in your world's Module Management screen
2. The backing actor ("Dragon of Icespire Peak" or auto-created) appears in the Actors sidebar — Quartermaster hides it automatically
3. Three buttons appear at the top of the Actors directory:
   - **Shared Party Inventory** — open the main inventory popup (all users)
   - **GM Loot Prep** — open the staging/reveal popup (GM only)
   - **Transaction Log** — view the audit trail (visibility configurable)
4. Drag items from character sheets onto the inventory to deposit; drag items out to withdraw
5. Use the +/− buttons on currency tiles and resource counters, or shift+click for ±1
6. GMs can drag compendium items directly into the inventory or the Loot Prep staging area

## Settings

All settings are accessible via Foundry's Module Settings panel. Key options:

| Setting | Scope | Default | Description |
|---------|-------|---------|-------------|
| Enforce Capacity | World | On | Enable weight-based capacity tracking |
| Capacity Limit | World | 500 lb | Maximum weight the vault can hold |
| Currency Approval Mode | World | All Required | Free / Threshold / All Required |
| Transaction Log Visibility | World | All Users | Who can view the transaction log |
| Sort Order | Per-user | Currencies First | Inventory sort preference |
| Entry Size | Per-user | Medium | Compact / Medium / Large row display |
| Hide Zero Balances | Per-user | Off | Hide currencies with zero balance |

## Compatibility

- **Tidy 5e Sheets:** Compatible. No integration shim required.
- **Item Piles:** Not yet tested. Likely coexists without conflict since data lives on a private actor.
- **fvtt-party-resources:** Replaces this module. Uninstall party-resources before enabling Quartermaster.

## Architecture

Quartermaster is built on a claim-and-commit transaction engine with GM-authoritative writes. All mutations route through an operation coordinator with per-resource mutex locks, idempotency caching, and a socket pipeline that supports both Foundry V13+ CONFIG.queries and raw socket fallback. The backing actor is a standard Foundry Actor document with module flags — no external databases, no server-side code, no network dependencies beyond Foundry itself.

## License

MIT — see [LICENSE](LICENSE) file.

## Author

Paul Miscavage — [GitHub](https://github.com/Lipton1010) · [Patreon](https://patreon.com/Lipton101)

---

## Support the Project 🪙

Quartermaster is completely free, open-source, and built to deliver a lightweight, secure inventory experience without sacrificing your game's performance.

If Quartermaster saved you an inventory headache and you want to support active development, consider becoming a patron! Membership directly funds the fast-tracking of advanced premium features, including:

* **Multiple Custom Stash Containers** (Wagons, Bags of Holding, Stronghold Vaults)
* **Asynchronous Transaction Log Restoration** (One-click "Undo" for items and currency)
* **Custom UI Themes & Skins**

👉 [Support Quartermaster on Patreon](https://patreon.com/Lipton101)

---

*Quartermaster is independent fan content authorized under the Foundry VTT EULA. Item mechanics are system-agnostic and do not include or distribute copyrighted Wizards of the Coast content.*
