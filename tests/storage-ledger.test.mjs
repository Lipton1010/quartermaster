import test from "node:test";
import assert from "node:assert/strict";

import { FLAGS, MODULE_ID, SETTINGS } from "../scripts/constants.js";
import {
  isActiveStorageGM,
  withStorageLedgerLock
} from "../scripts/storage-ledger.js";
import {
  clear,
  releaseItemSnapshot,
  writeEntry
} from "../scripts/transaction-log.js";
import {
  readRecoveryRecords,
  removeRecoveryRecord,
  updateRecoveryRecord,
  writeRecoveryRecord
} from "../scripts/recovery-records.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function installLedgerWorld({ activeUserId = "gm-a" } = {}) {
  const counters = { inFlight: 0, maxInFlight: 0, random: 0 };

  class StorageActor {
    constructor(id, marker) {
      this.id = id;
      this.flags = new Map([
        [marker, true],
        [FLAGS.TRANSACTION_LOG, []],
        [FLAGS.RECOVERY_RECORDS, []]
      ]);
      this.corruptNextFlag = null;
      this.throwAfterNextFlag = null;
    }

    getFlag(scope, key) {
      if (scope !== MODULE_ID) return undefined;
      const value = this.flags.get(key);
      return value == null ? value : clone(value);
    }

    async setFlag(scope, key, value) {
      assert.equal(scope, MODULE_ID);
      counters.inFlight += 1;
      counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      const retained = this.corruptNextFlag === key && Array.isArray(value)
        ? value.slice(0, -1)
        : value;
      this.corruptNextFlag = null;
      this.flags.set(key, clone(retained));
      counters.inFlight -= 1;
      if (this.throwAfterNextFlag === key) {
        this.throwAfterNextFlag = null;
        throw new Error("simulated-post-commit-hook-error");
      }
    }
  }

  const backing = new StorageActor("backing", FLAGS.BACKING_ACTOR_MARKER);
  const staging = new StorageActor("staging", FLAGS.STAGING_ACTOR_MARKER);
  const actors = new Map([[backing.id, backing], [staging.id, staging]]);
  actors.find = predicate => [...actors.values()].find(predicate) ?? null;
  const gmA = { id: "gm-a", isGM: true };
  const gmB = { id: "gm-b", isGM: true };
  const users = { activeGM: activeUserId === gmA.id ? gmA : gmB };

  globalThis.game = {
    user: activeUserId === gmA.id ? gmA : gmB,
    users,
    actors,
    settings: {
      get(_scope, key) {
        if (key === SETTINGS.BACKING_ACTOR_ID) return backing.id;
        if (key === SETTINGS.STAGING_ACTOR_ID) return staging.id;
        if (key === SETTINGS.TRANSACTION_LOG_CAP) return 1000;
        if (key === SETTINGS.TRANSACTION_LOG_VISIBILITY) return "all";
        return null;
      }
    }
  };
  globalThis.foundry = {
    utils: {
      deepClone: clone,
      randomID: () => `id-${++counters.random}`
    }
  };
  globalThis.Hooks = { callAll() {} };

  return { actors, backing, counters, gmA, gmB, staging, users };
}

function preserveGlobals(t) {
  const previous = {
    game: globalThis.game,
    foundry: globalThis.foundry,
    Hooks: globalThis.Hooks
  };
  t.after(() => {
    globalThis.game = previous.game;
    globalThis.foundry = previous.foundry;
    globalThis.Hooks = previous.Hooks;
  });
}

test("one mutex serializes canonical logs and recovery records without lost updates", async t => {
  preserveGlobals(t);
  const { counters, staging } = installLedgerWorld();
  const oldWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = oldWarn; });

  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => writeEntry({
      type: "item.egress",
      requestId: `log-${index}`
    })),
    ...Array.from({ length: 8 }, (_, index) => writeRecoveryRecord({
      requestId: `recovery-${index}`,
      reason: "test"
    }))
  ]);

  assert.equal(staging.getFlag(MODULE_ID, FLAGS.TRANSACTION_LOG).length, 8);
  assert.equal(readRecoveryRecords().length, 8);
  assert.equal(counters.maxInFlight, 1);
});

test("concurrent recovery updates retain both changes and all mutation forms verify", async t => {
  preserveGlobals(t);
  installLedgerWorld();
  const oldWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = oldWarn; });

  const initial = await writeRecoveryRecord({ requestId: "shared-request", reason: "initial" });
  await Promise.all([
    updateRecoveryRecord(initial.id, { noteA: "retained-a" }),
    updateRecoveryRecord(initial.id, { noteB: "retained-b" })
  ]);
  const [updated] = readRecoveryRecords();
  assert.equal(updated.noteA, "retained-a");
  assert.equal(updated.noteB, "retained-b");
  assert.equal(await removeRecoveryRecord(initial.id), true);
  assert.deepEqual(readRecoveryRecords(), []);
});

test("ledger writes reject silent corruption but accept a verified post-commit throw", async t => {
  preserveGlobals(t);
  const { staging } = installLedgerWorld();
  const oldWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = oldWarn; });

  staging.corruptNextFlag = FLAGS.TRANSACTION_LOG;
  await assert.rejects(
    () => writeEntry({ type: "item.egress", requestId: "corrupt-log" }),
    /canonical-transaction-log-verification-failed/
  );

  staging.throwAfterNextFlag = FLAGS.RECOVERY_RECORDS;
  const retained = await writeRecoveryRecord({ requestId: "committed-recovery" });
  assert.equal(retained.requestId, "committed-recovery");
  assert.equal(readRecoveryRecords()[0].requestId, "committed-recovery");
});

test("inactive GM mutations fail closed and election transfers ledger authority", async t => {
  preserveGlobals(t);
  const { counters, gmA, gmB, users } = installLedgerWorld();
  game.user = gmB;
  users.activeGM = gmA;

  assert.equal(isActiveStorageGM(), false);
  assert.equal(await writeEntry({ type: "item.egress" }), null);
  assert.equal(await writeRecoveryRecord({ requestId: "blocked" }), null);
  assert.equal(await releaseItemSnapshot("blocked"), 0);
  assert.equal(await clear(), false);
  assert.equal(counters.maxInFlight, 0);

  users.activeGM = gmB;
  assert.equal(isActiveStorageGM(), true);
  const written = await writeEntry({ type: "item.egress", requestId: "elected" });
  assert.equal(written.requestId, "elected");
});

test("the exported storage mutex remains usable by other private-ledger writers", async () => {
  const order = [];
  await Promise.all([
    withStorageLedgerLock(async () => {
      order.push("first-start");
      await new Promise(resolve => setTimeout(resolve, 1));
      order.push("first-end");
    }),
    withStorageLedgerLock(async () => { order.push("second"); })
  ]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});
