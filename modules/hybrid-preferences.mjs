// Zen Tab Sorting — One-time preference migration for hybrid / multi-provider mode.
//
// Gated behind a `migration-version` preference so user choices (`"off"`,
// `"local"`, `"ollama"`, or any of the 18 provider presets) are NEVER
// unconditionally overwritten on subsequent browser startups.

import { CONFIG } from "./config.mjs";
import { PROVIDER_PRESETS } from "./provider-registry.mjs";

export const MIGRATION_VERSION_PREF =
  CONFIG.MIGRATION_VERSION_PREF || "extensions.zen-auto-organize.migration-version";
export const CURRENT_MIGRATION_VERSION = 2;

export const FALLBACK_PROVIDERS = [
  "off",
  ...PROVIDER_PRESETS.map((preset) => preset.id),
];

// Engines that a user may explicitly choose to run standalone without JEV;
// never clobber them during one-time migration.
const PRESERVED_STANDALONE_ENGINES = new Set(["off", "local", "ollama"]);

// Former standalone remote engines that migrate into stage 2 (fallback provider)
// while switching `ai-engine` to `"jev"` on the one-time upgrade.
const MIGRATABLE_REMOTE_ENGINES = new Set(
  PROVIDER_PRESETS.filter((p) => p.id !== "ollama").map((p) => p.id),
);

/**
 * One-time preference migration. Once `migration-version` reaches
 * `CURRENT_MIGRATION_VERSION`, subsequent calls are a complete no-op so
 * user edits (`"off"`, `"local"`, `"ollama"`, etc.) are always respected.
 */
export const ensureHybridPreferences = (prefs = globalThis.Services?.prefs) => {
  if (!prefs) return;

  const read = (name, fallback) => {
    try {
      return prefs.getStringPref(name, fallback).trim();
    } catch {
      return fallback;
    }
  };

  // Gate behind one-time migration version so startup never clobbers explicit user choices.
  const currentVersion = Number.parseInt(read(MIGRATION_VERSION_PREF, "0"), 10) || 0;
  if (currentVersion >= CURRENT_MIGRATION_VERSION) return;

  const hasEngine = Boolean(prefs.prefHasUserValue?.(CONFIG.AI_ENGINE_PREF));
  const engine = read(CONFIG.AI_ENGINE_PREF, "jev");
  let fallback = read(CONFIG.AI_FALLBACK_PROVIDER_PREF, "");

  if (hasEngine && PRESERVED_STANDALONE_ENGINES.has(engine)) {
    // Respect explicit standalone `"off"`, `"local"`, or `"ollama"` selection.
    if (!FALLBACK_PROVIDERS.includes(fallback) && engine === "ollama") {
      prefs.setStringPref(CONFIG.AI_FALLBACK_PROVIDER_PREF, "ollama");
    }
  } else {
    if (!FALLBACK_PROVIDERS.includes(fallback)) {
      fallback = MIGRATABLE_REMOTE_ENGINES.has(engine) ? engine : "chatgpt";
      prefs.setStringPref(CONFIG.AI_FALLBACK_PROVIDER_PREF, fallback);
    } else if (MIGRATABLE_REMOTE_ENGINES.has(engine)) {
      // A former standalone remote provider was the user's active choice.
      prefs.setStringPref(CONFIG.AI_FALLBACK_PROVIDER_PREF, engine);
    }
    if (engine !== "jev" || !hasEngine) {
      prefs.setStringPref(CONFIG.AI_ENGINE_PREF, "jev");
    }
  }

  if (read(CONFIG.AI_SORT_MODE_PREF, "") === "hybrid") {
    prefs.setStringPref(CONFIG.AI_SORT_MODE_PREF, "rules-first");
  }

  const behavior = read(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "transient");
  if (behavior === "fresh-categories") {
    prefs.setStringPref(CONFIG.AI_SORT_MODE_PREF, "full-ai");
    prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "transient");
  } else if (behavior === "auto-add" && !prefs.getBoolPref(CONFIG.USE_DOMAIN_RULES_PREF, false)) {
    prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "transient");
  } else if (behavior === "prompt") {
    prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "identify-only");
  }

  try {
    prefs.setStringPref(MIGRATION_VERSION_PREF, String(CURRENT_MIGRATION_VERSION));
  } catch {}
};
