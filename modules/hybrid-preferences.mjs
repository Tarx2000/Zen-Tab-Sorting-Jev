import { CONFIG } from "./config.mjs";

export const FALLBACK_PROVIDERS = ["chatgpt", "primalabs", "openai", "gemini", "ollama", "custom"];

// Retain provider credentials and migrate the former standalone selection into
// stage 2. The supported product flow always uses Jev followed by an LLM.
export const ensureHybridPreferences = (prefs = globalThis.Services?.prefs) => {
  if (!prefs) return;
  const read = (name, fallback) => {
    try { return prefs.getStringPref(name, fallback).trim(); } catch { return fallback; }
  };
  const engine = read(CONFIG.AI_ENGINE_PREF, "jev");
  let fallback = read(CONFIG.AI_FALLBACK_PROVIDER_PREF, "");
  if (!FALLBACK_PROVIDERS.includes(fallback)) {
    fallback = FALLBACK_PROVIDERS.includes(engine) ? engine : "chatgpt";
    prefs.setStringPref(CONFIG.AI_FALLBACK_PROVIDER_PREF, fallback);
  } else if (FALLBACK_PROVIDERS.includes(engine)) {
    // A former standalone provider was the user's active choice.
    prefs.setStringPref(CONFIG.AI_FALLBACK_PROVIDER_PREF, engine);
  }
  if (engine !== "jev" || !prefs.prefHasUserValue(CONFIG.AI_ENGINE_PREF)) {
    prefs.setStringPref(CONFIG.AI_ENGINE_PREF, "jev");
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
};
