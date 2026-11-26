import test from "node:test";
import assert from "node:assert/strict";

import { MODULE_ID, SETTINGS } from "../scripts/constants.js";
import { registerSettings } from "../scripts/settings.js";
import { dnd5eAdapter } from "../scripts/system-adapters/dnd5e.js";
import { genericAdapter } from "../scripts/system-adapters/generic.js";

function collectRegistrations(adapter) {
  const registrations = new Map();
  globalThis.game = {
    settings: {
      register(namespace, key, config) {
        assert.equal(namespace, MODULE_ID);
        registrations.set(key, config);
      }
    }
  };
  registerSettings(adapter);
  return registrations;
}

test("generic systems register unsupported metadata settings as hidden", () => {
  const settings = collectRegistrations(genericAdapter);

  assert.equal(settings.get(SETTINGS.UNIDENTIFIED_DISPLAY)?.config, false);
  assert.equal(settings.get(SETTINGS.HIDE_PRICES_FROM_PLAYERS)?.config, false);
  assert.ok(settings.has(SETTINGS.UNIDENTIFIED_DISPLAY));
  assert.ok(settings.has(SETTINGS.HIDE_PRICES_FROM_PLAYERS));
});

test("D&D retains its identification and price settings", () => {
  const settings = collectRegistrations(dnd5eAdapter);

  assert.equal(settings.get(SETTINGS.UNIDENTIFIED_DISPLAY)?.config, true);
  assert.equal(settings.get(SETTINGS.HIDE_PRICES_FROM_PLAYERS)?.config, true);
  assert.equal(settings.get(SETTINGS.MUTATION_RATE_LIMIT_MAX)?.default, 30);
  assert.equal(settings.get(SETTINGS.MUTATION_RATE_LIMIT_WINDOW_MS)?.default, 10000);
});
