import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  installQuerySenderCapture,
  resolveAuthenticatedQuerySender,
  resetQuerySenderCaptureForTests,
  takeSocketQuerySender
} from "../scripts/query-sender.js";

const QUERY_NAME = "quartermaster.processRequest";

test("query sender prefers Foundry v14 options.user and ignores missing identity", () => {
  assert.equal(resolveAuthenticatedQuerySender({ user: { id: "u-v14" } }), "u-v14");
  assert.equal(resolveAuthenticatedQuerySender({ userId: "u-opt" }), null);
  assert.equal(resolveAuthenticatedQuerySender({ userId: "victim" }), null);
  assert.equal(resolveAuthenticatedQuerySender({}, "u-socket"), "u-socket");
  assert.equal(resolveAuthenticatedQuerySender({}), null);
  assert.equal(resolveAuthenticatedQuerySender({ userId: "" }, null), null);
  assert.equal(resolveAuthenticatedQuerySender({ userId: "victim" }, "attacker"), "attacker");
});

test("options.user supplies identity without a socket sender", () => {
  assert.equal(resolveAuthenticatedQuerySender({ user: { id: "u-only" } }), "u-only");
});

test("mismatched option identity and socket identity fail closed", () => {
  assert.equal(
    resolveAuthenticatedQuerySender({ user: { id: "u-a" } }, "u-b"),
    null
  );
});

test("v14 option identity matching the socket sender is accepted", () => {
  assert.equal(
    resolveAuthenticatedQuerySender({ user: { id: "u-same" } }, "u-same"),
    "u-same"
  );
});

test("v13 userQuery packets capture the server-authenticated sender before later listeners", () => {
  resetQuerySenderCaptureForTests();
  const socket = new EventEmitter();
  socket.listeners = undefined;
  socket.off = undefined;
  let laterSawStack = undefined;
  socket.on("userQuery", () => {
    laterSawStack = takeSocketQuerySender();
  });

  installQuerySenderCapture(QUERY_NAME, socket);
  socket.emit(
    "userQuery",
    "player-2",
    "qid-1",
    QUERY_NAME,
    { type: "probe" },
    { timeout: 1000 },
    () => {}
  );

  assert.equal(laterSawStack, "player-2");
  assert.equal(takeSocketQuerySender(), undefined);
});

test("sockets without prependListener still wrap existing userQuery listeners", async () => {
  resetQuerySenderCaptureForTests();
  const socket = new EventEmitter();
  socket.prependListener = undefined;
  socket.prependAny = undefined;
  let laterSawStack = undefined;
  globalThis.CONFIG = {
    queries: {
      [QUERY_NAME]: () => {
        laterSawStack = takeSocketQuerySender();
      }
    }
  };

  installQuerySenderCapture(QUERY_NAME, socket);
  await new Promise((resolve) => {
    socket.emit("userQuery", "player-2", "qid-2", QUERY_NAME, {}, {}, resolve);
  });

  assert.equal(laterSawStack, "player-2");
});

test("socket.io-like sockets wrap named userQuery listeners even when prependAny exists", async () => {
  resetQuerySenderCaptureForTests();
  const socket = new EventEmitter();
  socket.prependAny = () => {};
  socket.prependListener = undefined;
  let laterSawStack = undefined;
  globalThis.CONFIG = {
    queries: {
      [QUERY_NAME]: () => {
        laterSawStack = takeSocketQuerySender();
      }
    }
  };

  installQuerySenderCapture(QUERY_NAME, socket);
  await new Promise((resolve) => {
    socket.emit("userQuery", "player-2", "qid-3", QUERY_NAME, {}, {}, resolve);
  });

  assert.equal(laterSawStack, "player-2");
  assert.equal(socket.__qmQuerySenderCapture, "wrap");
});

test("v13 wrap acks CONFIG.queries with the server-authenticated user and does not double-dispatch", async () => {
  resetQuerySenderCaptureForTests();
  const socket = new EventEmitter();
  let foundryCalls = 0;
  socket.on("userQuery", () => {
    foundryCalls += 1;
  });
  const player = { id: "player-2" };
  globalThis.game = { users: { get: (id) => (id === "player-2" ? player : null) } };
  const seen = [];
  globalThis.CONFIG = {
    queries: {
      [QUERY_NAME]: async (data, options) => {
        seen.push({ data, userId: options.user?.id ?? options.userId });
        return { status: "ok", data };
      }
    }
  };

  installQuerySenderCapture(QUERY_NAME, socket);
  const ack = await new Promise((resolve) => {
    socket.emit("userQuery", "player-2", "qid-4", QUERY_NAME, { probe: true }, { timeout: 5 }, resolve);
  });

  assert.equal(foundryCalls, 0);
  assert.equal(ack.status, "fulfilled");
  assert.equal(ack.value.status, "ok");
  assert.deepEqual(seen, [{ data: { probe: true }, userId: "player-2" }]);
});

test("wrap path does not capture sender when ack is not a function", () => {
  resetQuerySenderCaptureForTests();
  const socket = new EventEmitter();
  socket.prependListener = undefined;
  socket.prependAny = undefined;
  let laterSawStack = undefined;
  socket.on("userQuery", () => {
    laterSawStack = takeSocketQuerySender();
  });

  installQuerySenderCapture(QUERY_NAME, socket);
  socket.emit("userQuery", "player-2", "qid-no-ack", QUERY_NAME, {}, {}, "not-a-function");

  assert.equal(laterSawStack, undefined);
  assert.equal(takeSocketQuerySender(), undefined);
});

test("prepend path does not capture sender when ack is not a function", () => {
  resetQuerySenderCaptureForTests();
  const socket = new EventEmitter();
  socket.listeners = undefined;
  socket.off = undefined;
  let laterSawStack = undefined;
  socket.on("userQuery", () => {
    laterSawStack = takeSocketQuerySender();
  });

  installQuerySenderCapture(QUERY_NAME, socket);
  assert.equal(socket.__qmQuerySenderCapture, "prepend");
  socket.emit("userQuery", "player-2", "qid-no-ack-prepend", QUERY_NAME, {}, {}, "not-a-function");

  assert.equal(laterSawStack, undefined);
  assert.equal(takeSocketQuerySender(), undefined);
});
