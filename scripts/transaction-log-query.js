/**
 * Quartermaster — Transaction Log Query and Formatting (step 11)
 *
 * Builds on top of the raw transaction-log.js storage layer to provide
 * higher-level operations needed by the log window UI (step 12):
 *
 *   - Entry classification (category + phase)
 *   - Display formatting (icons, titles, descriptions, relative times)
 *   - Query helpers (filter by type / user / time range / status, paginate)
 *   - Visibility checks (respect the transactionLogVisibility setting)
 *   - Grouping (cluster claim/commit/failed entries by requestId)
 *   - Stats (counts by category, recent activity)
 *
 * All operations are pure / read-only. The writes happen in
 * transaction-log.js (writeEntry, updateEntry) and the engines that call
 * them (claim-commit.js, currency dispatcher in socket-handler.js).
 *
 * Defensive against missing fields: log entries have varied shapes across
 * the codebase (item transfers, currency, stub test entries from earlier
 * steps). The formatter never throws; it falls back to "unknown" labels.
 */

import { MODULE_ID, SETTINGS, CHOICES } from "./constants.js";
import { getActiveSystemAdapter } from "./system-adapters/registry.js";
import * as TransactionLog from "./transaction-log.js";

// ============================================================
// Classification
// ============================================================

export const ENTRY_CATEGORIES = {
  TRANSFER: "transfer",
  CURRENCY: "currency",
  RESOURCE: "resource",
  HIDDEN:   "hidden",
  IMPORT:   "import",
  UNKNOWN:  "unknown"
};

export const ENTRY_PHASES = {
  CLAIM: "claim",
  COMMIT: "commit",
  FAILED: "failed",
  DENIED: "denied",
  UNKNOWN: "unknown"
};

export const TRANSFER_DIRECTIONS = {
  INGRESS: "ingress",
  EGRESS: "egress",
  UNKNOWN: "unknown"
};

/**
 * Parse the `type` field of a log entry into structured pieces.
 *
 * Examples:
 *   "transfer.ingress.commit" → { category: "transfer", direction: "ingress", phase: "commit" }
 *   "currency.claim"          → { category: "currency", direction: null, phase: "claim" }
 *   undefined                 → { category: "unknown", direction: null, phase: "unknown" }
 */
export function classifyEntry(entry) {
  const type = entry?.type;
  if (typeof type !== "string" || type.length === 0) {
    return {
      category: ENTRY_CATEGORIES.UNKNOWN,
      direction: null,
      phase: ENTRY_PHASES.UNKNOWN
    };
  }

  const parts = type.split(".");
  const head = parts[0];

  if (head === ENTRY_CATEGORIES.TRANSFER) {
    return {
      category: ENTRY_CATEGORIES.TRANSFER,
      direction: parts[1] || TRANSFER_DIRECTIONS.UNKNOWN,
      phase: parts[2] || ENTRY_PHASES.UNKNOWN
    };
  }
  if (head === ENTRY_CATEGORIES.CURRENCY) {
    return {
      category: ENTRY_CATEGORIES.CURRENCY,
      direction: null,
      phase: parts[1] || ENTRY_PHASES.UNKNOWN
    };
  }
  if (head === ENTRY_CATEGORIES.RESOURCE || head === "customResource") {
    return {
      category: ENTRY_CATEGORIES.RESOURCE,
      direction: null,
      phase: parts[1] || ENTRY_PHASES.UNKNOWN
    };
  }
  if (head === ENTRY_CATEGORIES.HIDDEN) {
    return {
      category: ENTRY_CATEGORIES.HIDDEN,
      direction: null,
      phase: parts[1] || ENTRY_PHASES.UNKNOWN
    };
  }
  if (head === ENTRY_CATEGORIES.IMPORT || head === "import") {
    return {
      category: ENTRY_CATEGORIES.IMPORT,
      direction: null,
      phase: parts[1] || ENTRY_PHASES.UNKNOWN
    };
  }
  return {
    category: ENTRY_CATEGORIES.UNKNOWN,
    direction: null,
    phase: ENTRY_PHASES.UNKNOWN
  };
}

// ============================================================
// Formatting
// ============================================================

const ICONS = {
  "transfer.ingress.claim":  "fa-solid fa-arrow-down-to-square",
  "transfer.ingress.commit": "fa-solid fa-arrow-down-to-square",
  "transfer.ingress.failed": "fa-solid fa-triangle-exclamation",
  "transfer.egress.claim":   "fa-solid fa-arrow-up-from-square",
  "transfer.egress.commit":  "fa-solid fa-arrow-up-from-square",
  "transfer.egress.failed":  "fa-solid fa-triangle-exclamation",
  "currency.claim":          "fa-solid fa-coins",
  "currency.commit":         "fa-solid fa-coins",
  "currency.failed":         "fa-solid fa-triangle-exclamation",
  "currency.denied":         "fa-solid fa-ban",
  "currency.revealed":       "fa-solid fa-eye",
  "resource.claim":          "fa-solid fa-flask",
  "resource.commit":         "fa-solid fa-flask",
  "resource.failed":         "fa-solid fa-triangle-exclamation",
  "hidden.staged":           "fa-solid fa-eye-slash",
  "hidden.revealed":         "fa-solid fa-eye",
  "hidden.deleted":          "fa-solid fa-trash",
  "import.direct":           "fa-solid fa-download",
  unknown:                   "fa-solid fa-circle-question"
};

/**
 * Produce a display-ready object for a raw log entry. Never throws;
 * falls back to "Unknown entry" if the entry shape is unrecognizable.
 *
 * @param {Object} entry - raw entry from TransactionLog.readAll
 * @returns {Object} display object with these fields:
 *   raw, timestamp, timestampFormatted, timeAgo,
 *   userId, userName,
 *   requestId,
 *   category, direction, phase, status (= phase),
 *   icon, title, description, amount,
 *   hasError, errorMessage
 */
export function formatEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return {
      raw: entry,
      timestamp: null,
      timestampFormatted: "—",
      timeAgo: "—",
      userId: null,
      userName: "—",
      requestId: null,
      category: ENTRY_CATEGORIES.UNKNOWN,
      direction: null,
      phase: ENTRY_PHASES.UNKNOWN,
      status: ENTRY_PHASES.UNKNOWN,
      icon: ICONS.unknown,
      title: "Unknown entry",
      description: "",
      amount: null,
      hasError: false,
      errorMessage: null
    };
  }

  const { category, direction, phase } = classifyEntry(entry);
  const iconKey = entry.type && ICONS[entry.type] ? entry.type : "unknown";
  const icon = ICONS[iconKey];

  const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : null;
  const userName = resolveUserName(entry.userId);
  const hasError = phase === ENTRY_PHASES.FAILED
    || phase === ENTRY_PHASES.DENIED
    || Boolean(entry.error);

  let title = "Unknown entry";
  let description = "";
  let amount = null;

  if (category === ENTRY_CATEGORIES.TRANSFER) {
    ({ title, description, amount } = formatTransfer(entry, direction, phase));
  } else if (category === ENTRY_CATEGORIES.CURRENCY) {
    ({ title, description, amount } = formatCurrency(entry, phase));
  } else if (category === ENTRY_CATEGORIES.RESOURCE) {
    ({ title, description, amount } = formatResource(entry, phase));
  } else if (category === ENTRY_CATEGORIES.HIDDEN) {
    ({ title, description, amount } = formatHidden(entry, phase));
  } else if (category === ENTRY_CATEGORIES.IMPORT) {
    ({ title, description, amount } = formatImport(entry, phase));
  } else {
    title = entry.operationType
      ? `Operation: ${entry.operationType}`
      : "Unknown entry";
    description = entry.error ? `Error: ${entry.error}` : "";
  }

  return {
    raw: entry,
    timestamp,
    timestampFormatted: formatAbsoluteTime(timestamp),
    timeAgo: formatRelativeTime(timestamp),
    userId: entry.userId ?? null,
    userName,
    requestId: entry.requestId ?? null,
    category,
    direction,
    phase,
    status: phase,
    icon,
    title,
    description,
    amount,
    hasError,
    errorMessage: hasError ? (entry.error ?? null) : null
  };
}

function formatTransfer(entry, direction, phase) {
  const itemName = entry.sourceItemName
    ?? entry.itemData?.name
    ?? "(unknown item)";
  const sourceName = entry.sourceActorName ?? "(source)";
  const destName = entry.destActorName ?? "(destination)";

  let title;
  if (direction === TRANSFER_DIRECTIONS.INGRESS) {
    title = `${itemName} → vault`;
  } else if (direction === TRANSFER_DIRECTIONS.EGRESS) {
    title = `${itemName} ← vault`;
  } else {
    title = `${itemName} transfer`;
  }

  const phaseText = phaseLabel(phase);
  let description = `${sourceName} to ${destName}`;
  if (phase === ENTRY_PHASES.FAILED) {
    description = `${description}; failed: ${entry.error ?? "unknown error"}`;
  } else if (phaseText) {
    description = `${description} (${phaseText})`;
  }

  // Adapter-normalized quantity is recorded on new claims. Pending legacy
  // claims can still be normalized without reading a system path in core.
  let qty = entry.itemQuantity;
  if (!Number.isFinite(qty) && entry.itemData) {
    try { qty = getActiveSystemAdapter().normalizeItem(entry.itemData).quantity; }
    catch { qty = null; }
  }
  const amount = (typeof qty === "number" && qty > 1)
    ? `×${qty}`
    : null;

  return { title, description, amount };
}

function formatCurrency(entry, phase) {
  const type = entry.currencyType ?? "??";
  const symbol = entry.currencySymbol || type.toUpperCase();
  const delta = typeof entry.delta === "number"
    ? entry.delta
    : typeof entry.amount === "number" ? entry.amount : 0;
  const verb = delta > 0 ? "added" : delta < 0 ? "removed" : "no change";
  const abs = Math.abs(delta);

  let title;
  if (phase === ENTRY_PHASES.DENIED) {
    const reqVerb = delta > 0 ? "add" : "remove";
    title = `${abs} ${symbol} ${reqVerb} denied`;
  } else if (delta === 0) {
    title = `${symbol}: no change`;
  } else {
    title = `${abs} ${symbol} ${verb}`;
  }

  let description = "";
  if (phase === ENTRY_PHASES.COMMIT
      && typeof entry.previousValue === "number"
      && typeof entry.newValue === "number") {
    description = `${entry.previousValue} → ${entry.newValue}`;
  } else if (phase === ENTRY_PHASES.FAILED) {
    description = `Failed: ${entry.error ?? "unknown error"}`;
  } else if (phase === ENTRY_PHASES.DENIED) {
    if (entry.denialReason === "timeout") {
      description = "Approval request timed out";
    } else {
      description = "Denied by GM";
    }
  } else {
    description = phaseLabel(phase);
  }

  const amount = `${delta >= 0 ? "+" : ""}${delta} ${symbol}`;

  return { title, description, amount };
}

function formatResource(entry, phase) {
  const id = entry.resourceId ?? "(resource)";
  const delta = typeof entry.delta === "number" ? entry.delta : 0;
  const title = delta === 0
    ? `${id}: no change`
    : `${id}: ${delta > 0 ? "+" : ""}${delta}`;
  const description = phaseLabel(phase);
  const amount = `${delta >= 0 ? "+" : ""}${delta}`;
  return { title, description, amount };
}

function formatHidden(entry, phase) {
  const itemName = entry.itemName ?? "(unknown item)";
  let title;
  switch (phase) {
    case "staged":   title = `${itemName} staged`; break;
    case "revealed": title = `${itemName} revealed`; break;
    case "deleted":  title = `${itemName} deleted`; break;
    default:         title = `${itemName} (hidden op)`;
  }
  const description = phase === "revealed" ? "Revealed to players" :
                      phase === "staged"   ? "Added to hidden pool" :
                      phase === "deleted"  ? "Removed from hidden pool" : "";
  return { title, description, amount: null };
}

function formatImport(entry, phase) {
  const itemName = entry.itemName ?? "(unknown item)";
  const title = `${itemName} imported`;
  const description = "Added from compendium";
  return { title, description, amount: null };
}

function phaseLabel(phase) {
  switch (phase) {
    case ENTRY_PHASES.CLAIM:  return "claim";
    case ENTRY_PHASES.COMMIT: return "commit";
    case ENTRY_PHASES.FAILED: return "failed";
    default: return "";
  }
}

// ============================================================
// Time helpers
// ============================================================

function formatAbsoluteTime(ts) {
  if (typeof ts !== "number") return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/**
 * Relative time string: "just now", "5m ago", "2h ago", "3d ago", or
 * absolute date for older entries. UI-friendly without being chatty.
 */
function formatRelativeTime(ts) {
  if (typeof ts !== "number") return "—";
  const diff = Date.now() - ts;
  if (diff < 0) return "in the future";
  if (diff < 30_000) return "just now";
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  if (diff < 7 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return String(ts);
  }
}

// ============================================================
// User name resolution
// ============================================================

function resolveUserName(userId) {
  if (!userId || typeof userId !== "string") return "—";
  const user = game.users?.get?.(userId);
  if (user?.name) return user.name;
  return `(${userId.slice(0, 6)}…)`;
}

// ============================================================
// Query
// ============================================================

/**
 * Filter and sort log entries by the given options.
 *
 * @param {Object} options
 * @param {Array} [options.source] - source array (default: full log)
 * @param {string|string[]} [options.category] - filter by category
 * @param {string|string[]} [options.phase] - filter by phase
 * @param {string} [options.direction] - filter transfers by direction
 * @param {string} [options.userId] - filter by initiating user
 * @param {string} [options.requestId] - exact requestId match
 * @param {number} [options.since] - timestamp lower bound (ms)
 * @param {number} [options.until] - timestamp upper bound (ms)
 * @param {string} [options.search] - case-insensitive substring match
 *   against title/description/userName (formatted entries used)
 * @param {"asc"|"desc"} [options.sortDir] - sort by timestamp (default desc)
 * @param {number} [options.limit] - max results returned
 * @param {number} [options.offset] - skip first N results
 * @returns {{ entries: Array, total: number, hasMore: boolean }}
 */
export function queryEntries(options = {}) {
  const source = Array.isArray(options.source)
    ? options.source
    : TransactionLog.readAll();

  let formatted = source.map(formatEntry);

  // Filter: category
  if (options.category) {
    const set = toSet(options.category);
    formatted = formatted.filter(e => set.has(e.category));
  }

  // Filter: phase
  if (options.phase) {
    const set = toSet(options.phase);
    formatted = formatted.filter(e => set.has(e.phase));
  }

  // Filter: direction
  if (options.direction) {
    formatted = formatted.filter(e => e.direction === options.direction);
  }

  // Filter: userId
  if (options.userId) {
    formatted = formatted.filter(e => e.userId === options.userId);
  }

  // Filter: requestId (exact)
  if (options.requestId) {
    formatted = formatted.filter(e => e.requestId === options.requestId);
  }

  // Filter: time range
  if (typeof options.since === "number") {
    formatted = formatted.filter(e => e.timestamp != null && e.timestamp >= options.since);
  }
  if (typeof options.until === "number") {
    formatted = formatted.filter(e => e.timestamp != null && e.timestamp <= options.until);
  }

  // Filter: text search
  if (options.search && typeof options.search === "string") {
    const needle = options.search.toLowerCase();
    formatted = formatted.filter(e =>
      e.title.toLowerCase().includes(needle) ||
      e.description.toLowerCase().includes(needle) ||
      e.userName.toLowerCase().includes(needle)
    );
  }

  // Sort by timestamp
  const sortDir = options.sortDir === "asc" ? "asc" : "desc";
  formatted.sort((a, b) => {
    const ta = a.timestamp ?? 0;
    const tb = b.timestamp ?? 0;
    return sortDir === "asc" ? ta - tb : tb - ta;
  });

  const total = formatted.length;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = options.limit !== undefined
    ? Math.max(0, Math.floor(options.limit))
    : total;
  const paged = formatted.slice(offset, offset + limit);
  const hasMore = offset + paged.length < total;

  return { entries: paged, total, hasMore };
}

function toSet(value) {
  if (Array.isArray(value)) return new Set(value);
  return new Set([value]);
}

// ============================================================
// Visibility
// ============================================================

/**
 * Can the given user open/access the log window at all?
 *
 *   - GM: always yes
 *   - Player + visibility="all": yes
 *   - Player + visibility="gm-only": no
 *
 * Defaults to allowing access when the setting is somehow missing,
 * because hiding the log silently is a worse UX than briefly showing
 * something the GM later locks down.
 */
export function canUserAccessLog(user = game.user) {
  if (!user) return false;
  if (user.isGM) return true;

  let visibility;
  try {
    visibility = game.settings.get(MODULE_ID, SETTINGS.TRANSACTION_LOG_VISIBILITY);
  } catch {
    return true;
  }
  return visibility !== CHOICES.LOG_VISIBILITY.GM_ONLY;
}

/**
 * Is a specific entry visible to a specific user?
 *
 * GMs see the full audit log. Players may view the log only when the
 * transactionLogVisibility setting allows it, and hidden loot prep activity is
 * filtered so staged/deleted loot is not spoiled before the GM reveals it.
 */
export function isEntryVisibleToUser(entry, user = game.user) {
  if (!canUserAccessLog(user)) return false;
  if (user?.isGM) return true;

  const { category, phase } = classifyEntry(entry);
  if (category === ENTRY_CATEGORIES.HIDDEN) {
    return phase === "revealed";
  }

  return entry?.visibility !== "gm";
}

/**
 * Convenience: query + visibility filter in one call. Used by the log
 * window UI (step 12).
 */
export function getVisibleEntries(user = game.user, options = {}) {
  if (!canUserAccessLog(user)) {
    return { entries: [], total: 0, hasMore: false, accessDenied: true };
  }

  const source = Array.isArray(options.source)
    ? options.source
    : TransactionLog.readAll();
  const visibleSource = source.filter(entry => isEntryVisibleToUser(entry, user));

  return queryEntries({ ...options, source: visibleSource });
}

// ============================================================
// Grouping (claim/commit/failed → single visual unit)
// ============================================================

/**
 * Cluster formatted entries by requestId so the UI can show one row per
 * logical operation rather than three (claim + commit + failed).
 *
 * Returns an array of groups, sorted by the LATEST timestamp in each
 * group (most recent operations first by default).
 *
 * Each group is shaped:
 *   {
 *     requestId, category, direction,
 *     entries: [formattedClaim, formattedCommit, ...],
 *     latestPhase: "commit" | "failed" | "claim",
 *     latestTimestamp,
 *     userName, userId,
 *     title, description, amount,
 *     hasError, errorMessage
 *   }
 *
 * The group's title/description/amount comes from the most-advanced
 * phase available: commit > failed > claim. That way the row reads
 * coherently even when a transfer is mid-flight or partially failed.
 */
export function groupByRequestId(formattedEntries, { sortDir = "desc" } = {}) {
  const groups = new Map();

  for (const e of formattedEntries) {
    const key = e.requestId ?? `__noid__${e.timestamp}__${Math.random()}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(e);
  }

  const result = [];
  for (const [requestId, entries] of groups.entries()) {
    // Choose the most-advanced entry for representative display
    const order = { commit: 4, denied: 3, failed: 2, claim: 1, unknown: 0 };
    let representative = entries[0];
    for (const e of entries) {
      if ((order[e.phase] ?? 0) > (order[representative.phase] ?? 0)) {
        representative = e;
      }
    }

    const latestTimestamp = entries.reduce(
      (max, e) => Math.max(max, e.timestamp ?? 0),
      0
    );

    result.push({
      requestId: requestId.startsWith("__noid__") ? null : requestId,
      category: representative.category,
      direction: representative.direction,
      entries,
      latestPhase: representative.phase,
      latestTimestamp,
      timeAgo: representative.timeAgo,
      timestampFormatted: representative.timestampFormatted,
      userName: representative.userName,
      userId: representative.userId,
      icon: representative.icon,
      title: representative.title,
      description: representative.description,
      amount: representative.amount,
      hasError: entries.some(e => e.hasError),
      errorMessage: entries.find(e => e.errorMessage)?.errorMessage ?? null
    });
  }

  result.sort((a, b) => {
    return sortDir === "asc"
      ? a.latestTimestamp - b.latestTimestamp
      : b.latestTimestamp - a.latestTimestamp;
  });

  return result;
}

// ============================================================
// Stats
// ============================================================

/**
 * Aggregate counts. Useful for the log window header (e.g., "5 transfers,
 * 12 currency changes, 2 failures") and for diagnostics.
 */
export function getStats(formattedEntries) {
  const list = Array.isArray(formattedEntries)
    ? formattedEntries
    : queryEntries().entries;

  const stats = {
    total: list.length,
    byCategory: {
      [ENTRY_CATEGORIES.TRANSFER]: 0,
      [ENTRY_CATEGORIES.CURRENCY]: 0,
      [ENTRY_CATEGORIES.RESOURCE]: 0,
      [ENTRY_CATEGORIES.HIDDEN]:   0,
      [ENTRY_CATEGORIES.IMPORT]:   0,
      [ENTRY_CATEGORIES.UNKNOWN]:  0
    },
    byPhase: {
      [ENTRY_PHASES.CLAIM]: 0,
      [ENTRY_PHASES.COMMIT]: 0,
      [ENTRY_PHASES.FAILED]: 0,
      [ENTRY_PHASES.DENIED]: 0,
      [ENTRY_PHASES.UNKNOWN]: 0
    },
    byUser: {},
    failures: 0,
    earliest: null,
    latest: null
  };

  for (const e of list) {
    stats.byCategory[e.category] = (stats.byCategory[e.category] ?? 0) + 1;
    stats.byPhase[e.phase] = (stats.byPhase[e.phase] ?? 0) + 1;
    if (e.userId) {
      stats.byUser[e.userId] = (stats.byUser[e.userId] ?? 0) + 1;
    }
    if (e.hasError) stats.failures += 1;
    if (e.timestamp != null) {
      stats.earliest = stats.earliest == null
        ? e.timestamp
        : Math.min(stats.earliest, e.timestamp);
      stats.latest = stats.latest == null
        ? e.timestamp
        : Math.max(stats.latest, e.timestamp);
    }
  }

  return stats;
}
