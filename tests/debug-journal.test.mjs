import test from "node:test";
import assert from "node:assert/strict";
import {
  isDebugMode,
  recordDebugEvent,
  getDebugEvents,
  clearDebugEvents,
  formatDebugEventsAsText,
  detectQuotaOrRateLimit,
} from "../modules/debug-journal.mjs";
import { CONFIG } from "../modules/config.mjs";

test("Given debug mode disabled When recording events Then buffer remains empty", () => {
  const prefStore = new Map([[CONFIG.DEBUG_MODE_PREF, false]]);
  globalThis.Services = {
    prefs: {
      getBoolPref: (key, fallback) => prefStore.get(key) ?? fallback,
      prefHasUserValue: (key) => prefStore.has(key),
      getStringPref: (key) => prefStore.get(key) || "",
      setStringPref: (key, val) => prefStore.set(key, val),
    },
  };
  clearDebugEvents();
  assert.equal(isDebugMode(), false);
  recordDebugEvent("TEST", "Should not record");
  assert.equal(getDebugEvents().length, 0);
  assert.match(formatDebugEventsAsText(), /DEAKTIVIERT/);
});

test("Given debug mode enabled When recording events Then buffer records and formats cleanly", () => {
  const prefStore = new Map([[CONFIG.DEBUG_MODE_PREF, true]]);
  globalThis.Services = {
    prefs: {
      getBoolPref: (key, fallback) => prefStore.get(key) ?? fallback,
      prefHasUserValue: (key) => prefStore.has(key),
      getStringPref: (key) => prefStore.get(key) || "",
      setStringPref: (key, val) => prefStore.set(key, val),
    },
  };
  clearDebugEvents();
  assert.equal(isDebugMode(), true);

  recordDebugEvent("STAGE-1", "Test event", { sensitiveKey: "Bearer sk-1234567890abcdef" });
  const events = getDebugEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].stage, "STAGE-1");
  assert.equal(events[0].summary, "Test event");

  const formatted = formatDebugEventsAsText();
  assert.match(formatted, /\[STAGE-1\] Test event/);

  clearDebugEvents();
  assert.equal(getDebugEvents().length, 0);
});

test("Given 429 status or quota keyword When checking rate limits Then detectQuotaOrRateLimit identifies it", () => {
  const check429 = detectQuotaOrRateLimit(429, "Too many requests", "");
  assert.equal(check429.isQuota, true);
  assert.match(check429.userMessage, /Usage-Limit erreicht/);

  const checkQuotaText = detectQuotaOrRateLimit(400, '{"error":{"code":"insufficient_quota"}}', "");
  assert.equal(checkQuotaText.isQuota, true);

  const checkUsageLimitText = detectQuotaOrRateLimit(200, "", "Usage limit reached for model");
  assert.equal(checkUsageLimitText.isQuota, true);

  const checkNormalError = detectQuotaOrRateLimit(500, "Internal Server Error", "server crash");
  assert.equal(checkNormalError.isQuota, false);
});
