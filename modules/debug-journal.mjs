// Zen Tab Sorting — Debug Journal & Error Diagnostics
// Records execution steps, JEV scoring, and Fallback-LLM responses when debug mode is enabled.
// Persists logs into Services.prefs (DEBUG_LOGS_PREF) so logs are shared across
// browser.xhtml and about:preferences.

import { CONFIG, LOG } from "./config.mjs";
import { createSafeLogEvent } from "./safe-log.mjs";

const MAX_DEBUG_EVENTS = 60;
let inMemoryFallback = [];

const readPersistedEvents = () => {
  try {
    const prefs = globalThis.Services?.prefs;
    if (prefs?.prefHasUserValue?.(CONFIG.DEBUG_LOGS_PREF)) {
      const raw = prefs.getStringPref(CONFIG.DEBUG_LOGS_PREF);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch {}
  return inMemoryFallback;
};

const writePersistedEvents = (events) => {
  inMemoryFallback = events;
  try {
    const prefs = globalThis.Services?.prefs;
    if (prefs?.setStringPref) {
      prefs.setStringPref(CONFIG.DEBUG_LOGS_PREF, JSON.stringify(events));
    }
  } catch (e) {
    console.warn(`${LOG} could not save debug logs to pref:`, e);
  }
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
  const safeData = data ? createSafeLogEvent(data) : null;
  const entry = { time, stage, summary, data: safeData };

  const current = readPersistedEvents();
  current.push(entry);
  while (current.length > MAX_DEBUG_EVENTS) {
    current.shift();
  }
  writePersistedEvents(current);

  const serialized = safeData ? ` | details: ${JSON.stringify(safeData)}` : "";
  console.log(`${LOG}[DEBUG][${stage}] ${summary}${serialized}`);
};

export const getDebugEvents = () => readPersistedEvents();

export const clearDebugEvents = () => {
  writePersistedEvents([]);
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
  const isQuotaKeyword =
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
    return {
      isQuota: true,
      userMessage:
        "ChatGPT / Provider Usage-Limit erreicht! Dein Kontingent ist erschöpft (HTTP 429 / Quota). Bitte später erneut versuchen, dein Kontingent auf openai.com prüfen oder das Fallback auf 'Off' oder PrimaLabs stellen.",
    };
  }
  return {
    isQuota: false,
    userMessage: "",
  };
};
