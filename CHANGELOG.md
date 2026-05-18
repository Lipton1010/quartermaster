# Changelog

All notable changes to Quartermaster will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-18

Initial pre-release. All core features functional.

### Added

#### Core Infrastructure (steps 2–4)
- Backing actor lifecycle: auto-creation, flag-based recovery, directory suppression, deletion safeguard
- Operation coordinator with per-resource mutex locks, FIFO serialization, ABBA-safe multi-key acquisition, and two-layer idempotency (LRU cache + transaction log)
- Socket pipeline with CONFIG.queries (V13+) primary path and raw socket fallback; authoritative sender identity from Foundry connection context

#### Inventory & Items (steps 5–9)
- Shared Party Inventory popup (ApplicationV2 + HandlebarsApplicationMixin) with capacity bar, currency rail, resource counters, and item list
- Item sanitization pipeline: pre-generated destination IDs, owner-state stripping, module cache cleanup, selective effect origin rewriting
- Weight cache with hook-driven invalidation for efficient re-renders
- Claim-and-Commit transfer engine with direction-specific ordering (delete-first for egress, create-first for ingress) and full item data preserved in claim entries for recovery
- Drag-and-drop: ingress (character sheet → vault), egress (vault → character sheet) with dropActorSheetData hook interception
- Debounced re-rendering with drag-aware deferral; three entry-size variants (compact/medium/large)

#### Currency (steps 10, 13)
- Per-currency +/− buttons with shift+click for ±1; amount picker dialog with quick-pick buttons
- GM approval workflow: free / threshold / all-required modes; DialogV2 approval prompt with countdown timer and auto-deny on timeout
- Denial tracking in transaction log; "waiting for approval" toast on player side

#### Custom Resources (step 14)
- CRUD operations for named counter resources with optional max, icon, and description
- +/− buttons in inventory popup; amount picker dialog
- Resource management UI in GM Loot Prep popup (create, edit, delete)

#### GM Loot Prep (steps 15–16, 18)
- Hidden Items staging pool: drag from compendium, reveal (single/selected/all), delete
- Shift+click Reveal for optional chat announcement
- Compendium integration: drag onto inventory (visible) or Loot Prep (hidden); right-click compendium entries for "Send to Party Inventory" / "Send to GM Staging"
- Inventory GM actions: per-row hide/trash buttons (hover reveal), right-click context menu with "Hide (send to Loot Prep)" and "Delete Item"
- Re-hide drag: drag inventory items back to Loot Prep Hidden Items drop zone

#### Transaction Log (steps 11–12)
- Append-only log with configurable cap (ring-buffer trim); entries grouped by requestId
- Log window with category/phase/search filters, expandable group detail, stats strip
- Entry types: transfer (ingress/egress), currency (claim/commit/failed/denied), resource, hidden (staged/revealed/deleted), import (direct)
- GM-only clear with confirmation; visibility configurable (all users / GM only)

#### Settings & Preferences (step 17)
- Three display settings migrated from world-scope to client-scope: sort order, entry size, hide zero balances
- Per-popup gear icon opening preferences dialogs (inventory: sort/size/zero-balance; transaction log: default filters, auto-expand)
- Three new client-scope settings for transaction log defaults
- Custom hook `quartermaster.preferencesChanged` for live re-render on settings change

#### Documentation (step 19)
- README with feature list, installation, quick start, settings reference, compatibility notes, and Patreon link
- Consolidated CHANGELOG
- CSS consolidation pass: dropdown contrast fix, visual consistency audit

### Changed
- `sortOrder`, `defaultEntrySize`, `hideZeroBalances` settings changed from `scope: "world"` to `scope: "client"` (breaking for pre-release users with off-default values)
