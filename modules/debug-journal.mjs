// Zen Tab Sorting — Debug Journal & Error Diagnostics
// Records execution steps, JEV scoring, and Fallback-LLM responses when debug mode is enabled.
// Persists logs into Services.prefs (DEBUG_LOGS_PREF) so logs are shared across
// browser.xhtml and about:preferences.

import { CONFIG, LOG } from "./config.mjs";
import { createSafeLogEvent } from "./safe-log.mjs";

const MAX_DEBUG_EVENTS = 60;
const MAX_EVENT_PAYLOAD_BYTES = 4096;
const MAX_TOTAL_JSON_BYTES = 65536;
const MAX_TABS_PREVIEW = 20;
const FLUSH_DEBOUNCE_MS = 300;

let inMemoryFallback = [];
let cachedRaw = null;
let cachedEvents = [];
let flushTimer = null;
let pendingDirty = false;
let warnedCorruptPref = false;
let unloadHookInstalled = false;

const compactTabsInPayload = (data) => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (!Array.isArray(data.tabs) || data.tabs.length <= MAX_TABS_PREVIEW) return data;
  return {
    ...data,
    tabs: {
      total: data.tabs.length,
      truncated: true,
      items: data.tabs.slice(0, MAX_TABS_PREVIEW),
    },
  };
};

const capEventPayload = (safeData) => {
  if (safeData == null) return null;
  const compacted = compactTabsInPayload(safeData);
  let serialized;
  try {
    serialized = JSON.stringify(compacted);
  } catch {
    return { truncated: true, reason: "unserializable" };
  }
  if (serialized.length <= MAX_EVENT_PAYLOAD_BYTES) return compacted;
  return {
    truncated: true,
    originalBytes: serialized.length,
    preview: `${serialized.slice(0, 1024)}...`,
  };
};

const enforceJournalCaps = (events) => {
  while (events.length > MAX_DEBUG_EVENTS) {
    events.shift();
  }
  let raw = JSON.stringify(events);
  while (raw.length > MAX_TOTAL_JSON_BYTES && events.length > 1) {
    events.shift();
    raw = JSON.stringify(events);
  }
  if (raw.length > MAX_TOTAL_JSON_BYTES && events.length === 1) {
    const only = events[0];
    events[0] = {
      time: only.time,
      stage: only.stage,
      summary: String(only.summary || "").slice(0, 512),
      data: { truncated: true, originalBytes: raw.length },
    };
    raw = JSON.stringify(events);
  }
  return raw;
};

const persistNow = (events) => {
  const snapshot = [...events];
  inMemoryFallback = snapshot;
  const raw = enforceJournalCaps(snapshot);
  inMemoryFallback = snapshot;
  pendingDirty = false;
  try {
    const prefs = globalThis.Services?.prefs;
    if (prefs?.setStringPref) {
      cachedRaw = raw;
      cachedEvents = snapshot;
      prefs.setStringPref(CONFIG.DEBUG_LOGS_PREF, raw);
    }
  } catch (e) {
    console.warn(`${LOG} could not save debug logs to pref:`, e);
  }
};

export const flushDebugJournal = () => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pendingDirty) return;
  persistNow(inMemoryFallback);
};

const ensureBeforeUnloadFlush = () => {
  if (unloadHookInstalled) return;
  if (typeof globalThis.window?.addEventListener === "function") {
    unloadHookInstalled = true;
    try {
      globalThis.window.addEventListener("beforeunload", flushDebugJournal, { once: true });
    } catch {}
  }
};

const schedulePersist = (events, { immediate = false } = {}) => {
  const snapshot = [...events];
  enforceJournalCaps(snapshot);
  inMemoryFallback = snapshot;
  pendingDirty = true;

  if (immediate) {
    flushDebugJournal();
    return;
  }

  ensureBeforeUnloadFlush();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (pendingDirty) persistNow(inMemoryFallback);
  }, FLUSH_DEBOUNCE_MS);
  // Do not keep Node test runners alive waiting for a debounced pref flush.
  flushTimer?.unref?.();
};

const resetCorruptPref = (prefs) => {
  if (!warnedCorruptPref) {
    warnedCorruptPref = true;
    console.warn(`${LOG} corrupt debug logs JSON in pref — resetting journal`);
  }
  inMemoryFallback = [];
  cachedRaw = "[]";
  cachedEvents = [];
  pendingDirty = false;
  try {
    prefs?.setStringPref?.(CONFIG.DEBUG_LOGS_PREF, "[]");
  } catch {}
};

const readPersistedEvents = () => {
  if (pendingDirty) return [...inMemoryFallback];
  const prefs = globalThis.Services?.prefs;
  try {
    if (prefs?.prefHasUserValue?.(CONFIG.DEBUG_LOGS_PREF)) {
      const raw = prefs.getStringPref(CONFIG.DEBUG_LOGS_PREF);
      if (raw) {
        if (raw === cachedRaw) return [...cachedEvents];
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          cachedRaw = raw;
          cachedEvents = parsed;
          return [...parsed];
        }
        resetCorruptPref(prefs);
        return [];
      }
    }
  } catch {
    resetCorruptPref(prefs);
    return [];
  }
  return [...inMemoryFallback];
};

export const isDebugMode = () => {
  try {
    return globalThis.Services?.prefs?.getBoolPref?.(CONFIG.DEBUG_MODE_PREF, false) ?? false;
  } catch {
    return false;
  }
};

export const recordDebugEvent = (stage, summary, data = null) => {
  if (!isDebugMode()) return;
  const time = new Date().toISOString().slice(11, 23);
  const safeData = data != null ? capEventPayload(createSafeLogEvent(data)) : null;
  const entry = { time, stage, summary, data: safeData };

  const current = readPersistedEvents();
  current.push(entry);

  const isErrorStage = String(stage || "").toUpperCase().includes("ERROR");
  schedulePersist(current, { immediate: isErrorStage });

  const serialized = safeData ? ` | details: ${JSON.stringify(safeData)}` : "";
  console.log(`${LOG}[DEBUG][${stage}] ${summary}${serialized}`);
};

export const getDebugEvents = () => readPersistedEvents();

export const clearDebugEvents = () => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  persistNow([]);
};

export const formatDebugEventsAsText = () => {
  const events = readPersistedEvents();
  if (events.length === 0) {
    return isDebugMode()
      ? "Debug-Modus ist AKTIV, aber es wurden bisher noch keine Aktionen aufgezeichnet.\nKlicke auf den Zauberstab-Button in der Sidebar, um einen Sortierlauf aufzuzeichnen."
      : "Debug-Modus ist DEAKTIVIERT.\nKlicke oben auf 'Debug-Modus aktivieren', um Logs aufzuzeichnen.";
  }
  return events
    .map((e) => {
      const dataStr = e.data ? `\n  ↳ ${JSON.stringify(e.data, null, 2).replace(/\n/g, "\n  ")}` : "";
      return `[${e.time}] [${e.stage}] ${e.summary}${dataStr}`;
    })
    .join("\n\n");
};

/**
 * Checks whether an HTTP status or error text corresponds to a rate limit or quota exhaustion.
 */
export const detectQuotaOrRateLimit = (status, bodyText, errorMsg) => {
  const code = Number(status);
  const combined = `${status || ""} ${bodyText || ""} ${errorMsg || ""}`.toLowerCase();
  const is429 = code === 429;
  const isSubscriptionSharing =
    combined.includes("subscription sharing") ||
    combined.includes("subscription sharing usage limit") ||
    combined.includes("reached their subscription sharing");
  const isQuotaKeyword =
    isSubscriptionSharing ||
    combined.includes("insufficient_quota") ||
    combined.includes("quota_exceeded") ||
    combined.includes("exceeded your current quota") ||
    combined.includes("usage_limit") ||
    combined.includes("usage limit") ||
    combined.includes("rate_limit") ||
    combined.includes("rate limit") ||
    combined.includes("too many requests") ||
    combined.includes("tokens per min");

  if (is429 || isQuotaKeyword) {
    const userMessage = isSubscriptionSharing
      ? "ChatGPT Subscription-Sharing-Limit erreicht! Dein Kontingent ist erschöpft. Bitte später erneut versuchen oder das Fallback-LLM auf 'Off', PrimaLabs oder OpenAI API Key umstellen."
      : "ChatGPT / Provider Usage-Limit erreicht! Dein Kontingent ist erschöpft (HTTP 429 / Quota). Bitte später erneut versuchen oder das Fallback-LLM auf 'Off', PrimaLabs oder einen API-Key stellen.";
    return {
      isQuota: true,
      userMessage,
    };
  }
  return {
    isQuota: false,
    userMessage: "",
  };
};
