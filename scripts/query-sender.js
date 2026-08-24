/**
 * Authenticated sender identity for CONFIG.queries handlers.
 *
 * Foundry v14 calls the handler with `{ user }`. Foundry v13.351 rebuilds
 * options as `{ timeout }` only. The querying user id is the first `userQuery`
 * socket argument, rewritten by the server from the connection session.
 * Never fall back to payload.userId.
 */

const querySenderStack = [];
let capturedQueryName = null;

/**
 * @param {object} [options]
 * @param {string|null|undefined} socketSenderId
 * @returns {string|null}
 */
export function resolveAuthenticatedQuerySender(options = {}, socketSenderId) {
  const authenticatedUser = options.user ?? null;
  const optionId =
    typeof authenticatedUser?.id === "string" && authenticatedUser.id ? authenticatedUser.id : null;
  const fromSocket = typeof socketSenderId === "string" && socketSenderId ? socketSenderId : null;
  if (optionId && fromSocket && optionId !== fromSocket) return null;
  return optionId ?? fromSocket;
}

function captureSocketQuerySender(userId, _queryId, queryName) {
  if (queryName !== capturedQueryName) return;
  querySenderStack.push(typeof userId === "string" && userId ? userId : null);
}

export function takeSocketQuerySender() {
  return querySenderStack.length ? querySenderStack.pop() : undefined;
}

export function installQuerySenderCapture(queryName, socket = globalThis.game?.socket) {
  capturedQueryName = queryName;
  if (!socket) return;

  if (typeof socket.listeners === "function" && typeof socket.off === "function" && typeof socket.on === "function") {
    const current = socket.listeners("userQuery").slice();
    const originals = current.filter((fn) => fn.name !== "qmCaptureUserQuery");
    for (const listener of current) socket.off("userQuery", listener);
    socket.on("userQuery", function qmCaptureUserQuery(userId, queryId, name, queryData, queryOptions, ack, ...rest) {
      if (typeof ack === "function") {
        captureSocketQuerySender(userId, queryId, name);
      }
      if (name === capturedQueryName && typeof ack === "function") {
        const user = globalThis.game?.users?.get?.(userId) ?? null;
        const options = {
          ...(queryOptions && typeof queryOptions === "object" ? queryOptions : {}),
          userId,
          user
        };
        const handler = globalThis.CONFIG?.queries?.[capturedQueryName];
        Promise.resolve()
          .then(() => {
            if (typeof handler !== "function") throw new Error("query-handler-missing");
            return handler(queryData, options);
          })
          .then((value) => ack({ status: "fulfilled", value }))
          .catch((error) => ack({ status: "rejected", reason: error?.message ?? String(error) }));
        return;
      }
      for (const listener of originals) {
        listener.call(this, userId, queryId, name, queryData, queryOptions, ack, ...rest);
      }
    });
    socket.__qmQuerySenderCapture = "wrap";
    return;
  }

  if (typeof socket.prependListener === "function") {
    socket.prependListener("userQuery", (userId, queryId, queryName, _queryData, _queryOptions, ack) => {
      if (typeof ack === "function") {
        captureSocketQuerySender(userId, queryId, queryName);
      }
    });
    socket.__qmQuerySenderCapture = "prepend";
  }
}

/** @internal */
export function resetQuerySenderCaptureForTests() {
  querySenderStack.length = 0;
  capturedQueryName = null;
}
