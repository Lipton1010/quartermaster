import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { SETTINGS } from "../scripts/constants.js";
import {
  consumeMutationSlot,
  readMutationRateLimitConfig,
  resetMutationRateLimitForTests,
  DEFAULT_MUTATION_RATE_LIMIT
} from "../scripts/mutation-rate-limit.js";

beforeEach(() => {
  resetMutationRateLimitForTests();
});

test("a missing sender fails closed without recording a slot", () => {
  const denied = consumeMutationSlot("", 1000, { max: 2, windowMs: 1000 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.error, "unknown-sender");
  const first = consumeMutationSlot("player-1", 1000, { max: 1, windowMs: 1000 });
  assert.equal(first.allowed, true);
});

test("users are limited independently inside the sliding window", () => {
  const cfg = { max: 2, windowMs: 1000 };
  assert.equal(consumeMutationSlot("a", 100, cfg).allowed, true);
  assert.equal(consumeMutationSlot("a", 200, cfg).allowed, true);
  assert.equal(consumeMutationSlot("a", 300, cfg).allowed, false);
  assert.equal(consumeMutationSlot("b", 300, cfg).allowed, true);
});

test("slots expire after the window so later mutations are allowed", () => {
  const cfg = { max: 1, windowMs: 1000 };
  assert.equal(consumeMutationSlot("a", 1000, cfg).allowed, true);
  assert.equal(consumeMutationSlot("a", 1999, cfg).allowed, false);
  assert.equal(consumeMutationSlot("a", 2001, cfg).allowed, true);
});

test("max 0 disables the limiter", () => {
  const cfg = { max: 0, windowMs: 1000 };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(consumeMutationSlot("a", i, cfg).allowed, true);
  }
});

test("invalid settings fall back to the conservative defaults", () => {
  const cfg = readMutationRateLimitConfig((key) => {
    if (key === SETTINGS.MUTATION_RATE_LIMIT_MAX) return -4;
    if (key === SETTINGS.MUTATION_RATE_LIMIT_WINDOW_MS) return "nope";
    return undefined;
  });
  assert.deepEqual(cfg, { ...DEFAULT_MUTATION_RATE_LIMIT });
});
