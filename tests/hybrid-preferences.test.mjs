import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../modules/config.mjs";
import {
  CURRENT_MIGRATION_VERSION,
  FALLBACK_PROVIDERS,
  MIGRATION_VERSION_PREF,
  ensureHybridPreferences,
} from "../modules/hybrid-preferences.mjs";

const prefsWith = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getStringPref: (name, fallback) => values.get(name) ?? fallback,
    getBoolPref: (name, fallback) => values.get(name) ?? fallback,
    prefHasUserValue: (name) => values.has(name),
    setStringPref: (name, value) => values.set(name, value),
  };
};

test("A former standalone LLM becomes stage 2 without changing its credentials or model", () => {
  const prefs = prefsWith({
    [CONFIG.AI_ENGINE_PREF]: "openai",
    [CONFIG.AI_OPENAI_API_KEY_PREF]: "test-only",
    [CONFIG.AI_OPENAI_MODEL_PREF]: "chosen-model",
    [CONFIG.AI_CHATGPT_SESSION_PREF]: "saved-session",
  });
  ensureHybridPreferences(prefs);
  assert.equal(prefs.values.get(CONFIG.AI_ENGINE_PREF), "jev");
  assert.equal(prefs.values.get(CONFIG.AI_FALLBACK_PROVIDER_PREF), "openai");
  assert.equal(prefs.values.get(CONFIG.AI_OPENAI_API_KEY_PREF), "test-only");
  assert.equal(prefs.values.get(CONFIG.AI_OPENAI_MODEL_PREF), "chosen-model");
  assert.equal(prefs.values.get(CONFIG.AI_CHATGPT_SESSION_PREF), "saved-session");
  assert.equal(prefs.values.get(MIGRATION_VERSION_PREF), String(CURRENT_MIGRATION_VERSION));
  const before = [...prefs.values];
  ensureHybridPreferences(prefs);
  assert.deepEqual([...prefs.values], before);
});

test("Existing hybrid and explicit off/local/ollama choices remain intact without being overwritten", () => {
  assert.ok(FALLBACK_PROVIDERS.includes("off"));

  const prefs = prefsWith({
    [CONFIG.AI_ENGINE_PREF]: "jev",
    [CONFIG.AI_FALLBACK_PROVIDER_PREF]: "ollama",
  });
  ensureHybridPreferences(prefs);
  assert.equal(prefs.values.get(CONFIG.AI_FALLBACK_PROVIDER_PREF), "ollama");

  const disabledFallback = prefsWith({
    [CONFIG.AI_ENGINE_PREF]: "jev",
    [CONFIG.AI_FALLBACK_PROVIDER_PREF]: "off",
  });
  ensureHybridPreferences(disabledFallback);
  assert.equal(disabledFallback.values.get(CONFIG.AI_FALLBACK_PROVIDER_PREF), "off");

  for (const preservedEngine of ["off", "local", "ollama"]) {
    const standalone = prefsWith({ [CONFIG.AI_ENGINE_PREF]: preservedEngine });
    ensureHybridPreferences(standalone);
    assert.equal(standalone.values.get(CONFIG.AI_ENGINE_PREF), preservedEngine);
  }

  // Once migration-version is recorded, later startups never overwrite user changes.
  const postMigration = prefsWith({
    [MIGRATION_VERSION_PREF]: String(CURRENT_MIGRATION_VERSION),
    [CONFIG.AI_ENGINE_PREF]: "openai",
    [CONFIG.AI_FALLBACK_PROVIDER_PREF]: "off",
  });
  ensureHybridPreferences(postMigration);
  assert.equal(postMigration.values.get(CONFIG.AI_ENGINE_PREF), "openai");
  assert.equal(postMigration.values.get(CONFIG.AI_FALLBACK_PROVIDER_PREF), "off");
});

test("Old grouping options migrate to the matching scope and preview settings", () => {
  const fresh = prefsWith({ [CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF]: "fresh-categories" });
  ensureHybridPreferences(fresh);
  assert.equal(fresh.values.get(CONFIG.AI_SORT_MODE_PREF), "full-ai");
  assert.equal(fresh.values.get(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF), "transient");
  const preview = prefsWith({
    [CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF]: "prompt",
    [CONFIG.AI_SORT_MODE_PREF]: "hybrid",
  });
  ensureHybridPreferences(preview);
  assert.equal(preview.values.get(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF), "identify-only");
  assert.equal(preview.values.get(CONFIG.AI_SORT_MODE_PREF), "rules-first");
});
