/**
 * Quartermaster — Step 11 Test Harness
 *
 * Pure-function tests for transaction-log-query.js: classification,
 * formatting, queries, grouping, stats, and visibility.
 *
 * No Foundry document mutations. Test fixtures are plain entry objects
 * matching the shapes produced by:
 *   - claim-commit.js (transfer entries)
 *   - socket-handler.js realCurrencyChange (currency entries)
 *   - legacy step 3 / 4 tests (untyped entries)
 *
 * Run from console:
 *   await game.modules.get("quartermaster").api.test.runStep11Tests();
 */

import { MODULE_TITLE } from "./constants.js";
import {
  classifyEntry,
  formatEntry,
  queryEntries,
  canUserAccessLog,
  isEntryVisibleToUser,
  getVisibleEntries,
  groupByRequestId,
  getStats,
  ENTRY_CATEGORIES,
  ENTRY_PHASES,
  TRANSFER_DIRECTIONS
} from "./transaction-log-query.js";

// ============================================================
// Fixture entries
// ============================================================

const NOW = Date.now();
const T = (offsetMs) => NOW + offsetMs;

function makeFixtures() {
  const userA = game.user.id; // current user (GM in tests)
  const userB = "user-fake-id-bbbbbbbbbbbbbbbb";

  return [
    // Item ingress: claim + commit pair
    {
      type: "transfer.ingress.claim",
      requestId: "qm-test-ingress-1",
      userId: userA,
      timestamp: T(-60_000),
      sourceActorId: "playerA",
      sourceActorName: "Patrick Mossblade",
      destActorId: "vault",
      destActorName: "Quartermaster Vault",
      sourceItemId: "src1",
      sourceItemName: "Shortbow",
      destItemId: "dst1",
      itemData: { name: "Shortbow", system: { quantity: 1 } }
    },
    {
      type: "transfer.ingress.commit",
      requestId: "qm-test-ingress-1",
      userId: userA,
      timestamp: T(-59_500),
      sourceActorName: "Patrick Mossblade",
      destActorName: "Quartermaster Vault",
      sourceItemName: "Shortbow"
    },

    // Item egress: claim + commit
    {
      type: "transfer.egress.claim",
      requestId: "qm-test-egress-1",
      userId: userB,
      timestamp: T(-30_000),
      sourceActorName: "Quartermaster Vault",
      destActorName: "Father Ashton",
      sourceItemName: "Healing Potion",
      itemData: { name: "Healing Potion", system: { quantity: 3 } }
    },
    {
      type: "transfer.egress.commit",
      requestId: "qm-test-egress-1",
      userId: userB,
      timestamp: T(-29_500),
      sourceActorName: "Quartermaster Vault",
      destActorName: "Father Ashton",
      sourceItemName: "Healing Potion"
    },

    // Item ingress that failed
    {
      type: "transfer.ingress.claim",
      requestId: "qm-test-fail-1",
      userId: userA,
      timestamp: T(-20_000),
      sourceActorName: "Tommi Gaidra",
      destActorName: "Quartermaster Vault",
      sourceItemName: "Cursed Amulet"
    },
    {
      type: "transfer.ingress.failed",
      requestId: "qm-test-fail-1",
      userId: userA,
      timestamp: T(-19_500),
      sourceItemName: "Cursed Amulet",
      error: "sanitization-rejected"
    },

    // Currency: add 50 gp
    {
      type: "currency.claim",
      requestId: "qm-test-cur-add",
      userId: userA,
      timestamp: T(-10_000),
      currencyType: "gp",
      delta: 50,
      previousValue: 100
    },
    {
      type: "currency.commit",
      requestId: "qm-test-cur-add",
      userId: userA,
      timestamp: T(-9_500),
      currencyType: "gp",
      delta: 50,
      previousValue: 100,
      newValue: 150
    },

    // Currency: remove 30 gp
    {
      type: "currency.claim",
      requestId: "qm-test-cur-remove",
      userId: userB,
      timestamp: T(-5_000),
      currencyType: "gp",
      delta: -30,
      previousValue: 150
    },
    {
      type: "currency.commit",
      requestId: "qm-test-cur-remove",
      userId: userB,
      timestamp: T(-4_500),
      currencyType: "gp",
      delta: -30,
      previousValue: 150,
      newValue: 120
    },

    // Legacy / untyped entry (e.g., step 4 stub-era)
    {
      requestId: "qm-step4-legacy",
      timestamp: T(-2_000),
      operationType: "currencyChange",
      userId: userA
    }
  ];
}

// ============================================================
// Test runner
// ============================================================

function makeTestContext() {
  const results = [];
  return {
    results,
    assert(name, condition, details = null) {
      results.push({ name, pass: Boolean(condition), details });
    },
    assertEq(name, actual, expected) {
      const pass = JSON.stringify(actual) === JSON.stringify(expected);
      results.push({
        name,
        pass,
        details: pass ? null : { actual, expected }
      });
    }
  };
}

function printResults(label, results) {
  console.group(`%c${label}`, "font-weight: bold; color: #c9a96e;");
  for (const r of results) {
    if (r.pass) {
      console.log(`%c✓%c ${r.name}`, "color: #4caf50;", "color: inherit;");
    } else {
      console.error(`✗ ${r.name}`, r.details ?? "");
    }
  }
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const all = passed === total;
  console.log(
    `%c${passed}/${total} ${all ? "passed" : "PASSED, " + (total - passed) + " FAILED"}`,
    `font-weight: bold; color: ${all ? "#4caf50" : "#c0392b"};`
  );
  console.groupEnd();
}

// ============================================================
// Tests
// ============================================================

export async function runStep11Tests() {
  const t = makeTestContext();
  const fixtures = makeFixtures();

  // ---------- classifyEntry ----------

  t.assertEq("classify transfer.ingress.commit",
    classifyEntry({ type: "transfer.ingress.commit" }),
    { category: "transfer", direction: "ingress", phase: "commit" }
  );

  t.assertEq("classify transfer.egress.claim",
    classifyEntry({ type: "transfer.egress.claim" }),
    { category: "transfer", direction: "egress", phase: "claim" }
  );

  t.assertEq("classify currency.commit",
    classifyEntry({ type: "currency.commit" }),
    { category: "currency", direction: null, phase: "commit" }
  );

  t.assertEq("classify untyped legacy entry",
    classifyEntry({ requestId: "x" }),
    { category: "unknown", direction: null, phase: "unknown" }
  );

  t.assertEq("classify entry with null entry",
    classifyEntry(null),
    { category: "unknown", direction: null, phase: "unknown" }
  );

  // ---------- formatEntry ----------

  const ingressCommit = fixtures.find(e => e.type === "transfer.ingress.commit");
  const fic = formatEntry(ingressCommit);
  t.assertEq("format ingress.commit: category", fic.category, "transfer");
  t.assertEq("format ingress.commit: direction", fic.direction, "ingress");
  t.assertEq("format ingress.commit: phase", fic.phase, "commit");
  t.assert("format ingress.commit: title mentions item",
    fic.title.includes("Shortbow"));
  t.assert("format ingress.commit: description mentions actors",
    fic.description.includes("Patrick Mossblade") &&
    fic.description.includes("Quartermaster Vault"));
  t.assert("format ingress.commit: not flagged as error",
    fic.hasError === false);

  const egressClaim = fixtures.find(e => e.type === "transfer.egress.claim");
  const fec = formatEntry(egressClaim);
  t.assert("format egress.claim: quantity surfaces as amount",
    fec.amount === "×3");

  const failed = fixtures.find(e => e.type === "transfer.ingress.failed");
  const ff = formatEntry(failed);
  t.assert("format failed: hasError true", ff.hasError === true);
  t.assertEq("format failed: errorMessage carries through",
    ff.errorMessage, "sanitization-rejected");

  const curAdd = fixtures.find(
    e => e.type === "currency.commit" && e.delta === 50
  );
  const fca = formatEntry(curAdd);
  t.assert("format currency add: title mentions amount",
    fca.title.includes("50") && fca.title.toUpperCase().includes("GP"));
  t.assert("format currency add: description shows prev → new",
    fca.description.includes("100") && fca.description.includes("150"));
  t.assertEq("format currency add: amount field is signed",
    fca.amount, "+50 GP");

  const curRemove = fixtures.find(
    e => e.type === "currency.commit" && e.delta === -30
  );
  const fcr = formatEntry(curRemove);
  t.assertEq("format currency remove: amount has minus",
    fcr.amount, "-30 GP");

  // Defensive: malformed input doesn't throw
  let threw = false;
  try {
    formatEntry(undefined);
    formatEntry({});
    formatEntry({ type: null });
    formatEntry({ type: "weird.unknown.format" });
  } catch {
    threw = true;
  }
  t.assert("format never throws on malformed input", !threw);

  // ---------- queryEntries ----------

  // Filter by category
  const onlyTransfers = queryEntries({
    source: fixtures,
    category: "transfer"
  });
  t.assertEq("query: filter category=transfer (count)",
    onlyTransfers.total, 6);

  const onlyCurrency = queryEntries({
    source: fixtures,
    category: "currency"
  });
  t.assertEq("query: filter category=currency (count)",
    onlyCurrency.total, 4);

  // Filter by phase
  const commits = queryEntries({ source: fixtures, phase: "commit" });
  t.assertEq("query: filter phase=commit (count)", commits.total, 4);

  // Filter by direction
  const ingresses = queryEntries({ source: fixtures, direction: "ingress" });
  t.assert("query: filter direction=ingress (count >= 3)",
    ingresses.total >= 3);

  // Filter by user
  const byCurrentUser = queryEntries({
    source: fixtures,
    userId: game.user.id
  });
  t.assert("query: filter by userId returns entries",
    byCurrentUser.total > 0);
  t.assert("query: filter by userId excludes others",
    byCurrentUser.entries.every(e => e.userId === game.user.id));

  // Filter by requestId
  const oneRequest = queryEntries({
    source: fixtures,
    requestId: "qm-test-ingress-1"
  });
  t.assertEq("query: filter by requestId returns 2 entries",
    oneRequest.total, 2);

  // Filter by time range
  const recent = queryEntries({
    source: fixtures,
    since: T(-15_000)
  });
  t.assert("query: filter by since returns recent entries",
    recent.entries.every(e => e.timestamp >= T(-15_000)));

  // Sorting
  const sortedDesc = queryEntries({ source: fixtures });
  for (let i = 1; i < sortedDesc.entries.length; i++) {
    if ((sortedDesc.entries[i - 1].timestamp ?? 0) <
        (sortedDesc.entries[i].timestamp ?? 0)) {
      t.assert("query: default sort is desc by timestamp", false, {
        i,
        prev: sortedDesc.entries[i - 1].timestamp,
        curr: sortedDesc.entries[i].timestamp
      });
      break;
    }
  }
  t.assert("query: default sort is desc by timestamp",
    sortedDesc.entries.length === 0 ||
    sortedDesc.entries[0].timestamp >=
      (sortedDesc.entries[sortedDesc.entries.length - 1].timestamp ?? 0));

  const sortedAsc = queryEntries({ source: fixtures, sortDir: "asc" });
  t.assert("query: sortDir=asc reverses the order",
    sortedAsc.entries.length === 0 ||
    (sortedAsc.entries[0].timestamp ?? Infinity) <=
      (sortedAsc.entries[sortedAsc.entries.length - 1].timestamp ?? 0));

  // Pagination
  const page1 = queryEntries({ source: fixtures, limit: 3 });
  t.assertEq("query: pagination limit", page1.entries.length, 3);
  t.assert("query: pagination hasMore true when more remain",
    page1.hasMore === true);

  const page2 = queryEntries({ source: fixtures, limit: 3, offset: 3 });
  t.assertEq("query: pagination offset shifts results",
    page2.entries.length, 3);
  t.assert("query: page2 first entry comes after page1 last",
    (page1.entries[2].timestamp ?? 0) >= (page2.entries[0].timestamp ?? 0));

  // Search
  const searchShortbow = queryEntries({
    source: fixtures,
    search: "shortbow"
  });
  t.assert("query: search by item name (case-insensitive) finds entries",
    searchShortbow.total >= 1);
  t.assert("query: search matches in title/description",
    searchShortbow.entries.every(e =>
      e.title.toLowerCase().includes("shortbow") ||
      e.description.toLowerCase().includes("shortbow")
    ));

  // ---------- groupByRequestId ----------

  const allFormatted = fixtures.map(formatEntry);
  const grouped = groupByRequestId(allFormatted);

  // Each unique requestId should have its own group
  const uniqueRequestIds = new Set(
    fixtures.map(f => f.requestId).filter(Boolean)
  );
  t.assertEq("group: one group per unique requestId",
    grouped.length, uniqueRequestIds.size);

  // Group for ingress-1 should have both claim and commit
  const ingressGroup = grouped.find(g => g.requestId === "qm-test-ingress-1");
  t.assert("group: ingress-1 has claim + commit",
    ingressGroup?.entries.length === 2);
  t.assertEq("group: representative phase is commit (highest order)",
    ingressGroup?.latestPhase, "commit");
  t.assert("group: ingress-1 not flagged as error",
    ingressGroup?.hasError === false);

  // Failed group should be flagged
  const failedGroup = grouped.find(g => g.requestId === "qm-test-fail-1");
  t.assert("group: failed transfer flagged hasError",
    failedGroup?.hasError === true);
  t.assertEq("group: failed errorMessage propagates",
    failedGroup?.errorMessage, "sanitization-rejected");

  // ---------- getStats ----------

  const stats = getStats(allFormatted);
  t.assertEq("stats: total count", stats.total, 11);
  t.assertEq("stats: transfer count", stats.byCategory.transfer, 6);
  t.assertEq("stats: currency count", stats.byCategory.currency, 4);
  t.assertEq("stats: unknown count", stats.byCategory.unknown, 1);
  t.assertEq("stats: failures count", stats.failures, 1);
  t.assert("stats: earliest is the oldest timestamp in fixtures",
    stats.earliest === T(-60_000));
  t.assert("stats: latest is the newest timestamp in fixtures",
    stats.latest === T(-2_000));

  // ---------- visibility ----------

  // GM always has access
  const gmUser = { id: "gm", isGM: true };
  t.assert("visibility: GM always has access",
    canUserAccessLog(gmUser) === true);
  t.assert("visibility: entries visible to GM",
    isEntryVisibleToUser(fixtures[0], gmUser) === true);

  // Player: depends on setting. The current game state has whatever
  // the GM configured; we just verify the function returns a boolean
  // and the entry visibility tracks log access.
  const playerUser = { id: "player", isGM: false };
  const playerCanAccess = canUserAccessLog(playerUser);
  t.assert("visibility: player access result is boolean",
    typeof playerCanAccess === "boolean");
  t.assertEq("visibility: entry visibility matches log access",
    isEntryVisibleToUser(fixtures[0], playerUser),
    playerCanAccess);

  // getVisibleEntries returns accessDenied marker for blocked users
  // We can't safely change the world setting in tests, so we just
  // verify that when canUserAccessLog returns false, the result is
  // shaped correctly. Simulate by manually constructing a "blocked" user:
  const blockedUser = {
    id: "blocked",
    isGM: false
  };
  // The actual result depends on game.settings; just verify the API shape
  const vresult = getVisibleEntries(blockedUser, { source: fixtures });
  t.assert("getVisibleEntries: returns expected shape",
    typeof vresult === "object" &&
    Array.isArray(vresult.entries) &&
    typeof vresult.total === "number");

  printResults(`${MODULE_TITLE} | Step 11 Tests`, t.results);
  return t.results;
}
