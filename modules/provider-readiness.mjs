// Zen Tab Sorting — Registry-driven Provider Readiness & Consent Gate.
//
// Rules:
// - `"off"`, `"none"`, and `"local"` (Firefox bundled ML) are not remote/LLM
//   provider endpoints -> `{ ok: false, reason: "provider_disabled" }`.
// - Consent (`consentToSendData`) is required for ALL non-loopback endpoints
//   (including a remote Ollama host on LAN/VPS!) and waived for loopback
//   endpoints (`localhost`, `127.0.0.0/8`, `::1`, including Ollama, LM Studio,
//   llama.cpp, vLLM, and local custom servers).
// - `apiKey` is optional whenever `!requiresApiKeyForProfile(profile)`.

import {
  PROVIDER_PRESETS,
  getProviderPreset,
  isLoopbackHost,
  requiresApiKeyForProfile,
  requiresConsentForProfile,
  resolveProfileEndpoint,
} from "./provider-registry.mjs";

export const PROVIDER_NAMES = Object.freeze([
  "off",
  "none",
  "local",
  ...PROVIDER_PRESETS.map((p) => p.id),
]);

const DISABLED_PROVIDERS = new Set(["", "off", "none", "local"]);

export const getProviderReadiness = (settings) => {
  if (!settings || typeof settings !== "object") {
    return { ok: false, reason: "provider_disabled" };
  }
  const provider = String(settings.provider || "off").trim().toLowerCase();
  if (DISABLED_PROVIDERS.has(provider)) {
    return { ok: false, reason: "provider_disabled" };
  }

  const preset = getProviderPreset(provider);
  if (!preset) {
    if (!settings.consentToSendData) {
      return { ok: false, reason: "consent_required" };
    }
    return { ok: false, reason: "missing_required_config", missingFields: ["provider"] };
  }

  const endpoint = resolveProfileEndpoint(settings);
  const isLoopback = Boolean(endpoint && isLoopbackHost(endpoint));

  if (!isLoopback && requiresConsentForProfile(settings) && !settings.consentToSendData) {
    return { ok: false, reason: "consent_required" };
  }

  const missingFields = getMissingRequiredFields(settings, preset, endpoint);
  return missingFields.length > 0
    ? { ok: false, reason: "missing_required_config", missingFields }
    : { ok: true, value: settings };
};

export const requestProviderFetch = async (settings, fetchProvider) => {
  const readiness = getProviderReadiness(settings);
  if (!readiness.ok) return readiness;
  return { ok: true, value: await fetchProvider(readiness.value) };
};

const getMissingRequiredFields = (settings, preset, resolvedEndpoint) => {
  const missing = [];

  // Endpoint check:
  // - If caller explicitly passed an empty `endpoint: ""` string on a profile
  //   that expects one (or if preset has no defaultBaseUrl), flag `endpoint`.
  const hasExplicitEmptyEndpoint =
    Object.hasOwn(settings, "endpoint") &&
    (typeof settings.endpoint !== "string" || settings.endpoint.trim().length === 0) &&
    preset.id !== "gemini" &&
    preset.id !== "chatgpt";

  if (hasExplicitEmptyEndpoint || (!resolvedEndpoint && preset.requiresEndpoint)) {
    missing.push("endpoint");
  }

  // OAuth vs API Key check
  if (preset.requiresOAuth) {
    const hasToken =
      (typeof settings.accessToken === "string" && settings.accessToken.trim().length > 0) ||
      (typeof settings.refreshToken === "string" && settings.refreshToken.trim().length > 0);
    if (!hasToken) missing.push("accessToken");
  } else if (requiresApiKeyForProfile(settings)) {
    if (typeof settings.apiKey !== "string" || settings.apiKey.trim().length === 0) {
      missing.push("apiKey");
    }
  }

  // Model check
  if (typeof settings.model !== "string" || settings.model.trim().length === 0) {
    missing.push("model");
  }

  return missing;
};
