// Zen Tab Sorting — Provider Settings, Structured Multi-Profile Storage,
// Fallback Chains, and Per-Task Model Profiles.
//
// Preserves full backward compatibility with legacy `ai-*-*` preferences while
// adding structured `ai-provider-profiles-json`, fallback chain configuration,
// and per-task profiles ("fast" | "deep" | "offline").

import { CONFIG } from "./config.mjs";
import { readChatGPTSession } from "./chatgpt-auth.mjs";
import {
  getProviderPreset,
  resolveAdapterKind,
  resolveProfileEndpoint,
} from "./provider-registry.mjs";
import { getCachedSecret } from "./secret-store.mjs";

export const AI_PROVIDER_PROFILES_PREF =
  CONFIG.AI_PROVIDER_PROFILES_PREF || "extensions.zen-auto-organize.ai-provider-profiles-json";
export const AI_FALLBACK_CHAIN_PREF = "extensions.zen-auto-organize.ai-fallback-chain-json";
export const AI_TASK_PROFILES_PREF = "extensions.zen-auto-organize.ai-task-profiles-json";

export const TASK_PROFILE_KINDS = Object.freeze(["fast", "deep", "offline"]);

// Forgive the common paste formats for a Gemini model id:
//   "models/gemini-2.5-flash"  (Google API docs format)  -> "gemini-2.5-flash"
//   "Gemini 2.5 Flash"         (display name)            -> "gemini-2.5-flash"
//   "  gemini-2.5-flash \n"    (stray whitespace)        -> "gemini-2.5-flash"
// The request URL is `v1beta/models/{model}:generateContent` with the model
// percent-encoded, so any of the raw forms above would 404.
export const normalizeGeminiModel = (value) => {
  let model = String(value ?? "").trim();
  if (model.toLowerCase().startsWith("models/")) model = model.slice("models/".length);
  // Display-name paste: spaces and/or uppercase — canonicalize to the id form.
  if (/\s/.test(model) || /[A-Z]/.test(model)) {
    model = model.toLowerCase().replace(/\s+/g, "-");
  }
  return model;
};

// All provider fields are copy-pasted by users; stray whitespace in an endpoint,
// key, or model is a classic invisible 401/404 cause, so trim every string read.
const readString = (prefs, name, fallback) => {
  try {
    return (prefs?.prefHasUserValue?.(name) && prefs.getPrefType(name) === prefs.PREF_STRING
      ? prefs.getStringPref(name)
      : fallback
    ).trim();
  } catch {
    return String(fallback || "").trim();
  }
};

const readBool = (prefs, name, fallback) => {
  try {
    return prefs?.prefHasUserValue?.(name) && prefs.getPrefType(name) === prefs.PREF_BOOL
      ? prefs.getBoolPref(name)
      : fallback;
  } catch {
    return fallback;
  }
};

const readJsonPref = (prefs, name) => {
  const raw = readString(prefs, name, "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJsonPref = (prefs, name, value) => {
  if (!prefs || typeof prefs.setStringPref !== "function") return false;
  try {
    prefs.setStringPref(name, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const resolveSecretOrPref = (prefs, secretKey, prefName) => {
  const cached = getCachedSecret(secretKey);
  if (cached) return cached;
  return prefName ? readString(prefs, prefName, "") : "";
};

// ─── Structured `ai-provider-profiles-json` Store & 1-Time Migration ─────────

const stripSecretsFromProfile = (profile) => {
  if (!profile || typeof profile !== "object") return null;
  const provider = String(profile.provider || "").trim().toLowerCase();
  if (!provider) return null;
  const preset = getProviderPreset(provider);
  const id = String(profile.id || provider).trim();
  const normalizedModel = provider === "gemini"
    ? normalizeGeminiModel(profile.model || "")
    : String(profile.model || "").trim();
  return {
    id,
    name: String(profile.name || preset?.name || provider).trim(),
    provider,
    adapter: resolveAdapterKind({ ...profile, provider }),
    endpoint: String(profile.endpoint ?? profile.baseUrl ?? preset?.defaultBaseUrl ?? "").trim(),
    model: normalizedModel || preset?.defaultModel || "",
    ...(profile.format ? { format: String(profile.format).trim() } : {}),
    ...(profile.apiVersion ? { apiVersion: String(profile.apiVersion).trim() } : {}),
    ...(profile.customHeaders && typeof profile.customHeaders === "object" ? { customHeaders: profile.customHeaders } : {}),
    ...(profile.keepAlive !== undefined ? { keepAlive: profile.keepAlive } : {}),
    ...(typeof profile.requiresKey === "boolean" ? { requiresKey: profile.requiresKey } : {}),
  };
};

const buildLegacyProfiles = (prefs) => {
  const profiles = [];
  const addIfConfigured = (profile) => {
    const clean = stripSecretsFromProfile(profile);
    if (clean) profiles.push(clean);
  };

  const ollamaHost = readString(prefs, CONFIG.AI_OLLAMA_HOST_PREF, "");
  const ollamaModel = readString(prefs, CONFIG.AI_OLLAMA_MODEL_PREF, "");
  if (ollamaHost || ollamaModel) {
    addIfConfigured({
      id: "ollama",
      provider: "ollama",
      endpoint: ollamaHost || CONFIG.AI_OLLAMA_HOST_DEFAULT,
      model: ollamaModel || CONFIG.AI_OLLAMA_MODEL_DEFAULT,
    });
  }

  const openAiEndpoint = readString(prefs, CONFIG.AI_OPENAI_ENDPOINT_PREF, "");
  const openAiModel = readString(prefs, CONFIG.AI_OPENAI_MODEL_PREF, "");
  const openAiKey = readString(prefs, CONFIG.AI_OPENAI_API_KEY_PREF, "");
  if (openAiEndpoint || openAiModel || openAiKey) {
    addIfConfigured({
      id: "openai",
      provider: "openai",
      endpoint: openAiEndpoint,
      model: openAiModel,
    });
  }

  const primaEndpoint = readString(prefs, CONFIG.AI_PRIMALABS_ENDPOINT_PREF, "");
  const primaModel = readString(prefs, CONFIG.AI_PRIMALABS_MODEL_PREF, "");
  const primaKey = readString(prefs, CONFIG.AI_PRIMALABS_API_KEY_PREF, "");
  if (primaEndpoint || primaModel || primaKey) {
    addIfConfigured({
      id: "primalabs",
      provider: "primalabs",
      endpoint: primaEndpoint || CONFIG.AI_PRIMALABS_ENDPOINT_DEFAULT,
      model: primaModel || CONFIG.AI_PRIMALABS_MODEL_DEFAULT,
    });
  }

  const chatgptModel = readString(prefs, CONFIG.AI_CHATGPT_MODEL_PREF, "");
  const chatgptSession = readChatGPTSession(prefs);
  if (chatgptModel || chatgptSession?.accessToken || chatgptSession?.refreshToken) {
    addIfConfigured({
      id: "chatgpt",
      provider: "chatgpt",
      model: chatgptModel || CONFIG.AI_CHATGPT_MODEL_DEFAULT,
    });
  }

  const geminiModel = normalizeGeminiModel(readString(prefs, CONFIG.AI_GEMINI_MODEL_PREF, ""));
  const geminiKey = readString(prefs, CONFIG.AI_GEMINI_API_KEY_PREF, "");
  if (geminiModel || geminiKey) {
    addIfConfigured({
      id: "gemini",
      provider: "gemini",
      model: geminiModel,
    });
  }

  const customEndpoint = readString(prefs, CONFIG.AI_CUSTOM_ENDPOINT_PREF, "");
  const customModel = readString(prefs, CONFIG.AI_CUSTOM_MODEL_PREF, "");
  const customFormat = readString(prefs, CONFIG.AI_CUSTOM_FORMAT_PREF, "openai");
  const customKey = readString(prefs, CONFIG.AI_CUSTOM_API_KEY_PREF, "");
  if (customEndpoint || customModel || customKey) {
    addIfConfigured({
      id: "custom",
      provider: "custom",
      endpoint: customEndpoint,
      model: customModel,
      format: customFormat === "ollama" ? "ollama" : customFormat || "openai",
    });
  }

  return profiles;
};

/**
 * Read the structured provider profiles store from `ai-provider-profiles-json`.
 * Automatically performs a one-time migration from legacy `ai-*-*` prefs when
 * the structured pref does not yet exist and `prefs` is writable.
 */
export const readProviderProfilesStore = (prefs = globalThis.Services?.prefs) => {
  const existing = readJsonPref(prefs, AI_PROVIDER_PROFILES_PREF);
  if (existing && typeof existing === "object" && Array.isArray(existing.profiles)) {
    return {
      version: Number(existing.version) || 1,
      activeProfileId: String(existing.activeProfileId || "").trim(),
      profiles: existing.profiles.map(stripSecretsFromProfile).filter(Boolean),
      migratedFromLegacy: Boolean(existing.migratedFromLegacy),
    };
  }

  const migrated = buildLegacyProfiles(prefs);
  const fallbackName = readString(prefs, CONFIG.AI_FALLBACK_PROVIDER_PREF, "chatgpt") || "chatgpt";
  const store = {
    version: 1,
    activeProfileId: fallbackName,
    profiles: migrated,
    migratedFromLegacy: true,
  };
  // Persist one-time migration only when prefs supports writes and at least one
  // legacy profile existed so empty/read-only test stubs stay untouched.
  if (migrated.length > 0 && typeof prefs?.setStringPref === "function") {
    writeJsonPref(prefs, AI_PROVIDER_PROFILES_PREF, store);
  }
  return store;
};

export const writeProviderProfilesStore = (prefs = globalThis.Services?.prefs, store) => {
  const sanitized = {
    version: 1,
    activeProfileId: String(store?.activeProfileId || "").trim(),
    profiles: (Array.isArray(store?.profiles) ? store.profiles : [])
      .map(stripSecretsFromProfile)
      .filter(Boolean),
    migratedFromLegacy: true,
  };
  writeJsonPref(prefs, AI_PROVIDER_PROFILES_PREF, sanitized);
  return sanitized;
};

export const listProviderProfiles = (prefs = globalThis.Services?.prefs) =>
  readProviderProfilesStore(prefs).profiles;

export const upsertProviderProfile = (prefs = globalThis.Services?.prefs, profile) => {
  const clean = stripSecretsFromProfile(profile);
  if (!clean) return null;
  const store = readProviderProfilesStore(prefs);
  const idx = store.profiles.findIndex((p) => p.id === clean.id);
  if (idx >= 0) store.profiles[idx] = clean;
  else store.profiles.push(clean);
  writeProviderProfilesStore(prefs, store);
  return clean;
};

export const deleteProviderProfile = (prefs = globalThis.Services?.prefs, profileId) => {
  const id = String(profileId || "").trim();
  if (!id) return false;
  const store = readProviderProfilesStore(prefs);
  const next = store.profiles.filter((p) => p.id !== id);
  if (next.length === store.profiles.length) return false;
  store.profiles = next;
  writeProviderProfilesStore(prefs, store);
  return true;
};

const hydrateStoredProfile = (prefs, storedProfile) => {
  const consentToSendData = readBool(prefs, CONFIG.AI_PROVIDER_CONSENT_PREF, false);
  const provider = storedProfile.provider;
  const preset = getProviderPreset(provider);
  const legacyPrefKeyMap = {
    openai: CONFIG.AI_OPENAI_API_KEY_PREF,
    primalabs: CONFIG.AI_PRIMALABS_API_KEY_PREF,
    gemini: CONFIG.AI_GEMINI_API_KEY_PREF,
    custom: CONFIG.AI_CUSTOM_API_KEY_PREF,
  };

  if (provider === "chatgpt") {
    const session = readChatGPTSession(prefs);
    return {
      ...storedProfile,
      provider: "chatgpt",
      adapter: "openai-responses",
      consentToSendData,
      model: storedProfile.model || readString(prefs, CONFIG.AI_CHATGPT_MODEL_PREF, CONFIG.AI_CHATGPT_MODEL_DEFAULT) || CONFIG.AI_CHATGPT_MODEL_DEFAULT,
      accessToken: session?.accessToken || "",
      refreshToken: session?.refreshToken || "",
      clientId: session?.clientId || "",
      expiresAt: session?.expiresAt || 0,
    };
  }

  const apiKey =
    getCachedSecret(`profile:${storedProfile.id}`) ||
    resolveSecretOrPref(prefs, provider, legacyPrefKeyMap[provider]);

  return {
    ...storedProfile,
    provider,
    adapter: resolveAdapterKind(storedProfile),
    consentToSendData,
    endpoint: storedProfile.endpoint || preset?.defaultBaseUrl || "",
    model: provider === "gemini" ? normalizeGeminiModel(storedProfile.model) : storedProfile.model,
    apiKey,
  };
};

// ─── Backward-Compatible Provider Settings Readers ───────────────────────────

export const readProviderSettingsForName = (prefs, providerName) => {
  const rawName = String(providerName || "off").trim() || "off";
  const provider = rawName.toLowerCase();
  if (provider === "off" || provider === "none") {
    return { provider: "off", consentToSendData: false };
  }
  if (provider === "local") return { provider, consentToSendData: false };

  // Check structured profile store first (matches by explicit profile id or provider)
  const storedRaw = readJsonPref(prefs, AI_PROVIDER_PROFILES_PREF);
  if (storedRaw && Array.isArray(storedRaw.profiles)) {
    const matched = storedRaw.profiles.find(
      (p) => p && (String(p.id || "").trim().toLowerCase() === provider || String(p.provider || "").trim().toLowerCase() === provider),
    );
    if (matched) {
      const clean = stripSecretsFromProfile(matched);
      if (clean) return hydrateStoredProfile(prefs, clean);
    }
  }

  const consentToSendData = readBool(prefs, CONFIG.AI_PROVIDER_CONSENT_PREF, false);

  if (provider === "ollama") {
    return {
      provider,
      adapter: "ollama-native",
      consentToSendData,
      endpoint: readString(prefs, CONFIG.AI_OLLAMA_HOST_PREF, CONFIG.AI_OLLAMA_HOST_DEFAULT) || CONFIG.AI_OLLAMA_HOST_DEFAULT,
      model: readString(prefs, CONFIG.AI_OLLAMA_MODEL_PREF, CONFIG.AI_OLLAMA_MODEL_DEFAULT) || CONFIG.AI_OLLAMA_MODEL_DEFAULT,
      apiKey: getCachedSecret("ollama"),
    };
  }
  if (provider === "openai") {
    return {
      provider,
      adapter: "openai-chat",
      consentToSendData,
      endpoint: readString(prefs, CONFIG.AI_OPENAI_ENDPOINT_PREF, ""),
      apiKey: resolveSecretOrPref(prefs, "openai", CONFIG.AI_OPENAI_API_KEY_PREF),
      model: readString(prefs, CONFIG.AI_OPENAI_MODEL_PREF, ""),
    };
  }
  if (provider === "primalabs") {
    return {
      provider,
      adapter: "openai-chat",
      consentToSendData,
      endpoint: readString(prefs, CONFIG.AI_PRIMALABS_ENDPOINT_PREF, CONFIG.AI_PRIMALABS_ENDPOINT_DEFAULT) || CONFIG.AI_PRIMALABS_ENDPOINT_DEFAULT,
      apiKey: resolveSecretOrPref(prefs, "primalabs", CONFIG.AI_PRIMALABS_API_KEY_PREF),
      model: readString(prefs, CONFIG.AI_PRIMALABS_MODEL_PREF, CONFIG.AI_PRIMALABS_MODEL_DEFAULT) || CONFIG.AI_PRIMALABS_MODEL_DEFAULT,
    };
  }
  if (provider === "chatgpt") {
    const session = readChatGPTSession(prefs);
    return {
      provider,
      adapter: "openai-responses",
      consentToSendData,
      model: readString(prefs, CONFIG.AI_CHATGPT_MODEL_PREF, CONFIG.AI_CHATGPT_MODEL_DEFAULT) || CONFIG.AI_CHATGPT_MODEL_DEFAULT,
      accessToken: session?.accessToken || "",
      refreshToken: session?.refreshToken || "",
      clientId: session?.clientId || "",
      expiresAt: session?.expiresAt || 0,
    };
  }
  if (provider === "gemini") {
    return {
      provider,
      adapter: "google-gemini",
      consentToSendData,
      apiKey: resolveSecretOrPref(prefs, "gemini", CONFIG.AI_GEMINI_API_KEY_PREF),
      model: normalizeGeminiModel(readString(prefs, CONFIG.AI_GEMINI_MODEL_PREF, "")),
    };
  }
  if (provider === "custom") {
    const format = readString(prefs, CONFIG.AI_CUSTOM_FORMAT_PREF, "openai");
    const normalizedFormat = format === "ollama" ? "ollama" : "openai";
    return {
      provider,
      adapter: resolveAdapterKind({ provider: "custom", format: format || "openai" }),
      consentToSendData,
      endpoint: readString(prefs, CONFIG.AI_CUSTOM_ENDPOINT_PREF, ""),
      apiKey: resolveSecretOrPref(prefs, "custom", CONFIG.AI_CUSTOM_API_KEY_PREF),
      model: readString(prefs, CONFIG.AI_CUSTOM_MODEL_PREF, ""),
      format: normalizedFormat,
    };
  }

  // Registry-driven support for all 18 built-in presets (anthropic, openrouter,
  // groq, mistral, deepseek, xai, perplexity, github-models, azure-openai,
  // lmstudio, llamacpp, vllm, etc.)
  const preset = getProviderPreset(provider);
  if (preset) {
    return {
      provider: preset.id,
      adapter: preset.adapter,
      consentToSendData,
      endpoint: preset.defaultBaseUrl,
      apiKey: getCachedSecret(preset.id),
      model: preset.defaultModel,
      ...(preset.apiVersion ? { apiVersion: preset.apiVersion } : {}),
    };
  }

  return { provider: "off", consentToSendData: false };
};

export const readFallbackProviderSettings = (prefs) => {
  const fallbackName = readString(prefs, CONFIG.AI_FALLBACK_PROVIDER_PREF, "chatgpt") || "chatgpt";
  return readProviderSettingsForName(prefs, fallbackName);
};

export const readProviderSettings = (prefs) => {
  const provider = readString(prefs, CONFIG.AI_ENGINE_PREF, "off") || "off";
  if (provider === "jev") {
    // When JEV is active, remote-provider calls use the configured Fallback-LLM.
    return readFallbackProviderSettings(prefs);
  }
  return readProviderSettingsForName(prefs, provider);
};

// ─── Fallback Chain Config ───────────────────────────────────────────────────

export const readFallbackChainIds = (prefs = globalThis.Services?.prefs) => {
  const raw = readJsonPref(prefs, AI_FALLBACK_CHAIN_PREF);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const ids = [];
  for (const item of raw) {
    const id = String(typeof item === "string" ? item : item?.id || item?.provider || "").trim();
    const key = id.toLowerCase();
    if (!id || key === "off" || key === "none" || seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
};

export const setFallbackChain = (prefs = globalThis.Services?.prefs, chainIds = []) => {
  const clean = [];
  const seen = new Set();
  for (const item of Array.isArray(chainIds) ? chainIds : []) {
    const id = String(typeof item === "string" ? item : item?.id || item?.provider || "").trim();
    const key = id.toLowerCase();
    if (!id || key === "off" || key === "none" || seen.has(key)) continue;
    seen.add(key);
    clean.push(id);
  }
  writeJsonPref(prefs, AI_FALLBACK_CHAIN_PREF, clean);
  return clean;
};

/**
 * Resolve the ordered fallback chain of provider profiles.
 * If an explicit `ai-fallback-chain-json` is configured, returns those profiles
 * in order; otherwise returns the primary fallback provider (if enabled).
 */
export const getFallbackChain = (prefs = globalThis.Services?.prefs) => {
  const configuredIds = readFallbackChainIds(prefs);
  const chain = [];
  const seenKeys = new Set();

  const pushProfile = (settings) => {
    if (!settings || settings.provider === "off" || settings.provider === "none") return;
    const dedupeKey = `${settings.id || settings.provider}\0${resolveProfileEndpoint(settings)}\0${settings.model || ""}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    chain.push(settings);
  };

  if (configuredIds.length > 0) {
    for (const id of configuredIds) {
      pushProfile(readProviderSettingsForName(prefs, id));
    }
    return chain;
  }

  pushProfile(readFallbackProviderSettings(prefs));
  return chain;
};

// ─── Per-Task Model Profiles ("fast" | "deep" | "offline") ───────────────────

export const setTaskProfile = (task, profileRef, prefs = globalThis.Services?.prefs) => {
  const normalizedTask = String(task || "").trim().toLowerCase();
  if (!TASK_PROFILE_KINDS.includes(normalizedTask)) return null;
  const current = readJsonPref(prefs, AI_TASK_PROFILES_PREF) || {};
  const next = { ...current };
  if (!profileRef) {
    delete next[normalizedTask];
  } else if (typeof profileRef === "string") {
    next[normalizedTask] = { profileId: profileRef.trim() };
  } else if (typeof profileRef === "object") {
    next[normalizedTask] = {
      ...(profileRef.profileId ? { profileId: String(profileRef.profileId).trim() } : {}),
      ...(profileRef.provider ? { provider: String(profileRef.provider).trim().toLowerCase() } : {}),
      ...(profileRef.model ? { model: String(profileRef.model).trim() } : {}),
      ...(profileRef.reasoningPreference ? { reasoningPreference: String(profileRef.reasoningPreference).trim().toLowerCase() } : {}),
    };
  }
  writeJsonPref(prefs, AI_TASK_PROFILES_PREF, next);
  return next[normalizedTask] || null;
};

/**
 * Resolve the effective provider profile for a named task:
 *   - `"fast"`:    quick categorization / instant sorts (defaults to fast reasoning)
 *   - `"deep"`:    thorough clustering / complex workspace merges (defaults to medium reasoning)
 *   - `"offline"`: local-only loopback provider (prefers configured local preset, else Ollama)
 */
export const getTaskProfile = (task = "fast", prefs = globalThis.Services?.prefs) => {
  const normalizedTask = TASK_PROFILE_KINDS.includes(String(task || "").trim().toLowerCase())
    ? String(task).trim().toLowerCase()
    : "fast";

  const map = readJsonPref(prefs, AI_TASK_PROFILES_PREF);
  const override = map && typeof map === "object" ? map[normalizedTask] : null;

  if (override && typeof override === "object") {
    const baseName = override.profileId || override.provider;
    if (baseName) {
      const base = readProviderSettingsForName(prefs, baseName);
      if (base.provider !== "off") {
        return {
          ...base,
          ...(override.model ? { model: base.provider === "gemini" ? normalizeGeminiModel(override.model) : override.model } : {}),
          task: normalizedTask,
          reasoningPreference: override.reasoningPreference || (normalizedTask === "deep" ? "medium" : "fast"),
        };
      }
    }
  }

  if (normalizedTask === "offline") {
    const profiles = listProviderProfiles(prefs);
    const localStored = profiles.find((p) => {
      const preset = getProviderPreset(p.provider);
      return preset?.category === "local";
    });
    if (localStored) {
      return {
        ...hydrateStoredProfile(prefs, localStored),
        task: "offline",
        reasoningPreference: "fast",
      };
    }
    return {
      ...readProviderSettingsForName(prefs, "ollama"),
      task: "offline",
      reasoningPreference: "fast",
    };
  }

  const primary = readFallbackProviderSettings(prefs);
  return {
    ...primary,
    task: normalizedTask,
    reasoningPreference: normalizedTask === "deep" ? "medium" : "fast",
  };
};
