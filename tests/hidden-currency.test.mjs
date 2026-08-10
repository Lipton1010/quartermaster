import test from "node:test";
import assert from "node:assert/strict";

import { FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";

function stagedEntry(overrides = {}) {
  return {
    id: "staged-gp",
    type: "gp",
    currencyId: "gp",
    currencyName: "Gold",
    currencySymbol: "GP",
    amount: 5,
    createdAt: 1,
    ...overrides
  };
}

function createFixture({
  entries = [stagedEntry()],
  failCompensation = false,
  failHiddenRemoval = false,
  beforeActorUpdate = null,
  afterActorUpdate = null,
  beforeHiddenCurrencyWrite = null
} = {}) {
  let idCounter = 0;
  globalThis.foundry = {
    utils: {
      deepClone: structuredClone,
      randomID: () => `id-${++idCounter}`
    }
  };
  globalThis.Hooks = { callAll() {} };
  globalThis.ui = { notifications: { info() {} } };

  const backingFlags = {
    [FLAGS.BACKING_ACTOR_MARKER]: true,
    [FLAGS.TRANSACTION_LOG]: []
  };
  const stagingFlags = {
    [FLAGS.STAGING_ACTOR_MARKER]: true,
    [FLAGS.HIDDEN_CURRENCY]: structuredClone(entries),
    [FLAGS.TRANSACTION_LOG]: [],
    [FLAGS.RECOVERY_RECORDS]: []
  };
  const hiddenCurrencyHistory = [];
  let updateCount = 0;
  let hiddenWriteCount = 0;

  const backing = {
    id: "backing",
    documentName: "Actor",
    system: { currency: { pp: 0, gp: 10, ep: 0, sp: 0, cp: 0 } },
    getFlag(scope, key) { return scope === MODULE_ID ? backingFlags[key] : undefined; },
    async setFlag(scope, key, value) {
      assert.equal(scope, MODULE_ID);
      backingFlags[key] = structuredClone(value);
    },
    async update(changes) {
      updateCount += 1;
      await beforeActorUpdate?.({ count: updateCount, changes, actor: this });
      const next = changes["system.currency.gp"];
      if (failCompensation && updateCount === 2) {
        throw new Error("simulated-compensation-failure");
      }
      this.system.currency.gp = next;
      await afterActorUpdate?.({ count: updateCount, changes, actor: this });
    }
  };
  const staging = {
    id: "staging",
    documentName: "Actor",
    getFlag(scope, key) { return scope === MODULE_ID ? stagingFlags[key] : undefined; },
    async setFlag(scope, key, value) {
      assert.equal(scope, MODULE_ID);
      if (key === FLAGS.HIDDEN_CURRENCY) {
        hiddenWriteCount += 1;
        const next = structuredClone(value);
        await beforeHiddenCurrencyWrite?.({
          count: hiddenWriteCount,
          current: structuredClone(stagingFlags[key]),
          next
        });
        if (failHiddenRemoval && next.length < stagingFlags[key].length) {
          throw new Error("simulated-staging-delete-failure");
        }
        stagingFlags[key] = next;
        hiddenCurrencyHistory.push(structuredClone(next));
        return;
      }
      stagingFlags[key] = structuredClone(value);
    }
  };
  const actors = new Map([[backing.id, backing], [staging.id, staging]]);
  actors.find = predicate => [...actors.values()].find(predicate);
  const gm = { id: "gm", isGM: true };
  const users = new Map([[gm.id, gm]]);
  users.activeGM = gm;
  globalThis.game = {
    system: { id: "dnd5e" },
    user: gm,
    users,
    actors,
    settings: {
      get(_scope, key) {
        if (key === SETTINGS.BACKING_ACTOR_ID) return backing.id;
        if (key === SETTINGS.STAGING_ACTOR_ID) return staging.id;
        if (key === SETTINGS.TRANSACTION_LOG_VISIBILITY) return "all";
        if (key === SETTINGS.TRANSACTION_LOG_CAP) return 500;
        if (key === SETTINGS.RECENT_REQUEST_CACHE_SIZE) return 100;
        if (key === SETTINGS.REQUEST_AGE_MAX_SECONDS) return 300;
        if (key === SETTINGS.HIDE_ELECTRUM) return false;
        return null;
      }
    }
  };
  return {
    backing,
    backingFlags,
    staging,
    stagingFlags,
    hiddenCurrencyHistory,
    get updateCount() { return updateCount; },
    get hiddenWriteCount() { return hiddenWriteCount; }
  };
}

async function loadModules() {
  const Coordinator = await import("../scripts/operation-coordinator.js");
  Coordinator.initializeCoordinator();
  Coordinator._resetCacheForTesting();
  return {
    Coordinator,
    HiddenCurrency: await import("../scripts/hidden-currency.js"),
    Currencies: await import("../scripts/currencies.js")
  };
}

test("staged currency deletion failure restores the credited balance", async () => {
  const fixture = createFixture({ failHiddenRemoval: true });
  const { HiddenCurrency } = await loadModules();

  const result = await HiddenCurrency.revealHiddenCurrency("staged-gp");
  assert.equal(result.status, "failed");
  assert.equal(result.compensated, true);
  assert.equal(result.retryReady, true);
  assert.equal(fixture.backing.system.currency.gp, 10);
  assert.equal(fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY][0].id, "staged-gp");
  assert.equal(fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY][0].revealRequestId, undefined);
  assert.equal(fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY][0].revealRequestedAt, undefined);
  assert.deepEqual(fixture.stagingFlags[FLAGS.RECOVERY_RECORDS], []);

  const retry = await HiddenCurrency.revealHiddenCurrency("staged-gp");
  assert.equal(retry.status, "failed");
  assert.equal(retry.compensated, true);
  assert.equal(retry.retryReady, true);
  assert.notEqual(retry.requestId, result.requestId);
  assert.equal(fixture.backing.system.currency.gp, 10);
});

test("failed currency compensation writes a private recovery record and blocks retry", async () => {
  const fixture = createFixture({ failCompensation: true, failHiddenRemoval: true });
  const { HiddenCurrency } = await loadModules();

  const result = await HiddenCurrency.revealHiddenCurrency("staged-gp");
  assert.equal(result.status, "failed");
  assert.equal(result.compensated, false);
  assert.equal(result.recoveryRecorded, true);
  assert.equal(fixture.backing.system.currency.gp, 15);
  assert.equal(fixture.stagingFlags[FLAGS.RECOVERY_RECORDS].length, 1);
  assert.equal(fixture.stagingFlags[FLAGS.RECOVERY_RECORDS][0].operation, "currency.reveal");

  const retry = await HiddenCurrency.revealHiddenCurrency("staged-gp");
  assert.equal(retry.error, "recovery-reconciliation-required");
  assert.equal(fixture.backing.system.currency.gp, 15);
});

test("an interrupted reveal after credit fails closed after cache reset without crediting twice", async () => {
  const fixture = createFixture();
  const { Coordinator, HiddenCurrency } = await loadModules();

  const completed = await HiddenCurrency.revealHiddenCurrency("staged-gp");
  assert.equal(completed.status, "success");
  assert.equal(fixture.backing.system.currency.gp, 15);

  const stamped = fixture.hiddenCurrencyHistory
    .flat()
    .find(entry => entry.id === "staged-gp" && entry.revealRequestId);
  assert.ok(stamped?.revealRequestId);
  assert.ok(Number.isSafeInteger(stamped.revealRequestedAt));
  const operationClaim = fixture.stagingFlags[FLAGS.TRANSACTION_LOG]
    .find(entry => entry.type === "operation.claim");
  const revealClaim = fixture.stagingFlags[FLAGS.TRANSACTION_LOG]
    .find(entry => entry.type === "currency.claim");
  const completedTombstone = fixture.stagingFlags[FLAGS.OPERATION_TOMBSTONES]
    .find(record => record.requestId === stamped.revealRequestId);
  assert.ok(operationClaim?.requestFingerprint);
  assert.equal(operationClaim.requestId, stamped.revealRequestId);
  assert.equal(revealClaim?.requestId, stamped.revealRequestId);
  assert.equal(completedTombstone?.state, "terminal");

  // Reconstruct the durable state of a process interrupted after the actor
  // credit but before staged-entry removal or a terminal coordinator record.
  fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY] = [structuredClone(stamped)];
  fixture.stagingFlags[FLAGS.TRANSACTION_LOG] = [operationClaim, revealClaim];
  fixture.stagingFlags[FLAGS.OPERATION_TOMBSTONES] = [{
    ...completedTombstone,
    state: "pending",
    terminalAt: undefined,
    result: undefined
  }];
  Coordinator._resetCacheForTesting();
  const writesBeforeRetry = fixture.updateCount;
  const timestampBeforeRetry = stamped.revealRequestedAt;

  const retry = await HiddenCurrency.revealHiddenCurrency("staged-gp");
  assert.deepEqual(retry, { status: "failed", error: "request-recovery-required" });
  assert.equal(fixture.backing.system.currency.gp, 15);
  assert.equal(fixture.updateCount, writesBeforeRetry);
  assert.equal(
    fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY][0].revealRequestedAt,
    timestampBeforeRetry
  );
  assert.equal(
    fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY][0].revealRequestId,
    stamped.revealRequestId
  );
});

test("hidden reveal and normal currency changes share the currency-ledger lock", async () => {
  let signalFirstUpdate;
  let releaseFirstUpdate;
  const firstUpdateStarted = new Promise(resolve => { signalFirstUpdate = resolve; });
  const firstUpdateRelease = new Promise(resolve => { releaseFirstUpdate = resolve; });
  const fixture = createFixture({
    beforeActorUpdate: async ({ count }) => {
      if (count !== 1) return;
      signalFirstUpdate();
      await firstUpdateRelease;
    }
  });
  const { Coordinator, HiddenCurrency, Currencies } = await loadModules();

  const reveal = HiddenCurrency.revealHiddenCurrency("staged-gp");
  await firstUpdateStarted;
  let normalMutationCalls = 0;
  const normal = Coordinator.executeOperation({
    resourceKeys: ["currency-ledger"],
    requestId: "normal-currency-change",
    operationType: "currencyChange",
    requester: "gm",
    timestamp: Date.now(),
    requestData: {
      type: "quartermaster.currencyChange",
      payload: { currencyType: "gp", delta: 1, reason: "concurrency-test" }
    },
    fn: async () => {
      normalMutationCalls += 1;
      const applied = await Currencies.applyCurrencyDelta("gp", 1, fixture.backing);
      return { status: applied.status, resultData: applied };
    }
  });
  await Promise.resolve();
  assert.equal(normalMutationCalls, 0);
  releaseFirstUpdate();

  const [revealResult, normalResult] = await Promise.all([reveal, normal]);
  assert.equal(revealResult.status, "success");
  assert.equal(normalResult.status, "success");
  assert.equal(normalMutationCalls, 1);
  assert.equal(fixture.updateCount, 2);
  assert.equal(fixture.backing.system.currency.gp, 16);
});

test("a former active GM cannot run compensation or private writes after election changes", async () => {
  const fixture = createFixture({
    afterActorUpdate: async ({ count }) => {
      if (count === 1) {
        game.users.activeGM = { id: "gm-2", isGM: true };
      }
    }
  });
  const { HiddenCurrency } = await loadModules();

  const result = await HiddenCurrency.revealHiddenCurrency("staged-gp");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "operation-reconciliation-required");
  assert.equal(fixture.updateCount, 1);
  assert.equal(fixture.backing.system.currency.gp, 15);
  assert.equal(fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY].length, 1);
  assert.equal(fixture.stagingFlags[FLAGS.RECOVERY_RECORDS].length, 0);
  assert.equal(
    fixture.stagingFlags[FLAGS.OPERATION_TOMBSTONES][0].state,
    "pending"
  );
});

test("concurrent staged-currency additions cannot overwrite each other", async () => {
  let signalFirstWrite;
  let releaseFirstWrite;
  const firstWriteStarted = new Promise(resolve => { signalFirstWrite = resolve; });
  const firstWriteRelease = new Promise(resolve => { releaseFirstWrite = resolve; });
  const fixture = createFixture({
    entries: [],
    beforeHiddenCurrencyWrite: async ({ count }) => {
      if (count !== 1) return;
      signalFirstWrite();
      await firstWriteRelease;
    }
  });
  const { HiddenCurrency } = await loadModules();

  const first = HiddenCurrency.addHiddenCurrency("gp", 2);
  await firstWriteStarted;
  const second = HiddenCurrency.addHiddenCurrency("gp", 3);
  releaseFirstWrite();
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map(result => result.status), ["success", "success"]);
  assert.equal(fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY].length, 2);
  assert.deepEqual(
    fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY].map(entry => entry.amount).sort((a, b) => a - b),
    [2, 3]
  );
});

test("reveal all executes one durable serialized reveal per staged entry", async () => {
  const fixture = createFixture({
    entries: [
      stagedEntry(),
      stagedEntry({ id: "staged-gp-2", amount: 2, createdAt: 2 })
    ]
  });
  const { HiddenCurrency } = await loadModules();

  const result = await HiddenCurrency.revealAllHiddenCurrency();
  assert.deepEqual(result, { status: "success", count: 2 });
  assert.equal(fixture.backing.system.currency.gp, 17);
  assert.deepEqual(fixture.stagingFlags[FLAGS.HIDDEN_CURRENCY], []);
  assert.equal(
    fixture.stagingFlags[FLAGS.TRANSACTION_LOG]
      .filter(entry => entry.type === "operation.claim").length,
    2
  );
  assert.equal(
    fixture.stagingFlags[FLAGS.TRANSACTION_LOG]
      .filter(entry => entry.type === "currency.revealed").length,
    2
  );
});
