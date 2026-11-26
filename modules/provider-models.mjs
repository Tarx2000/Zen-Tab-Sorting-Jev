// Zen Tab Sorting — Unified Model Discovery, Caching, Recents, and Favorites.
//
// - `listProviderModels(profile, { forceRefresh, signal, fetchImpl })` works
//   uniformly across all 5 protocol adapters (18 presets).
// - Positive results cached for 24 hours; transient errors cached for 30s
//   (negative TTL) so broken endpoints aren't hammered on every settings open.
// - Cache keys ALWAYS include `${provider}\0${endpoint}\0${model}` (and
//   `\0${preference}` for resolved reasoning effort) to prevent cross-provider
//   collisions and sticky effort downgrades.

import { getAdapterForProfile } from "./provider-adapters.mjs";
import { classifyProviderError, ERROR_CATEGORIES } from "./provider-errors.mjs";
import { resolveProfileEndpoint } from "./provider-registry.mjs";

export const MODEL_LIST_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const MODEL_LIST_NEGATIVE_TTL_MS = 30 * 1000;          // 30s
export const MAX_RECENT_MODELS = 12;

export const RECENT_MODELS_PREF = "extensions.zen-auto-organize.ai-recent-models-json";
export const FAVORITE_MODELS_PREF = "extensions.zen-auto-organize.ai-favorite-models-json";

const catalogCache = new Map();
const capabilityCache = new Map();
const resolvedEffortCache = new Map();
let memoryRecents = [];
let memoryFavorites = [];

// ─── Collision-free Cache Keys ───────────────────────────────────────────────

export const buildCatalogCacheKey = (profile) => {
  const provider = String(profile?.provider || "").trim().toLowerCase();
  const endpoint = resolveProfileEndpoint(profile).trim().replace(/\/+$/, "");
  return `${provider}\0${endpoint}`;
};

export const buildModelCacheKey = (profile) => {
  const provider = String(profile?.provider || "").trim().toLowerCase();
  const endpoint = resolveProfileEndpoint(profile).trim().replace(/\/+$/, "");
  const model = String(profile?.model || "").trim();
  return `${provider}\0${endpoint}\0${model}`;
};

export const buildEffortCacheKey = (profile, preference) => {
  const pref = String(preference || "fast").trim().toLowerCase();
  return `${buildModelCacheKey(profile)}\0${pref}`;
};

// ─── Unified Model Discovery ─────────────────────────────────────────────────

/**
 * Fetch and cache the model catalog for any registered provider profile.
 *
 * @returns {Promise<{ ok: boolean, models: Array<{id: string, label: string, contextLength?: number|null, capabilities?: object|null}>, fromCache: boolean, error?: string, category?: string }>}
 */
export const listProviderModels = async (
  profile,
  { forceRefresh = false, signal = null, fetchImpl = null, timeoutMs = 15000 } = {},
) => {
  if (!profile || typeof profile !== "object") {
    return { ok: false, models: [], fromCache: false, error: "Invalid provider profile" };
  }
  const key = buildCatalogCacheKey(profile);
  const now = Date.now();

  if (!forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      return {
        ok: cached.ok,
        models: [...cached.models],
        fromCache: true,
        ...(cached.error ? { error: cached.error, category: cached.category } : {}),
      };
    }
  }

  const adapter = getAdapterForProfile(profile);
  try {
    const models = await adapter.listModels(profile, { signal, fetchImpl, timeoutMs });
    const normalized = Array.isArray(models) ? models : [];
    catalogCache.set(key, {
      ok: true,
      models: normalized,
      expiresAt: Date.now() + MODEL_LIST_POSITIVE_TTL_MS,
    });
    // Also seed per-model capability cache entries from catalog metadata
    for (const m of normalized) {
      if (m?.id && m?.capabilities) {
        const modelKey = buildModelCacheKey({ ...profile, model: m.id });
        capabilityCache.set(modelKey, {
          capabilities: m.capabilities,
          expiresAt: Date.now() + MODEL_LIST_POSITIVE_TTL_MS,
        });
      }
    }
    return { ok: true, models: [...normalized], fromCache: false };
  } catch (err) {
    const category = classifyProviderError(err?.status, err?.body, err);
    const errorMessage = err?.message || String(err);
    // Apply 30s negative TTL on transient/network/timeout/rate-limit errors;
    // do not cache user-initiated aborts.
    if (category !== ERROR_CATEGORIES.ABORT) {
      catalogCache.set(key, {
        ok: false,
        models: [],
        error: errorMessage,
        category,
        expiresAt: Date.now() + MODEL_LIST_NEGATIVE_TTL_MS,
      });
    }
    return {
      ok: false,
      models: [],
      fromCache: false,
      error: errorMessage,
      category,
    };
  }
};

export const getCachedModelCapabilities = (profile) => {
  const entry = capabilityCache.get(buildModelCacheKey(profile));
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.capabilities;
};

export const setCachedModelCapabilities = (profile, capabilities, ttlMs = MODEL_LIST_POSITIVE_TTL_MS) => {
  capabilityCache.set(buildModelCacheKey(profile), {
    capabilities,
    expiresAt: Date.now() + ttlMs,
  });
};

export const getCachedResolvedEffort = (profile, preference) => {
  const key = buildEffortCacheKey(profile, preference);
  return resolvedEffortCache.has(key) ? resolvedEffortCache.get(key) : undefined;
};

export const setCachedResolvedEffort = (profile, preference, effort) => {
  resolvedEffortCache.set(buildEffortCacheKey(profile, preference), effort);
};

export const clearProviderModelCache = () => {
  catalogCache.clear();
  capabilityCache.clear();
  resolvedEffortCache.clear();
};

// ─── Recent & Favorite Models Persistence ────────────────────────────────────

const normalizeModelEntry = (entry) => {
  if (!entry) return null;
  if (typeof entry === "string") {
    const model = entry.trim();
    return model ? { provider: "", model, label: model } : null;
  }
  const provider = String(entry.provider || "").trim().toLowerCase();
  const model = String(entry.model || entry.id || "").trim();
  if (!model) return null;
  return {
    provider,
    model,
    label: String(entry.label || model).trim(),
    ...(entry.profileId ? { profileId: String(entry.profileId).trim() } : {}),
  };
};

const entryIdentity = (entry) => `${entry.provider}\0${entry.model}`;

const readJsonArrayPref = (prefs, prefName, memoryFallback) => {
  if (prefs) {
    try {
      if (prefs.prefHasUserValue?.(prefName) && prefs.getPrefType?.(prefName) === prefs.PREF_STRING) {
        const parsed = JSON.parse(prefs.getStringPref(prefName));
        if (Array.isArray(parsed)) {
          return parsed.map(normalizeModelEntry).filter(Boolean);
        }
      }
    } catch {}
    return [];
  }
  return [...memoryFallback];
};

const writeJsonArrayPref = (prefs, prefName, list, setMemory) => {
  if (prefs) {
    try {
      prefs.setStringPref?.(prefName, JSON.stringify(list));
      return;
    } catch {}
  }
  setMemory([...list]);
};

export const getRecentModels = (prefs = globalThis.Services?.prefs) =>
  readJsonArrayPref(prefs, RECENT_MODELS_PREF, memoryRecents);

export const recordRecentModel = (entry, prefs = globalThis.Services?.prefs) => {
  const normalized = normalizeModelEntry(entry);
  if (!normalized) return getRecentModels(prefs);
  const id = entryIdentity(normalized);
  const current = getRecentModels(prefs).filter((item) => entryIdentity(item) !== id);
  const next = [{ ...normalized, usedAt: Date.now() }, ...current].slice(0, MAX_RECENT_MODELS);
  writeJsonArrayPref(prefs, RECENT_MODELS_PREF, next, (v) => { memoryRecents = v; });
  return next;
};

export const getFavoriteModels = (prefs = globalThis.Services?.prefs) =>
  readJsonArrayPref(prefs, FAVORITE_MODELS_PREF, memoryFavorites);

export const toggleFavoriteModel = (entry, prefs = globalThis.Services?.prefs) => {
  const normalized = normalizeModelEntry(entry);
  if (!normalized) return { favorited: false, favorites: getFavoriteModels(prefs) };
  const id = entryIdentity(normalized);
  const current = getFavoriteModels(prefs);
  const exists = current.some((item) => entryIdentity(item) === id);
  const next = exists
    ? current.filter((item) => entryIdentity(item) !== id)
    : [...current, normalized];
  writeJsonArrayPref(prefs, FAVORITE_MODELS_PREF, next, (v) => { memoryFavorites = v; });
  return { favorited: !exists, favorites: next };
};

export const resetModelPreferencesForTests = () => {
  memoryRecents = [];
  memoryFavorites = [];
  clearProviderModelCache();
};
