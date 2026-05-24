# Quartermaster

A shared party inventory and currency tracker for the Dungeons & Dragons 5e system on Foundry Virtual Tabletop.

## Status

**v0.1.0 — In development.** Backing actor lifecycle, operation coordinator, socket pipeline, sidebar UI (three buttons), inventory rendering, sanitization, Claim-and-Commit transfer engine, item drag-drop, currency operations with GM approval flow, transaction log window, and custom resources (CRUD + counter UI) are functional (build steps 2 through 14 complete). Hidden items / loot reveal flow (step 15), configuration UI polish (step 16), per-user preferences (step 17), CSS pass (step 18), and final documentation (step 19) pending.

## Features (planned for v1.0)

- Shared party inventory accessible from a sidebar button
- Drag-and-drop item sharing between character sheets and the party stash
- Standard currency tracking (PP, GP, EP, SP, CP) with optional GM approval workflow for changes
- Custom counter-based resources (ammunition, charges, consumables)
- GM Loot Prep tab for staging hidden loot with one-click reveal
- Capacity tracking (Bag of Holding 500 lb default, or unlimited)
- Optional currency weight tracking
- Transaction log of every change for audit and rollback support
- Configurable approval modes: free, threshold-based, or all-required
- Item identification flow integrated with the dnd5e system

## Requirements

- Foundry VTT v13 or newer (verified on v14)
- dnd5e system 5.0.0 or newer (verified on 5.3.3)

## Installation

Manual installation only during pre-release. Once v1.0 is published to the Foundry repository, install via the standard module browser.

Manual install: paste this manifest URL into Foundry's "Install Module" dialog:
```
https://github.com/Lipton1010/quartermaster/releases/latest/download/module.json
```

## Compatibility

- **Tidy 5e Sheets:** Compatible. No integration shim required.
- **Item Piles:** Not yet tested. Likely coexists without conflict since data lives on a private actor.
- **fvtt-party-resources:** Replaces this module. Uninstall party-resources before enabling Quartermaster.

## License

MIT — see LICENSE file.

## Author

Paul Miscavage — [GitHub](https://github.com/Lipton1010)
