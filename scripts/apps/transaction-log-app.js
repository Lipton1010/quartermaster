/**
 * Quartermaster — Transaction Log Window (step 17)
 *
 * Step 17 adds:
 *   - Header gear icon for per-user log preferences
 *   - Default filters read from client settings on each window open
 *   - Auto-expand groups option (first render only)
 *   - Live re-render when preferences change
 */

import { MODULE_ID, MODULE_TITLE, FLAGS, SETTINGS, HOOKS } from "../constants.js";
import { getBackingActor } from "../backing-actor.js";
import * as Query from "../transaction-log-query.js";
import * as TransactionLog from "../transaction-log.js";
import { promptTransactionLogPreferences } from "./preferences-dialog.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class TransactionLogApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "quartermaster-transaction-log",
    classes: ["quartermaster", "quartermaster-log"],
    tag: "section",
    window: {
      title: "Transaction Log",
      icon: "fa-solid fa-list-check",
      resizable: true,
      minimizable: true
    },
    position: {
      width: 760,
      height: 640
    },
    actions: {
      refresh:            TransactionLogApp.onRefresh,
      "clear-log":        TransactionLogApp.onClearLog,
      "open-preferences": TransactionLogApp.onOpenPreferences
    }
  };

  static PARTS = {
    body: {
      template: "modules/quartermaster/templates/transaction-log.hbs",
      classes: ["quartermaster-log-body"]
    }
  };

  /** Filter state — initialized from settings on construction */
  filters = {
    category: game.settings.get(MODULE_ID, SETTINGS.LOG_DEFAULT_CATEGORY_FILTER),
    phase:    game.settings.get(MODULE_ID, SETTINGS.LOG_DEFAULT_PHASE_FILTER),
    search:   ""
  };

  /** RequestIds of currently-expanded groups */
  expandedGroups = new Set();

  /** Sentinel: auto-expand runs once on first render, not after user collapses */
  _autoExpandApplied = false;

  /** Focus restoration state */
  _restoreFocusOnRender = false;
  _restoreCursorPos = 0;

  _getHeaderControls() {
    const controls = super._getHeaderControls?.() ?? [];
    controls.push({
      icon: "fa-solid fa-gear",
      label: "Preferences",
      action: "open-preferences"
    });
    return controls;
  }

  async _prepareContext(options) {
    const allFormatted = Query.getVisibleEntries(game.user, {}).entries;

    const queryOptions = {};
    if (this.filters.category !== "all") queryOptions.category = this.filters.category;
    if (this.filters.phase !== "all") queryOptions.phase = this.filters.phase;
    if (this.filters.search) queryOptions.search = this.filters.search;
    const filtered = Query.getVisibleEntries(game.user, queryOptions).entries;

    const groups = Query.groupByRequestId(filtered).map(g => ({
      ...g,
      expanded: g.requestId && this.expandedGroups.has(g.requestId)
    }));

    // Auto-expand all groups on first render if preference is set
    if (!this._autoExpandApplied) {
      this._autoExpandApplied = true;
      let autoExpand = false;
      try {
        autoExpand = game.settings.get(MODULE_ID, SETTINGS.LOG_AUTO_EXPAND_GROUPS);
      } catch (err) {
        console.warn(`${MODULE_TITLE} | could not read auto-expand setting`, err);
      }
      console.debug(`${MODULE_TITLE} | auto-expand check: setting=${autoExpand}, groups=${groups.length}, expandedGroups.size=${this.expandedGroups.size}`);
      if (autoExpand && this.expandedGroups.size === 0 && groups.length > 0) {
        for (const g of groups) {
          if (g.requestId) this.expandedGroups.add(g.requestId);
        }
        // Re-map expanded state after populating the set
        for (let i = 0; i < groups.length; i++) {
          groups[i].expanded = groups[i].requestId ? this.expandedGroups.has(groups[i].requestId) : false;
        }
        console.debug(`${MODULE_TITLE} | auto-expanded ${this.expandedGroups.size} groups`);
      }
    }

    const stats = Query.getStats(allFormatted);

    // Pre-compute selected flags for template (avoids reliance on Handlebars eq helper)
    const cat = this.filters.category;
    const ph  = this.filters.phase;
    const categorySelected = {
      all: cat === "all", transfer: cat === "transfer", currency: cat === "currency",
      resource: cat === "resource", hidden: cat === "hidden", import: cat === "import", unknown: cat === "unknown"
    };
    const phaseSelected = {
      all: ph === "all", commit: ph === "commit", failed: ph === "failed",
      denied: ph === "denied", claim: ph === "claim"
    };

    return {
      groups,
      hasEntries: groups.length > 0,
      groupCount: groups.length,
      singleGroup: groups.length === 1,
      filteredEntryCount: filtered.length,
      grandTotal: allFormatted.length,
      stats,
      filters: this.filters,
      categorySelected,
      phaseSelected,
      filterActive:
        this.filters.category !== "all" ||
        this.filters.phase !== "all" ||
        Boolean(this.filters.search),
      isGM: game.user.isGM,
      moduleTitle: MODULE_TITLE
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._wireFilters();
    this._wireRowClicks();
    this._restoreFocus();
  }

  _wireFilters() {
    const root = this.element;
    if (!root) return;

    const catSelect = root.querySelector("[name='category']");
    if (catSelect) {
      catSelect.addEventListener("change", (event) => {
        this.filters.category = event.target.value;
        this.render();
      });
    }

    const phaseSelect = root.querySelector("[name='phase']");
    if (phaseSelect) {
      phaseSelect.addEventListener("change", (event) => {
        this.filters.phase = event.target.value;
        this.render();
      });
    }

    const searchInput = root.querySelector("[name='search']");
    if (searchInput) {
      searchInput.addEventListener("input", (event) => {
        if (this._searchDebounce) clearTimeout(this._searchDebounce);
        const value = event.target.value;
        const cursor = event.target.selectionStart ?? value.length;
        this._searchDebounce = setTimeout(() => {
          if (this.filters.search === value) return;
          this.filters.search = value;
          this._restoreFocusOnRender = true;
          this._restoreCursorPos = cursor;
          this.render();
        }, 250);
      });
    }
  }

  _wireRowClicks() {
    const root = this.element;
    if (!root) return;

    const rows = root.querySelectorAll(".qm-log-row[data-request-id]");
    for (const row of rows) {
      row.addEventListener("click", (event) => {
        if (event.target.closest("button, a")) return;
        const requestId = row.dataset.requestId;
        if (!requestId) return;
        if (this.expandedGroups.has(requestId)) {
          this.expandedGroups.delete(requestId);
        } else {
          this.expandedGroups.add(requestId);
        }
        this.render();
      });
    }
  }

  _restoreFocus() {
    if (!this._restoreFocusOnRender) return;
    const searchInput = this.element?.querySelector("[name='search']");
    if (searchInput) {
      searchInput.focus();
      const pos = Math.min(this._restoreCursorPos, searchInput.value.length);
      try { searchInput.setSelectionRange(pos, pos); } catch {}
    }
    this._restoreFocusOnRender = false;
  }

  // ============================================================
  // Action handlers
  // ============================================================

  static async onRefresh(event, target) {
    this.render();
  }

  static async onClearLog(event, target) {
    if (!game.user.isGM) {
      ui.notifications.warn("Only the GM can clear the transaction log.");
      return;
    }

    const total = Query.queryEntries({}).total;
    const confirmed = await DialogV2.confirm({
      window: { title: "Clear Transaction Log" },
      content: `
        <p>This will permanently delete <strong>${total}</strong> log entries.
        This action cannot be undone.</p>
        <p>Continue?</p>
      `,
      rejectClose: false,
      modal: true
    });

    if (!confirmed) return;

    try {
      await TransactionLog.clear();
      this.expandedGroups.clear();
      this.render();
      ui.notifications.info("Transaction log cleared.");
    } catch (err) {
      console.error(`${MODULE_TITLE} | clear log failed`, err);
      ui.notifications.error("Failed to clear log. Check console.");
    }
  }

  static async onOpenPreferences(event, target) {
    const saved = await promptTransactionLogPreferences();
    if (saved) {
      // Re-read defaults into current filters
      this.filters.category = game.settings.get(MODULE_ID, SETTINGS.LOG_DEFAULT_CATEGORY_FILTER);
      this.filters.phase    = game.settings.get(MODULE_ID, SETTINGS.LOG_DEFAULT_PHASE_FILTER);
      // Reset auto-expand sentinel so the new setting takes effect
      this._autoExpandApplied = false;
      this.expandedGroups.clear();
      this.render();
    }
  }
}

// ============================================================
// Singleton management
// ============================================================

let _instance = null;

export async function openTransactionLogApp() {
  if (!Query.canUserAccessLog(game.user)) {
    ui.notifications.warn(
      `${MODULE_TITLE}: you don't have permission to view the transaction log.`
    );
    return null;
  }
  // Fresh instance each open so settings re-read from client storage
  if (_instance) {
    try { await _instance.close(); } catch {}
  }
  _instance = new TransactionLogApp();
  await _instance.render({ force: true });
  return _instance;
}

export async function closeTransactionLogApp() {
  if (_instance) {
    try { await _instance.close(); } catch {}
    _instance = null;
  }
}

export function isTransactionLogAppOpen() {
  return Boolean(_instance?.element?.isConnected);
}

// ============================================================
// Auto-refresh on log writes
// ============================================================

let _refreshTimer = null;

function scheduleLogRefresh() {
  if (!isTransactionLogAppOpen()) return;
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    if (isTransactionLogAppOpen()) _instance.render();
  }, 200);
}

export function registerLogRefreshHooks() {
  Hooks.on("updateActor", (actor, changes) => {
    const backing = getBackingActor();
    if (!backing || actor.id !== backing.id) return;
    if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAGS.TRANSACTION_LOG}`)) {
      scheduleLogRefresh();
    }
  });

  // Path B: re-render when preferences change from any source
  Hooks.on(HOOKS.PREFERENCES_CHANGED, () => {
    scheduleLogRefresh();
  });
}
