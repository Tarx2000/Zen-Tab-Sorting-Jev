// Zen Tab Sorting — Unified Provider Registry.
//
// Declarative catalog of 18 built-in provider presets across 5 protocol adapters:
//   - "openai-chat"        (OpenAI Chat Completions & compatible cloud/local servers)
//   - "openai-responses"   (OpenAI /v1/responses — Sign in with ChatGPT & Responses API)
//   - "anthropic-messages" (Anthropic /v1/messages)
//   - "google-gemini"      (Google Generative Language v1beta generateContent)
//   - "ollama-native"      (Ollama /api/generate, /api/chat, /api/tags, /api/show, /api/pull)

import { CONFIG } from "./config.mjs";

export const ADAPTER_KINDS = Object.freeze([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-gemini",
  "ollama-native",
]);

export const PROVIDER_PRESETS = Object.freeze([
  // ── Native Cloud (5) ───────────────────────────────────────────────────────
  Object.freeze({
    id: "openai",
    name: "OpenAI",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "chatgpt",
    name: "ChatGPT (Sign in)",
    category: "cloud",
    adapter: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: CONFIG.AI_CHATGPT_MODEL_DEFAULT,
    requiresKey: false,
    requiresOAuth: true,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "anthropic",
    name: "Anthropic (Claude)",
    category: "cloud",
    adapter: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: false,
    supportsJsonSchema: false,
    supportsModelList: true,
    apiVersion: "2023-06-01",
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "gemini",
    name: "Google Gemini",
    category: "cloud",
    adapter: "google-gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "azure-openai",
    name: "Azure OpenAI",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "",
    defaultModel: "",
    requiresKey: true,
    requiresOAuth: false,
    requiresEndpoint: true,
    authStyle: "api-key",
    apiVersion: "2024-10-21",
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),

  // ── OpenAI-Compatible Cloud (8) ────────────────────────────────────────────
  Object.freeze({
    id: "openrouter",
    name: "OpenRouter",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4.1-mini",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({
      "HTTP-Referer": "https://github.com/LoopRook/Zen-Tab-Sorting",
      "X-Title": "Zen Tab Sorting",
    }),
  }),
  Object.freeze({
    id: "groq",
    name: "Groq",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "mistral",
    name: "Mistral",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "deepseek",
    name: "DeepSeek",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: false,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "xai",
    name: "xAI (Grok)",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3-mini",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "perplexity",
    name: "Perplexity",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: false,
    supportsJsonSchema: false,
    supportsModelList: false,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "github-models",
    name: "GitHub Models",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: "https://models.inference.ai.azure.com",
    defaultModel: "gpt-4o-mini",
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "primalabs",
    name: "PrimaLabs",
    category: "cloud",
    adapter: "openai-chat",
    defaultBaseUrl: CONFIG.AI_PRIMALABS_ENDPOINT_DEFAULT,
    defaultModel: CONFIG.AI_PRIMALABS_MODEL_DEFAULT,
    requiresKey: true,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),

  // ── Local (4) — requiresKey: false, loopback-consent-exempt ────────────────
  Object.freeze({
    id: "ollama",
    name: "Ollama (Local)",
    category: "local",
    adapter: "ollama-native",
    defaultBaseUrl: CONFIG.AI_OLLAMA_HOST_DEFAULT,
    defaultModel: CONFIG.AI_OLLAMA_MODEL_DEFAULT,
    requiresKey: false,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "lmstudio",
    name: "LM Studio (Local)",
    category: "local",
    adapter: "openai-chat",
    defaultBaseUrl: "http://localhost:1234/v1",
    defaultModel: "",
    requiresKey: false,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "llamacpp",
    name: "llama.cpp Server (Local)",
    category: "local",
    adapter: "openai-chat",
    defaultBaseUrl: "http://localhost:8080/v1",
    defaultModel: "",
    requiresKey: false,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
  Object.freeze({
    id: "vllm",
    name: "vLLM (Local)",
    category: "local",
    adapter: "openai-chat",
    defaultBaseUrl: "http://localhost:8000/v1",
    defaultModel: "",
    requiresKey: false,
    requiresOAuth: false,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),

  // ── Generic Custom (1) ─────────────────────────────────────────────────────
  Object.freeze({
    id: "custom",
    name: "Custom Endpoint",
    category: "custom",
    adapter: "openai-chat",
    defaultBaseUrl: "",
    defaultModel: "",
    requiresKey: false,
    requiresOAuth: false,
    requiresEndpoint: true,
    selectableAdapter: true,
    customHeadersSupported: true,
    jsonMode: true,
    supportsJsonSchema: true,
    supportsModelList: true,
    defaultHeaders: Object.freeze({}),
  }),
]);

const PRESETS_BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export const getProviderPreset = (id) => {
  const normalized = String(id || "").trim().toLowerCase();
  return PRESETS_BY_ID.get(normalized) || null;
};

export const listProviderPresets = (filter = null) => {
  if (!filter || typeof filter !== "object") return [...PROVIDER_PRESETS];
  return PROVIDER_PRESETS.filter((preset) => {
    if (filter.category && preset.category !== filter.category) return false;
    if (filter.adapter && preset.adapter !== filter.adapter) return false;
    return true;
  });
};

const IPV4_LOOPBACK = /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/**
 * Returns `true` strictly for loopback hosts (`localhost`, `*.localhost`,
 * `127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`). Fails closed (`false`) on empty,
 * malformed, LAN, or public URLs so consent is never bypassed accidentally.
 */
export const isLoopbackHost = (url) => {
  const raw = String(url ?? "").trim();
  if (!raw) return false;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return false;
  }
  const hostname = String(parsed.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (IPV4_LOOPBACK.test(hostname)) return true;
  if (hostname === "::1" || hostname === "0:0:0:0:0:0:0:1") return true;
  if (hostname.startsWith("::ffff:127.")) {
    return IPV4_LOOPBACK.test(hostname.slice("::ffff:".length));
  }
  // WHATWG URL normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(hostname)) return true;
  return false;
};

export const resolveProfileEndpoint = (profile) => {
  if (!profile || typeof profile !== "object") return "";
  const explicit = String(profile.endpoint ?? profile.baseUrl ?? "").trim();
  if (explicit) return explicit;
  const preset = getProviderPreset(profile.provider);
  return preset?.defaultBaseUrl || "";
};

export const resolveAdapterKind = (profile) => {
  if (!profile || typeof profile !== "object") return "openai-chat";
  const explicitAdapter = String(profile.adapter || "").trim().toLowerCase();
  if (ADAPTER_KINDS.includes(explicitAdapter)) return explicitAdapter;

  if (profile.provider === "custom") {
    const fmt = String(profile.format || "").trim().toLowerCase();
    if (ADAPTER_KINDS.includes(fmt)) return fmt;
    if (fmt === "ollama") return "ollama-native";
    if (fmt === "anthropic") return "anthropic-messages";
    if (fmt === "gemini") return "google-gemini";
    if (fmt === "responses") return "openai-responses";
    return "openai-chat";
  }

  const preset = getProviderPreset(profile.provider);
  if (preset) return preset.adapter;
  return "openai-chat";
};

/**
 * Consent is required for ALL non-loopback endpoints (including a remote Ollama
 * host on a LAN/VPS) and waived for loopback endpoints (including local Ollama,
 * LM Studio, llama.cpp, vLLM, and local custom servers).
 */
export const requiresConsentForProfile = (profile) => {
  if (!profile || typeof profile !== "object") return false;
  const provider = String(profile.provider || "off").trim().toLowerCase();
  if (!provider || provider === "off" || provider === "none" || provider === "local") {
    return false;
  }
  const endpoint = resolveProfileEndpoint(profile);
  if (endpoint && isLoopbackHost(endpoint)) return false;
  return true;
};

/**
 * Returns whether an API key is required for the given profile.
 * Local presets, OAuth providers (`chatgpt`), and `custom` endpoints default to
 * not requiring an API key unless `profile.requiresKey === true` is set.
 */
export const requiresApiKeyForProfile = (profile) => {
  if (!profile || typeof profile !== "object") return false;
  const provider = String(profile.provider || "off").trim().toLowerCase();
  if (!provider || provider === "off" || provider === "none" || provider === "local") {
    return false;
  }
  if (typeof profile.requiresKey === "boolean") return profile.requiresKey;
  const preset = getProviderPreset(provider);
  if (!preset) return false;
  if (preset.requiresOAuth) return false;
  if (preset.id === "custom") return false;
  if (preset.category === "local") return false;
  const endpoint = resolveProfileEndpoint(profile);
  if (endpoint && isLoopbackHost(endpoint) && preset.id !== "openai" && preset.id !== "gemini" && preset.id !== "anthropic") {
    return false;
  }
  return Boolean(preset.requiresKey);
};
