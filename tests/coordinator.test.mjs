import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { FLAGS, HOOKS, MODULE_ID, SETTINGS } from "../scripts/constants.js";

const previousGame = globalThis.game;
const previousFoundry = globalThis.foundry;
const previousHooks = globalThis.Hooks;

let randomId = 0;
globalThis.foundry = {
  utils: {
    randomID: () => `coordinator-${++randomId}`,
    deepClone: value => structuredClone(value)
  }
};
globalThis.Hooks = { callAll() {} };

class FakeStorageActor {
  constructor(id, marker) {
    this.id = id;
    this.documentName = "Actor";
    this.flags = {
      [marker]: true,
      [FLAGS.TRANSACTION_LOG]: [],
      [FLAGS.OPERATION_TOMBSTONES]: []
    };
  }

  getFlag(scope, key) {
    return scope === MODULE_ID ? this.flags[key] : undefined;
  }

  async setFlag(scope, key, value) {
    assert.equal(scope, MODULE_ID);
    this.flags[key] = structuredClone(value);
    return this;
  }
}

const backing = new FakeStorageActor("coordinator-backing", FLAGS.BACKING_ACTOR_MARKER);
const staging = new FakeStorageActor("coordinator-staging", FLAGS.STAGING_ACTOR_MARKER);
const actors = new Map([[backing.id, backing], [staging.id, staging]]);

globalThis.game = {
  user: { id: "gm", isGM: true },
  users: { activeGM: { id: "gm" } },
  actors,
  settings: {
    get(_scope, key) {
      if (key === SETTINGS.BACKING_ACTOR_ID) return backing.id;
      if (key === SETTINGS.STAGING_ACTOR_ID) return staging.id;
      if (key === SETTINGS.RECENT_REQUEST_CACHE_SIZE) return 100;
      if (key === SETTINGS.REQUEST_AGE_MAX_SECONDS) return 300;
      if (key === SETTINGS.TRANSACTION_LOG_CAP) return 500;
      if (key === SETTINGS.TRANSACTION_LOG_VISIBILITY) return "all";
      return null;
    }
  }
};

const Coordinator = await import("../scripts/operation-coordinator.js");
Coordinator.initializeCoordinator();

beforeEach(() => {
  backing.flags[FLAGS.TRANSACTION_LOG] = [];
  staging.flags[FLAGS.TRANSACTION_LOG] = [];
  staging.flags[FLAGS.OPERATION_TOMBSTONES] = [];
  Coordinator._resetCacheForTesting();
});

after(() => {
  globalThis.game = previousGame;
  globalThis.foundry = previousFoundry;
  globalThis.Hooks = previousHooks;
});

function request(overrides = {}) {
  return {
    resourceKeys: ["currency-ledger"],
    requestId: "coordinator-request",
    operationType: "currencyChange",
    requester: "player-a",
    timestamp: Date.now(),
    requestData: {
      type: "quartermaster.currencyChange",
      payload: { currencyType: "gp", delta: 1, reason: "test" }
    },
    fn: async () => ({ status: "success", resultData: { applied: true } }),
    ...overrides
  };
}

test("concurrent duplicate requests mutate once and replay after the mutex", async () => {
  let mutations = 0;
  let signalStarted;
  let releaseMutation;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const release = new Promise(resolve => { releaseMutation = resolve; });
  const options = request({
    requestId: "concurrent-duplicate",
    fn: async () => {
      mutations += 1;
      signalStarted();
      await release;
      return { status: "success", resultData: { mutation: mutations } };
    }
  });

  const first = Coordinator.executeOperation(options);
  await started;
  const second = Coordinator.executeOperation({ ...options });
  releaseMutation();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(mutations, 1);
  assert.equal(firstResult.status, "success");
  assert.equal(secondResult.status, "success");
  assert.equal(secondResult.fromTombstone, true);
  assert.deepEqual(secondResult.resultData, { mutation: 1 });
});

test("request IDs are bound to requester, operation, and canonical payload", async () => {
  const timestamp = Date.now();
  const original = await Coordinator.executeOperation(request({
    requestId: "bound-request",
    timestamp,
    fn: async () => ({
      status: "success",
      resultData: { privateField: "must-not-leak" }
    })
  }));
  assert.equal(original.status, "success");

  let changedPayloadFnCalls = 0;
  const changedPayload = await Coordinator.executeOperation(request({
    requestId: "bound-request",
    timestamp,
    requestData: {
      payload: { reason: "test", delta: 2, currencyType: "gp" },
      type: "quartermaster.currencyChange"
    },
    fn: async () => {
      changedPayloadFnCalls += 1;
      return { status: "success" };
    }
  }));
  assert.deepEqual(changedPayload, { status: "failed", error: "request-id-collision" });
  assert.equal(changedPayloadFnCalls, 0);
  assert.equal("resultData" in changedPayload, false);

  let changedIdentityFnCalls = 0;
  const changedIdentity = await Coordinator.executeOperation(request({
    requestId: "bound-request",
    timestamp,
    requester: "player-b",
    operationType: "customResourceChange",
    requestData: {
      type: "quartermaster.customResourceChange",
      payload: { resourceId: "supply", delta: 1 }
    },
    fn: async () => {
      changedIdentityFnCalls += 1;
      return { status: "success" };
    }
  }));
  assert.deepEqual(changedIdentity, { status: "failed", error: "request-id-collision" });
  assert.equal(changedIdentityFnCalls, 0);
  assert.equal("resultData" in changedIdentity, false);
});

test("durable replay accepts only the same canonical authenticated request", async () => {
  const timestamp = Date.now();
  const first = await Coordinator.executeOperation(request({
    requestId: "durable-replay",
    timestamp
  }));
  assert.equal(first.status, "success");
  Coordinator._resetCacheForTesting();

  let replayFnCalls = 0;
  const replay = await Coordinator.executeOperation(request({
    requestId: "durable-replay",
    timestamp,
    requestData: {
      payload: { reason: "test", currencyType: "gp", delta: 1 },
      type: "quartermaster.currencyChange"
    },
    fn: async () => {
      replayFnCalls += 1;
      return { status: "failed", error: "must-not-run" };
    }
  }));
  assert.equal(replay.status, "success");
  assert.equal(replay.fromTombstone, true);
  assert.deepEqual(replay.resultData, { applied: true });
  assert.equal(replayFnCalls, 0);

  const collision = await Coordinator.executeOperation(request({
    requestId: "durable-replay",
    timestamp,
    requestData: {
      type: "quartermaster.currencyChange",
      payload: { currencyType: "gp", delta: 99, reason: "test" }
    }
  }));
  assert.deepEqual(collision, { status: "failed", error: "request-id-collision" });
});

test("an orphan operation-specific claim fails closed instead of replaying success", async () => {
  staging.flags[FLAGS.TRANSACTION_LOG] = [{
    id: "orphan-claim",
    timestamp: Date.now(),
    type: "transfer.egress.claim",
    requestId: "orphan-request"
  }];

  let fnCalls = 0;
  const result = await Coordinator.executeOperation(request({
    requestId: "orphan-request",
    resourceKeys: ["item:orphan"],
    operationType: "itemTransfer:egress",
    requestData: {
      type: "quartermaster.itemTransfer",
      action: "egress",
      payload: { sourceItemUuid: "Actor.vault.Item.orphan", destActorUuid: "Actor.hero" }
    },
    fn: async () => {
      fnCalls += 1;
      return { status: "success" };
    }
  }));

  assert.deepEqual(result, { status: "failed", error: "request-recovery-required" });
  assert.equal(fnCalls, 0);
});

test("a bound operation claim plus an explicit commit recovers without mutation", async () => {
  const timestamp = Date.now();
  await Coordinator.executeOperation(request({ requestId: "specific-terminal", timestamp }));
  const operationClaim = staging.flags[FLAGS.TRANSACTION_LOG]
    .find(entry => entry.type === "operation.claim");
  assert.ok(operationClaim?.requestFingerprint);

  staging.flags[FLAGS.TRANSACTION_LOG] = [
    operationClaim,
    {
      id: "currency-commit",
      timestamp: Date.now(),
      type: "currency.commit",
      requestId: "specific-terminal"
    }
  ];
  staging.flags[FLAGS.OPERATION_TOMBSTONES] = [];
  Coordinator._resetCacheForTesting();

  let fnCalls = 0;
  const result = await Coordinator.executeOperation(request({
    requestId: "specific-terminal",
    timestamp,
    fn: async () => {
      fnCalls += 1;
      return { status: "success" };
    }
  }));

  assert.equal(result.status, "success");
  assert.equal(result.fromLog, true);
  assert.equal(result.recoveredFromOperationLog, true);
  assert.equal(fnCalls, 0);
});

test("timestamps must be finite numbers within the accepted clock window", async () => {
  const invalidCases = [
    ["missing", undefined, "invalid-request-timestamp"],
    ["string", String(Date.now()), "invalid-request-timestamp"],
    ["nan", Number.NaN, "invalid-request-timestamp"],
    ["infinity", Number.POSITIVE_INFINITY, "invalid-request-timestamp"],
    ["stale", Date.now() - 301_000, "request-too-old"],
    ["future", Date.now() + 60_000, "request-too-far-in-future"]
  ];

  for (const [label, timestamp, error] of invalidCases) {
    let fnCalls = 0;
    const result = await Coordinator.executeOperation(request({
      requestId: `timestamp-${label}`,
      timestamp,
      fn: async () => {
        fnCalls += 1;
        return { status: "success" };
      }
    }));
    assert.equal(result.status, "failed", label);
    assert.equal(result.error, error, label);
    assert.equal(fnCalls, 0, label);
  }
});

test("authenticated request data is mandatory for every coordinated mutation", async () => {
  let fnCalls = 0;
  const options = request({
    requestId: "missing-request-data",
    fn: async () => {
      fnCalls += 1;
      return { status: "success" };
    }
  });
  delete options.requestData;
  const missing = await Coordinator.executeOperation(options);
  assert.deepEqual(missing, { status: "failed", error: "invalid-request-data" });

  const array = await Coordinator.executeOperation(request({
    requestId: "array-request-data",
    requestData: []
  }));
  assert.deepEqual(array, { status: "failed", error: "invalid-request-data" });
  assert.equal(fnCalls, 0);
});

test("a non-active GM cannot execute coordinated mutations directly", async () => {
  const activeGM = game.users.activeGM;
  game.users.activeGM = { id: "other-gm" };
  try {
    let fnCalls = 0;
    const result = await Coordinator.executeOperation(request({
      requestId: "inactive-gm",
      fn: async () => {
        fnCalls += 1;
        return { status: "success" };
      }
    }));
    assert.deepEqual(result, { status: "failed", error: "active-gm-required" });
    assert.equal(fnCalls, 0);
  } finally {
    game.users.activeGM = activeGM;
  }
});

test("active-GM authority is rechecked immediately before mutation code", async () => {
  const activeGM = game.users.activeGM;
  const callAll = Hooks.callAll;
  Hooks.callAll = (hook, entry) => {
    if (hook === HOOKS.LOG_ENTRY_ADDED && entry?.type === "operation.claim") {
      game.users.activeGM = { id: "other-gm" };
    }
  };

  try {
    let fnCalls = 0;
    const result = await Coordinator.executeOperation(request({
      requestId: "election-before-fn",
      fn: async () => {
        fnCalls += 1;
        return { status: "success" };
      }
    }));
    assert.deepEqual(result, { status: "failed", error: "active-gm-required" });
    assert.equal(fnCalls, 0);
    assert.equal(staging.flags[FLAGS.OPERATION_TOMBSTONES][0].state, "pending");
  } finally {
    Hooks.callAll = callAll;
    game.users.activeGM = activeGM;
  }
});

test("private tombstones survive cache reset and presentation-log eviction", async () => {
  const timestamp = Date.now();
  const first = await Coordinator.executeOperation(request({
    requestId: "evicted-presentation-log",
    timestamp,
    fn: async () => ({ status: "success", resultData: { durable: true } })
  }));
  assert.equal(first.status, "success");

  // Simulate both a process-local cache reset and more entries than the
  // presentation log retains. The separate tombstone flag is untouched.
  Coordinator._resetCacheForTesting();
  staging.flags[FLAGS.TRANSACTION_LOG] = Array.from({ length: 600 }, (_, index) => ({
    id: `noise-${index}`,
    requestId: `noise-${index}`,
    timestamp: Date.now(),
    type: "currency.commit"
  }));

  let fnCalls = 0;
  const replay = await Coordinator.executeOperation(request({
    requestId: "evicted-presentation-log",
    timestamp,
    fn: async () => {
      fnCalls += 1;
      return { status: "failed", error: "must-not-run" };
    }
  }));
  assert.equal(replay.status, "success");
  assert.equal(replay.fromTombstone, true);
  assert.deepEqual(replay.resultData, { durable: true });
  assert.equal(fnCalls, 0);
});

test("same request ID collides on sender, payload, or timestamp changes", async () => {
  const timestamp = Date.now();
  await Coordinator.executeOperation(request({ requestId: "collision-variants", timestamp }));
  Coordinator._resetCacheForTesting();

  const variants = [
    { requester: "player-b" },
    { requestData: { type: "quartermaster.currencyChange", payload: { currencyType: "gp", delta: 2 } } },
    { timestamp: timestamp + 1 }
  ];
  for (const variant of variants) {
    let fnCalls = 0;
    const result = await Coordinator.executeOperation(request({
      requestId: "collision-variants",
      timestamp,
      ...variant,
      fn: async () => {
        fnCalls += 1;
        return { status: "success" };
      }
    }));
    assert.deepEqual(result, { status: "failed", error: "request-id-collision" });
    assert.equal(fnCalls, 0);
  }
});

test("an orphan pending tombstone fails closed before cache or log fallback", async () => {
  const timestamp = Date.now();
  // Obtain the exact binding from a completed operation, then turn its private
  // record into an interrupted claim and remove all weaker replay evidence.
  await Coordinator.executeOperation(request({ requestId: "orphan-tombstone", timestamp }));
  const record = staging.flags[FLAGS.OPERATION_TOMBSTONES][0];
  staging.flags[FLAGS.OPERATION_TOMBSTONES] = [{
    ...record,
    state: "pending",
    terminalAt: undefined,
    result: undefined
  }];
  staging.flags[FLAGS.TRANSACTION_LOG] = [];
  Coordinator._resetCacheForTesting();

  let fnCalls = 0;
  const result = await Coordinator.executeOperation(request({
    requestId: "orphan-tombstone",
    timestamp,
    fn: async () => {
      fnCalls += 1;
      return { status: "success" };
    }
  }));
  assert.deepEqual(result, { status: "failed", error: "request-recovery-required" });
  assert.equal(fnCalls, 0);
});
