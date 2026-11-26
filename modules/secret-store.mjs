// Zen Tab Sorting — secure credential storage backed by Firefox nsILoginManager
// (`Services.logins`) with in-memory hydration cache, one-time plaintext pref
// migration, and graceful fallback when login storage is unavailable or locked.
//
// Design constraints:
// - Provider settings reads (`readProviderSettings`) are synchronous, while
//   `Services.logins` is async in modern Firefox/Zen. `hydrateSecrets()` warms
//   an in-memory cache at startup/settings-open so `getCachedSecret(name)` is
//   instant and synchronous, while write/delete flows use async `setSecret` /
//   `deleteSecret`.
// - Node unit tests run without `Services.logins`; callers can inject a backend
//   via `setSecretStoreBackend()` or let the module fall back cleanly.

import { CONFIG, LOG } from "./config.mjs";

export const SECRET_STORE_ORIGIN = "chrome://zen-tab-sorting";
export const SECRET_STORE_USERNAME = "zen-tab-sorting";

// Mapping of canonical secret keys to legacy plaintext pref names for one-time
// automatic migration into `Services.logins`.
export const LEGACY_SECRET_PREF_MAP = Object.freeze({
  jev: CONFIG.AI_JEV_API_KEY_PREF,
  openai: CONFIG.AI_OPENAI_API_KEY_PREF,
  primalabs: CONFIG.AI_PRIMALABS_API_KEY_PREF,
  gemini: CONFIG.AI_GEMINI_API_KEY_PREF,
  custom: CONFIG.AI_CUSTOM_API_KEY_PREF,
});

const localCache = new Map();
let customBackend = null;
let warnedUnavailable = false;
let migratedLegacyPrefs = false;

const getSharedCache = () => {
  try {
    const host = globalThis.Services?.appShell?.hiddenDOMWindow;
    if (host) {
      host._zaoSecretCache ||= new Map();
      return host._zaoSecretCache;
    }
  } catch {}
  return localCache;
};

const normalizeName = (name) => String(name || "").trim();

const realmFor = (name) => `zen-tab-sorting:${normalizeName(name)}`;

const createLoginInfo = (realm, value) => {
  const Cc = globalThis.Cc || globalThis.Components?.classes;
  const Ci = globalThis.Ci || globalThis.Components?.interfaces;
  if (!Cc || !Ci) return null;
  const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  info.init(SECRET_STORE_ORIGIN, null, realm, SECRET_STORE_USERNAME, value, "", "");
  return info;
};

const getNativeLogins = () => {
  try {
    const logins = globalThis.Services?.logins;
    if (!logins) return null;
    if (logins.isLoggedIn === false) return null;
    return logins;
  } catch {
    return null;
  }
};

const warnFallbackOnce = (reason) => {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(`${LOG} secret-store: login manager unavailable (${reason}); falling back to preference storage`);
};

const searchNativeLogins = async (logins, realm = null) => {
  const query = realm
    ? { origin: SECRET_STORE_ORIGIN, httpRealm: realm }
    : { origin: SECRET_STORE_ORIGIN };
  if (typeof logins.searchLoginsAsync === "function") {
    return await logins.searchLoginsAsync(query);
  }
  if (typeof logins.findLogins === "function") {
    return logins.findLogins(SECRET_STORE_ORIGIN, null, realm);
  }
  return [];
};

const readFallbackPref = (prefs, fallbackPref) => {
  if (!prefs || !fallbackPref) return "";
  try {
    if (prefs.prefHasUserValue?.(fallbackPref) && prefs.getPrefType?.(fallbackPref) === prefs.PREF_STRING) {
      return String(prefs.getStringPref(fallbackPref) || "").trim();
    }
  } catch {}
  return "";
};

const writeFallbackPref = (prefs, fallbackPref, value) => {
  if (!prefs || !fallbackPref) return false;
  try {
    if (!value) {
      prefs.clearUserPref?.(fallbackPref);
    } else {
      prefs.setStringPref?.(fallbackPref, value);
    }
    return true;
  } catch {
    return false;
  }
};

/**
 * Returns true if either an injected test backend or Firefox `Services.logins`
 * is currently available and unlocked.
 */
export const isSecretStoreAvailable = () => {
  if (customBackend) return true;
  return getNativeLogins() !== null;
};

/**
 * Inject a custom async backend (`{ get(name), set(name, value), delete(name), list?() }`)
 * for unit tests. Pass `null` to restore native `Services.logins` resolution.
 */
export const setSecretStoreBackend = (backend) => {
  customBackend = backend || null;
};

/**
 * Reset in-memory cache and test state. Intended for unit tests.
 */
export const resetSecretStoreForTests = () => {
  customBackend = null;
  warnedUnavailable = false;
  migratedLegacyPrefs = false;
  localCache.clear();
  try {
    const host = globalThis.Services?.appShell?.hiddenDOMWindow;
    host?._zaoSecretCache?.clear?.();
  } catch {}
};

/**
 * Synchronous read from the hydrated in-memory cache.
 * Returns `""` when not present.
 */
export const getCachedSecret = (name) => {
  const key = normalizeName(name);
  if (!key) return "";
  return getSharedCache().get(key) || "";
};

/**
 * Returns whether the secret key is currently populated in the in-memory cache.
 */
export const hasCachedSecret = (name) => {
  const key = normalizeName(name);
  if (!key) return false;
  return Boolean(getSharedCache().get(key));
};

/**
 * Read a secret asynchronously from `Services.logins` (or injected backend),
 * populating the synchronous cache. Falls back to `fallbackPref` if login
 * storage is unavailable or locked.
 */
export const getSecret = async (name, { prefs = globalThis.Services?.prefs, fallbackPref } = {}) => {
  const key = normalizeName(name);
  if (!key) return "";
  const cache = getSharedCache();

  if (customBackend) {
    try {
      const value = String((await customBackend.get(key)) || "").trim();
      if (value) cache.set(key, value);
      else cache.delete(key);
      return value;
    } catch (e) {
      warnFallbackOnce(e?.message || "backend error");
    }
  } else {
    const logins = getNativeLogins();
    if (logins) {
      try {
        const matches = await searchNativeLogins(logins, realmFor(key));
        const value = String(matches?.[0]?.password || "").trim();
        if (value) cache.set(key, value);
        else cache.delete(key);
        if (value) return value;
      } catch (e) {
        warnFallbackOnce(e?.message || "read failed");
      }
    }
  }

  const prefName = fallbackPref || LEGACY_SECRET_PREF_MAP[key] || "";
  const fromPref = readFallbackPref(prefs, prefName);
  if (fromPref) {
    cache.set(key, fromPref);
    return fromPref;
  }
  return cache.get(key) || "";
};

/**
 * Store a secret in `Services.logins` (or injected backend) and update the
 * synchronous cache. Passing an empty string deletes the stored secret.
 * Falls back to writing `fallbackPref` with a warning if login storage is
 * unavailable or locked.
 *
 * @returns {Promise<{ ok: boolean, storage: "logins"|"backend"|"prefs"|"memory" }>}
 */
export const setSecret = async (name, value, { prefs = globalThis.Services?.prefs, fallbackPref } = {}) => {
  const key = normalizeName(name);
  if (!key) return { ok: false, storage: "memory" };
  const cleaned = String(value ?? "").trim();
  if (!cleaned) {
    await deleteSecret(key, { prefs, fallbackPref });
    return { ok: true, storage: isSecretStoreAvailable() ? (customBackend ? "backend" : "logins") : "prefs" };
  }

  const cache = getSharedCache();
  cache.set(key, cleaned);

  if (customBackend) {
    try {
      await customBackend.set(key, cleaned);
      return { ok: true, storage: "backend" };
    } catch (e) {
      warnFallbackOnce(e?.message || "backend write failed");
    }
  } else {
    const logins = getNativeLogins();
    if (logins) {
      try {
        const realm = realmFor(key);
        const existing = await searchNativeLogins(logins, realm);
        const nextLogin = createLoginInfo(realm, cleaned);
        if (nextLogin) {
          if (existing?.length > 0) {
            if (typeof logins.modifyLoginAsync === "function") {
              await logins.modifyLoginAsync(existing[0], nextLogin);
            } else {
              logins.modifyLogin(existing[0], nextLogin);
            }
          } else if (typeof logins.addLoginAsync === "function") {
            await logins.addLoginAsync(nextLogin);
          } else {
            logins.addLogin(nextLogin);
          }
          // Verify persistence before reporting login-manager storage.
          const verified = await searchNativeLogins(logins, realm);
          if (String(verified?.[0]?.password || "").trim() === cleaned) {
            return { ok: true, storage: "logins" };
          }
        }
      } catch (e) {
        warnFallbackOnce(e?.message || "write failed");
      }
    } else if (globalThis.Services?.logins?.isLoggedIn === false) {
      warnFallbackOnce("primary password locked");
    }
  }

  const prefName = fallbackPref || LEGACY_SECRET_PREF_MAP[key] || "";
  if (prefName && writeFallbackPref(prefs, prefName, cleaned)) {
    return { ok: true, storage: "prefs" };
  }
  return { ok: true, storage: "memory" };
};

/**
 * Remove a secret from `Services.logins` (or injected backend), the cache, and
 * any legacy plaintext preference.
 */
export const deleteSecret = async (name, { prefs = globalThis.Services?.prefs, fallbackPref } = {}) => {
  const key = normalizeName(name);
  if (!key) return false;
  getSharedCache().delete(key);

  if (customBackend) {
    try {
      await customBackend.delete(key);
    } catch (e) {
      warnFallbackOnce(e?.message || "backend delete failed");
    }
  } else {
    const logins = getNativeLogins();
    if (logins) {
      try {
        const existing = await searchNativeLogins(logins, realmFor(key));
        for (const item of existing || []) {
          if (typeof logins.removeLoginAsync === "function") {
            await logins.removeLoginAsync(item);
          } else {
            logins.removeLogin(item);
          }
        }
      } catch (e) {
        warnFallbackOnce(e?.message || "delete failed");
      }
    }
  }

  const prefName = fallbackPref || LEGACY_SECRET_PREF_MAP[key] || "";
  if (prefName) {
    writeFallbackPref(prefs, prefName, "");
  }
  return true;
};

/**
 * One-time automatic migration of plaintext secrets from `Services.prefs` into
 * `Services.logins`. Clears each plaintext pref ONLY after verifying the value
 * was durably saved in `Services.logins` (or injected backend).
 */
export const migratePrefSecrets = async ({
  prefs = globalThis.Services?.prefs,
  prefMap = LEGACY_SECRET_PREF_MAP,
  force = false,
} = {}) => {
  const migrated = [];
  const skipped = [];
  if (!prefs) return { migrated, skipped };
  if (migratedLegacyPrefs && !force) return { migrated, skipped };
  if (!isSecretStoreAvailable()) {
    return { migrated, skipped: Object.keys(prefMap) };
  }

  for (const [name, prefName] of Object.entries(prefMap)) {
    const plaintext = readFallbackPref(prefs, prefName);
    if (!plaintext) continue;
    const saved = await setSecret(name, plaintext, { prefs, fallbackPref: prefName });
    if (saved.ok && (saved.storage === "logins" || saved.storage === "backend")) {
      const verified = await getSecret(name, { prefs });
      if (verified === plaintext) {
        try {
          prefs.clearUserPref?.(prefName);
        } catch {}
        migrated.push(name);
        continue;
      }
    }
    skipped.push(name);
  }

  if (skipped.length === 0) migratedLegacyPrefs = true;
  return { migrated, skipped };
};

/**
 * Hydrate all stored secrets into the synchronous in-memory cache and run the
 * one-time plaintext preference migration when `Services.logins` is unlocked.
 */
export const hydrateSecrets = async ({
  prefs = globalThis.Services?.prefs,
  names = null,
  migrate = true,
} = {}) => {
  const cache = getSharedCache();

  if (customBackend) {
    try {
      const targetNames = Array.isArray(names)
        ? names
        : typeof customBackend.list === "function"
          ? await customBackend.list()
          : Object.keys(LEGACY_SECRET_PREF_MAP);
      for (const name of targetNames) {
        const key = normalizeName(name);
        if (!key) continue;
        const val = String((await customBackend.get(key)) || "").trim();
        if (val) cache.set(key, val);
      }
    } catch (e) {
      warnFallbackOnce(e?.message || "hydrate failed");
    }
  } else {
    const logins = getNativeLogins();
    if (logins) {
      try {
        const all = await searchNativeLogins(logins, null);
        const prefix = "zen-tab-sorting:";
        for (const item of all || []) {
          const realm = String(item?.httpRealm || "");
          if (!realm.startsWith(prefix)) continue;
          const key = realm.slice(prefix.length).trim();
          const val = String(item?.password || "").trim();
          if (key && val) cache.set(key, val);
        }
      } catch (e) {
        warnFallbackOnce(e?.message || "hydrate failed");
      }
    }
  }

  if (migrate && prefs) {
    await migratePrefSecrets({ prefs });
  }

  // Ensure any remaining unmigrated pref values are visible in cache if storage
  // is locked/unavailable.
  if (prefs) {
    for (const [name, prefName] of Object.entries(LEGACY_SECRET_PREF_MAP)) {
      if (cache.has(name)) continue;
      const val = readFallbackPref(prefs, prefName);
      if (val) cache.set(name, val);
    }
  }

  return new Map(cache);
};
