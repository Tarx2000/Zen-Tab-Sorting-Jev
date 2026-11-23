// Zen Tab Sorting — reasoning-effort policy for the "New groups" LLM.
//
// Why this module exists: a reasoning model spends its first tokens on hidden
// thinking before it emits a single visible character. On the sorting prompt
// that measured 2s (DeepSeek V4.1, 406 reasoning tokens) versus 0.5s with
// reasoning off, and a slow gateway turned it into 17-90s. The provider's
// default is therefore the wrong default for a click that should feel instant.
//
// Providers that publish `/v1/models` (PrimaLabs does) also publish what they
// accept per endpoint, e.g.
//   "reasoning_toggle": {"/v1/chat/completions": true, ...},
//   "reasoning_effort_accepted": {"/v1/chat/completions": ["none","low",...]}
// We read that instead of guessing, so a model that cannot switch reasoning off
// (GLM-5.3) gets its cheapest allowed level rather than an invalid value.
//
// Loaded by remote-provider.mjs and the preferences UI. No I/O here.

import { CONFIG } from "./config.mjs";

export const REASONING_FAST = "fast";
export const REASONING_DEFAULT = "default";

// Cheapest first. The index is the only thing that matters for "nearest level".
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const levelRank = (value) => {
  const idx = REASONING_LEVELS.indexOf(String(value || "").toLowerCase());
  return idx === -1 ? null : idx;
};

export const normalizeReasoningPreference = (value) => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return CONFIG.AI_REASONING_EFFORT_DEFAULT;
  if (raw === REASONING_DEFAULT || raw === "auto") return REASONING_DEFAULT;
  if (raw === REASONING_FAST || raw === "off" || raw === "none" || raw === "minimal") return REASONING_FAST;
  if (["low", "medium", "high"].includes(raw)) return raw;
  return CONFIG.AI_REASONING_EFFORT_DEFAULT;
};

const readString = (prefs, name, fallback) => {
  try {
    return prefs?.prefHasUserValue?.(name) && prefs.getPrefType(name) === prefs.PREF_STRING
      ? prefs.getStringPref(name).trim()
      : fallback;
  } catch {
    return fallback;
  }
};

export const readReasoningPreference = (prefs = globalThis.Services?.prefs) =>
  normalizeReasoningPreference(readString(prefs, CONFIG.AI_REASONING_EFFORT_PREF, CONFIG.AI_REASONING_EFFORT_DEFAULT));

export const clampTimeBudgetSeconds = (value, fallback = CONFIG.AI_TIME_BUDGET_DEFAULT) => {
  const num = Number.parseFloat(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(CONFIG.AI_TIME_BUDGET_MAX, Math.max(CONFIG.AI_TIME_BUDGET_MIN, num));
};

export const readTimeBudgetSeconds = (prefs = globalThis.Services?.prefs) =>
  clampTimeBudgetSeconds(
    readString(prefs, CONFIG.AI_TIME_BUDGET_PREF, String(CONFIG.AI_TIME_BUDGET_DEFAULT)),
    CONFIG.AI_TIME_BUDGET_DEFAULT,
  );

/**
 * Pull the reasoning capabilities of one model out of a `/v1/models` payload.
 *
 * @returns {null | {supported: boolean|null, toggleable: boolean|null, accepted: string[]|null}}
 *   null when the payload says nothing about that model, so callers can tell
 *   "unknown" apart from "reasoning unsupported".
 */
export const parseModelReasoningCapabilities = (payload, model, endpointPath = "/v1/chat/completions") => {
  const wanted = String(model || "").trim();
  if (!wanted) return null;
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const entry = list.find((item) => String(item?.id ?? item?.name ?? "").trim() === wanted);
  if (!entry) return null;

  const toggle = entry.reasoning_toggle?.[endpointPath];
  const accepted = entry.reasoning_effort_accepted?.[endpointPath];
  const capabilities = {
    supported: typeof entry.supports_reasoning === "boolean" ? entry.supports_reasoning : null,
    toggleable: typeof toggle === "boolean" ? toggle : null,
    accepted: Array.isArray(accepted) ? accepted.map((v) => String(v).trim().toLowerCase()).filter(Boolean) : null,
  };
  if (capabilities.supported == null && capabilities.toggleable == null && capabilities.accepted == null) {
    return null;
  }
  return capabilities;
};

/**
 * Map the user's preference onto a wire value.
 *
 * @returns {string|null} null means "send no reasoning parameter", which is the
 *   right answer for a non-reasoning model and for the "default" preference.
 */
export const resolveReasoningEffort = (preference, capabilities = {}) => {
  const pref = normalizeReasoningPreference(preference);
  if (pref === REASONING_DEFAULT) return null;

  const accepted = Array.isArray(capabilities?.accepted) && capabilities.accepted.length
    ? capabilities.accepted
    : null;
  if (capabilities?.supported === false && !accepted) return null;

  if (pref === REASONING_FAST) {
    if (accepted) {
      for (const candidate of ["none", "minimal"]) {
        if (accepted.includes(candidate)) return candidate;
      }
      // Reasoning cannot be switched off (GLM-5.3 over chat/completions only
      // accepts low|high|max). Take the cheapest level it does allow.
      return [...accepted].sort((a, b) => (levelRank(a) ?? 99) - (levelRank(b) ?? 99))[0] || null;
    }
    // Unknown model: ask for reasoning off and let the caller drop the field
    // again if the gateway rejects it as an unknown parameter.
    return "none";
  }

  if (accepted) {
    if (accepted.includes(pref)) return pref;
    const wantedRank = levelRank(pref) ?? 2;
    return [...accepted].sort(
      (a, b) => Math.abs((levelRank(a) ?? 99) - wantedRank) - Math.abs((levelRank(b) ?? 99) - wantedRank),
    )[0] || null;
  }
  return pref;
};

// Does this 400 complain about the reasoning field itself (rather than about
// the model, the key or max_tokens)? Then the caller retries without it.
export const isReasoningParamError = (status, body) => {
  if (status !== 400) return false;
  const text = String(body || "");
  // Providers word this differently: "reasoning_effort", "reasoning.effort",
  // "thinking is not supported", or just "effort".
  if (!/reasoning|thinking|effort/i.test(text)) return false;
  return /unsupported|not supported|unrecognized|unknown|invalid|unexpected|extra/i.test(text);
};

// One-line summary for the settings connection test.
export const describeReasoningSelection = (preference, capabilities, effort) => {
  const pref = normalizeReasoningPreference(preference);
  if (effort) {
    return capabilities?.accepted && !capabilities.accepted.includes("none") && pref === REASONING_FAST
      ? `reasoning ${effort} (model cannot switch it off)`
      : `reasoning ${effort}`;
  }
  if (pref === REASONING_DEFAULT) return "reasoning: provider default";
  return "reasoning off";
};
