import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1");

test("v1 manifest is system agnostic and uses a version-specific artifact", () => {
  const manifest = JSON.parse(readFileSync(join(root, "module.json"), "utf8"));
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.relationships?.systems, undefined);
  assert.match(manifest.download, /releases\/download\/v1\.0\.0\/module\.zip$/);
});

test("production startup does not eagerly import legacy console suites", () => {
  const entry = readFileSync(join(root, "scripts", "module.js"), "utf8");
  assert.doesNotMatch(entry, /from\s+["']\.\/test-step\d+\.js["']/);
  const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
  assert.match(attributes, /scripts\/test-step\*\.js\s+export-ignore/);
});

test("startup registers adapters before settings and gates runtime hooks on current storage", () => {
  const entry = readFileSync(join(root, "scripts", "module.js"), "utf8");
  const initStart = entry.indexOf('Hooks.once("init"');
  const readyStart = entry.indexOf('Hooks.once("ready"');
  const initBody = entry.slice(initStart, readyStart);
  assert.ok(initBody.indexOf("initializeSystemAdapters()") < initBody.indexOf("registerSettings(adapter)"));
  assert.doesNotMatch(initBody, /registerSocketHandler\(\)/);
  assert.match(
    entry,
    /await prepareRuntimeStorage\(\);[\s\S]*catch \(error\)[\s\S]*return;[\s\S]*registerRuntimeHooks\(\)/
  );
  assert.ok(
    entry.indexOf('Hooks.on("renderActorDirectory"') > entry.indexOf("function registerRuntimeHooks()")
  );
  assert.match(entry, /await TransactionLog\.refreshPublicProjection\(\)/);
  assert.match(entry, /if \(!game\.user\?\.isGM\)[\s\S]*deferPlayerRuntimeActivation\(\)[\s\S]*return;/);
  assert.match(entry, /Hooks\.on\("updateActor"[\s\S]*tryActivateDeferredPlayerRuntime/);
  assert.match(
    entry,
    /if \(!hasCurrentStorageSchema\(backingActor\)\) return false;[\s\S]*registerRuntimeHooks\(\)/
  );
  assert.match(entry, /installPublicApi\(\{ runtimeReady: false \}\)/);
  assert.match(entry, /if \(!registerRuntimeHooks\(\)\)[\s\S]*return;[\s\S]*installPublicApi\(\{ runtimeReady: true \}\)/);

  const inactiveGate = entry.indexOf("game.user?.isGM && !isActiveStorageGM()");
  assert.ok(inactiveGate > readyStart && inactiveGate < entry.indexOf("await prepareRuntimeStorage()"));
  assert.match(entry, /if \(game\.user\?\.isGM && !isActiveStorageGM\(\)\) return false;/);
  assert.match(entry, /Hooks\.on\("updateUser"[\s\S]*Hooks\.on\("userConnected"/);
  assert.match(
    entry,
    /function suspendInactiveGmRuntime\(\)[\s\S]*installPublicApi\(\{ runtimeReady: false \}\)[\s\S]*closeInventoryApp\(\)[\s\S]*closeLootPrepApp\(\)[\s\S]*closeTransactionLogApp\(\)/
  );

  const storage = readFileSync(join(root, "scripts", "backing-actor.js"), "utf8");
  assert.match(storage, /export async function ensureStorageActors\(\)[\s\S]*if \(!isActiveStorageGM\(\)\)/);
  const migration = readFileSync(join(root, "scripts", "storage-migration.js"), "utf8");
  assert.match(migration, /if \(!isActiveStorageGM\(\)\) return \{ migrated: false, reason: "active-gm-only" \}/);

  const settings = readFileSync(join(root, "scripts", "settings.js"), "utf8");
  const visibilityStart = settings.indexOf("SETTINGS.TRANSACTION_LOG_VISIBILITY");
  const visibilityEnd = settings.indexOf("// Operation Coordinator", visibilityStart);
  const visibilityBlock = settings.slice(visibilityStart, visibilityEnd);
  assert.match(visibilityBlock, /onChange:\s*async/);
  assert.match(visibilityBlock, /game\.user\?\.isGM/);
  assert.match(visibilityBlock, /TransactionLog\.refreshPublicProjection\(\)/);
});

test("release workflow requires a separate manually authorized publication", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /push:\s*\n\s*tags:/);
  assert.match(workflow, /environment:\s*foundry-publication/);
  assert.match(workflow, /artifacts\/system-agnostic\/module\.json/);
  assert.match(workflow, /artifacts\/system-agnostic\/module\.zip\.sha256/);
  assert.match(workflow, /artifacts\/system-agnostic\/module\.zip\.contents\.txt/);
});

test("package validation emits checksum, contents, and archived manifest evidence", () => {
  const validator = readFileSync(join(root, "tools", "validate-package.mjs"), "utf8");
  assert.match(validator, /createHash\("sha256"\)/);
  assert.match(validator, /module\.zip\.sha256/);
  assert.match(validator, /module\.zip\.contents\.txt/);
  assert.match(validator, /writeFileSync\(manifestPath, archivedManifestBytes\)/);
});
