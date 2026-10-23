// Zen Tab Sorting — Debug Journal & Error Diagnostics
// Records execution steps, JEV scoring, and Fallback-LLM responses when debug mode is enabled.

import { CONFIG, LOG } from "./config.mjs";
import { createSafeLogEvent } from "./safe-log.mjs";

const MAX_DEBUG_EVENTS = 250;
const debugBuffer = [];

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
  debugBuffer.push(entry);
  if (debugBuffer.length > MAX_DEBUG_EVENTS) {
    debugBuffer.shift();
  }
  const serialized = safeData ? ` | details: ${JSON.stringify(safeData)}` : "";
  console.log(`${LOG}[DEBUG][${stage}] ${summary}${serialized}`);
};

export const getDebugEvents = () => [...debugBuffer];

export const clearDebugEvents = () => {
  debugBuffer.length = 0;
};

export const formatDebugEventsAsText = () => {
  if (debugBuffer.length === 0) {
    return isDebugMode()
      ? "Debug-Modus ist AKTIV, aber es wurden bisher noch keine Sortier-Aktionen ausgeführt.\nKlicke auf den Zauberstab-Button in der Sidebar, um einen Sortierlauf aufzuzeichnen."
      : "Debug-Modus ist DEAKTIVIERT.\nAktiviere die Checkbox 'Enable debug logging' oben, um Logs aufzuzeichnen.";
  }
  return debugBuffer
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
