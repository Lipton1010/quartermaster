/**
 * Per-user sliding-window limiter for authenticated mutation dispatch.
 * Fail-closed on a missing sender. A configured max of 0 disables the limiter.
 * Invalid or negative settings fall back to the conservative defaults.
 */

import { MODULE_ID, SETTINGS } from "./constants.js";

export const DEFAULT_MUTATION_RATE_LIMIT = Object.freeze({
  max: 30,
  windowMs: 10_000
});

const timestampsByUser = new Map();

function asFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function readMutationRateLimitConfig(getSetting = defaultGetSetting) {
  const max = asFiniteNumber(getSetting(SETTINGS.MUTATION_RATE_LIMIT_MAX));
  const windowMs = asFiniteNumber(getSetting(SETTINGS.MUTATION_RATE_LIMIT_WINDOW_MS));
  return {
    max: max === null || max < 0 ? DEFAULT_MUTATION_RATE_LIMIT.max : Math.floor(max),
    windowMs:
      windowMs === null || windowMs <= 0
        ? DEFAULT_MUTATION_RATE_LIMIT.windowMs
        : Math.floor(windowMs)
  };
}

function defaultGetSetting(key) {
  try {
    return globalThis.game?.settings?.get(MODULE_ID, key);
  } catch {
    return undefined;
  }
}

/** @internal */
export function resetMutationRateLimitForTests() {
  timestampsByUser.clear();
}

/**
 * @param {string} userId
 * @param {number} [now]
 * @param {{ max: number, windowMs: number }} [config]
 * @returns {{ allowed: boolean, error?: string, remaining?: number }}
 */
export function consumeMutationSlot(userId, now = Date.now(), config = readMutationRateLimitConfig()) {
  if (typeof userId !== "string" || !userId) {
    return { allowed: false, error: "unknown-sender" };
  }

  const max = config?.max;
  const windowMs = config?.windowMs;
  if (!Number.isFinite(max) || max < 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return consumeMutationSlot(userId, now, DEFAULT_MUTATION_RATE_LIMIT);
  }

  if (max === 0) {
    return { allowed: true, remaining: Infinity };
  }

  const cutoff = now - windowMs;
  const prior = timestampsByUser.get(userId) ?? [];
  const recent = prior.filter((ts) => ts > cutoff);
  if (recent.length >= max) {
    timestampsByUser.set(userId, recent);
    return { allowed: false, error: "rate-limited", remaining: 0 };
  }

  recent.push(now);
  timestampsByUser.set(userId, recent);
  return { allowed: true, remaining: max - recent.length };
}
