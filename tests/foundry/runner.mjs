/**
 * Adapter-aware in-world development runner.
 *
 * This file is intentionally excluded from release archives. Import it from a
 * development installation and call `runFoundrySuites()` in the browser
 * console. Legacy suites are loaded only when selected, so production startup
 * never imports test fixtures.
 */

const SUITES = Object.freeze([
  { id: "step3",  file: "../../scripts/test-step3.js",  run: "runStep3Tests" },
  { id: "step4",  file: "../../scripts/test-step4.js",  run: "runStep4Tests" },
  { id: "step7",  file: "../../scripts/test-step7.js",  run: "runStep7Tests",  systems: ["dnd5e"] },
  { id: "step8",  file: "../../scripts/test-step8.js",  run: "runStep8Tests",  cleanup: "cleanupStep8Fixtures", systems: ["dnd5e"] },
  { id: "step9",  file: "../../scripts/test-step9.js",  run: "runStep9Tests",  cleanup: "cleanupStep9Fixtures", systems: ["dnd5e"] },
  { id: "step10", file: "../../scripts/test-step10.js", run: "runStep10Tests", cleanup: "cleanupStep10Fixtures", systems: ["dnd5e"] },
  { id: "step11", file: "../../scripts/test-step11.js", run: "runStep11Tests" },
  { id: "step13", file: "../../scripts/test-step13.js", run: "runStep13Tests" },
  { id: "step14", file: "../../scripts/test-step14.js", run: "runStep14Tests", cleanup: "cleanupStep14Fixtures" },
  { id: "step15", file: "../../scripts/test-step15.js", run: "runStep15Tests", cleanup: "cleanupStep15Fixtures", systems: ["dnd5e"] },
  { id: "step16", file: "../../scripts/test-step16.js", run: "runStep16Tests", cleanup: "cleanupStep16Fixtures", systems: ["dnd5e"] },
  { id: "step17", file: "../../scripts/test-step17.js", run: "runStep17Tests", cleanup: "cleanupStep17Fixtures" },
  { id: "step18", file: "../../scripts/test-step18.js", run: "runStep18Tests", cleanup: "cleanupStep18Fixtures", systems: ["dnd5e"] }
]);

function currentSystemId() {
  return globalThis.game?.system?.id ?? "generic";
}

function appliesToSystem(suite, systemId) {
  return !suite.systems || suite.systems.includes(systemId);
}

export function listFoundrySuites({ includeIncompatible = false } = {}) {
  const systemId = currentSystemId();
  return SUITES
    .filter(suite => includeIncompatible || appliesToSystem(suite, systemId))
    .map(suite => ({ ...suite, compatible: appliesToSystem(suite, systemId) }));
}

async function loadSuite(suite) {
  return import(suite.file);
}

export async function runFoundrySuites({ ids = null, stopOnFailure = false } = {}) {
  if (!globalThis.game?.user?.isGM) throw new Error("Quartermaster development suites require a GM user.");

  const systemId = currentSystemId();
  const selected = SUITES.filter(suite =>
    appliesToSystem(suite, systemId) && (!ids || ids.includes(suite.id))
  );
  const results = [];

  for (const suite of selected) {
    try {
      const module = await loadSuite(suite);
      const run = module[suite.run];
      if (typeof run !== "function") throw new Error(`Missing ${suite.run}`);
      const value = await run();
      results.push({ id: suite.id, status: "passed", value });
    } catch (error) {
      results.push({ id: suite.id, status: "failed", error });
      if (stopOnFailure) break;
    }
  }

  return { systemId, selected: selected.length, results };
}

export async function cleanupFoundrySuites({ ids = null } = {}) {
  if (!globalThis.game?.user?.isGM) throw new Error("Quartermaster development cleanup requires a GM user.");

  const selected = SUITES.filter(suite => suite.cleanup && (!ids || ids.includes(suite.id)));
  const results = [];
  for (const suite of selected) {
    try {
      const module = await loadSuite(suite);
      const cleanup = module[suite.cleanup];
      if (typeof cleanup !== "function") throw new Error(`Missing ${suite.cleanup}`);
      await cleanup();
      results.push({ id: suite.id, status: "cleaned" });
    } catch (error) {
      results.push({ id: suite.id, status: "failed", error });
    }
  }
  return results;
}
