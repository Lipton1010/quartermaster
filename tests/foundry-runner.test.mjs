import assert from "node:assert/strict";
import test from "node:test";
import { runFoundrySuites } from "./foundry/runner.mjs";

test("the in-world runner scores assertion arrays, counter summaries and missing results", async () => {
  globalThis.game = { user: { isGM: true }, system: { id: "dnd5e" } };
  const values = new Map([
    ["step3", [{ pass: true }]], ["step4", [{ pass: true }, { pass: false }]],
    ["step7", []], ["step8", undefined], ["step9", { pass: 1, fail: 0, total: 2 }],
    ["step15", { pass: 2, fail: 0, total: 2 }], ["step16", { pass: 1, fail: 1, total: 2 }],
    ["step17", { pass: 0, fail: 0, total: 0 }]
  ]);
  const visited = [];
  const loader = suite => {
    visited.push(suite.id);
    return { [suite.run]: () => values.get(suite.id) };
  };
  const ids = [...values.keys()];
  const report = await runFoundrySuites({ ids }, loader);
  assert.equal(report.selected, ids.length);
  assert.deepEqual(report.results.map(row => row.status), [
    "passed", "failed", "failed", "failed", "failed", "passed", "failed", "failed"
  ]);
  assert.deepEqual(report.results[1].value, values.get("step4"));
  for (const failingId of ["step4", "step16", "step8"]) {
    visited.length = 0;
    const stopped = await runFoundrySuites({ ids: ["step3", failingId, "step18"], stopOnFailure: true }, loader);
    assert.deepEqual(visited, ["step3", failingId]);
    assert.equal(stopped.results.at(-1).status, "failed");
  }
});
