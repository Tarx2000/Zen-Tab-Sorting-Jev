// Zen Tab Sorting — reasoning-effort policy & 4-tier capability resolver.
//
// Tier 1: Live adapter catalog metadata (PrimaLabs, OpenRouter supported_parameters,
//         Ollama /api/show, Gemini model metadata).
// Tier 2: Learned per-(provider, endpoint, model) recovery overrides.
// Tier 3: Prefix-stripped model-family heuristics (handles provider prefixes like
//         `openai/gpt-5-mini`, `primalabs-ai/GLM-5.3-Flash`, `deepseek/deepseek-r1`).
// Tier 4: Safe default + generalized HTTP 400/422 error-recovery ladder across
//         all providers (`none -> minimal -> low -> null`, Gemini thinkingBudget
//         `0 -> 128 -> omit`, `max_tokens <-> max_completion_tokens`, temperature drop).
//
// Loaded by provider-adapters, provider-requests, remote-provider, and prefs UI.
// No network I/O here.

import { CONFIG } from "./config.mjs";

export const REASONING_FAST = "fast";
export const REASONING_DEFAULT = "default";

// Cheapest first. The index is the only thing that matters for "nearest level".
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const REASONING_RECOVERY_LADDER = Object.freeze(["none", "minimal", "low", null]);
export const GEMINI_THINKING_BUDGET_LADDER = Object.freeze([0, 128, null]);

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
 * Strip provider/organization prefixes (`openai/gpt-5-mini`, `models/gemini-2.5-pro`,
 * `primalabs-ai/GLM-5.3-Flash`) so model-family heuristics work across aggregators
 * like OpenRouter, GitHub Models, and PrimaLabs.
 */
export const stripModelPrefix = (model) => {
  const raw = String(model || "").trim();
  if (!raw) return "";
  const slashIdx = raw.lastIndexOf("/");
  const base = slashIdx >= 0 ? raw.slice(slashIdx + 1) : raw;
  return base.trim();
};

/**
 * Tier 3: Prefix-stripped model-family heuristics for reasoning and parameter dialect.
 * Returns `null` when the model family is unrecognized.
 */
export const inferModelReasoningCapabilities = (model) => {
  const stripped = stripModelPrefix(model).toLowerCase();
  if (!stripped) return null;

  // OpenAI GPT-5 / GPT-6 generation (modern parameter style, reasoning_effort supported)
  if (/^gpt-[56](?:[-._]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: true,
      accepted: null,
      paramStyle: "modern",
      needsReasoningHeadroom: true,
    };
  }

  // OpenAI o1 / o3 / o4 / o5 series (modern parameter style; reasoning cannot be turned fully off)
  if (/^o[1345](?:[-._]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: false,
      accepted: ["low", "medium", "high"],
      paramStyle: "modern",
      needsReasoningHeadroom: true,
    };
  }

  // DeepSeek R1 / Reasoner
  if (/^deepseek-(?:r1|reasoner)(?:[-._:]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: false,
      accepted: null,
      paramStyle: "classic",
      thinksInTags: true,
      supportsOllamaThinkToggle: true,
      needsReasoningHeadroom: true,
    };
  }

  // Qwen3 / QwQ thinking models
  if (/^(?:qwen3|qwq)(?:[-._:]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: true,
      accepted: null,
      paramStyle: "classic",
      thinksInTags: true,
      supportsOllamaThinkToggle: true,
      needsReasoningHeadroom: true,
    };
  }

  // xAI Grok-3-mini / Grok-4
  if (/^grok-3-mini(?:[-._]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: false,
      accepted: ["low", "high"],
      paramStyle: "classic",
      needsReasoningHeadroom: true,
    };
  }
  if (/^grok-4(?:[-._]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: false,
      accepted: ["low", "high"],
      paramStyle: "classic",
      needsReasoningHeadroom: true,
    };
  }

  // Anthropic Claude 3.7 / Claude 4 (Sonnet/Opus/Haiku 4+)
  if (/^claude-(?:3[.-]7|4(?:[.-]|$)|(?:sonnet|opus|haiku)-4)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: true,
      accepted: ["none", "low", "medium", "high"],
      paramStyle: "anthropic",
      anthropicThinking: true,
      needsReasoningHeadroom: true,
    };
  }

  // GLM-5.3 / GLM-4.5 reasoning series
  if (/^glm-(?:5\.3|4\.5)(?:[-._:]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: null,
      accepted: null,
      paramStyle: "classic",
      needsReasoningHeadroom: true,
    };
  }

  // Gemini 2.5 Pro (cannot disable thinking with budget 0; minimum is 128)
  if (/^gemini-2\.5-pro(?:[-._]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: false,
      accepted: ["low", "medium", "high"],
      paramStyle: "gemini",
      geminiThinking: true,
      minThinkingBudget: 128,
      needsReasoningHeadroom: true,
    };
  }

  // Gemini 2.5 Flash / Lite / Gemini 3 (supports thinkingBudget: 0)
  if (/^gemini-(?:2\.5|3)(?:[-._]|$)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: true,
      toggleable: true,
      accepted: ["none", "low", "medium", "high"],
      paramStyle: "gemini",
      geminiThinking: true,
      minThinkingBudget: 0,
      needsReasoningHeadroom: false,
    };
  }

  // Well-known non-reasoning families
  if (/^(?:gpt-4(?:o|\.1|-turbo)?|gpt-3\.5|gemini-(?:1\.5|2\.0)|claude-3(?:[.-](?:5|0)|-haiku|-sonnet|-opus)|llama-?3(?:\.\d)?|mistral|mixtral|gemma)/.test(stripped)) {
    return {
      source: "heuristic",
      supported: false,
      toggleable: false,
      accepted: null,
      paramStyle: "classic",
      needsReasoningHeadroom: false,
    };
  }

  return null;
};

/**
 * Tier 1: Pull the reasoning capabilities of one model out of a live catalog
 * payload across PrimaLabs (`/v1/models`), OpenRouter (`supported_parameters`),
 * Ollama (`/api/show`), and Google Gemini model info.
 *
 * @returns {null | {supported: boolean|null, toggleable: boolean|null, accepted: string[]|null, supportsJsonSchema?: boolean, supportsJsonMode?: boolean, contextLength?: number}}
 *   null when the payload says nothing about that model, so callers can tell
 *   "unknown" apart from "reasoning unsupported".
 */
export const parseModelReasoningCapabilities = (payload, model, endpointPath = "/v1/chat/completions") => {
  const wanted = String(model || "").trim();
  if (!payload || typeof payload !== "object") return null;

  // Ollama `/api/show` direct object shape (`{ capabilities: [...], model_info: {...} }`)
  if (Array.isArray(payload.capabilities) && !Array.isArray(payload.data) && !Array.isArray(payload.models)) {
    const caps = payload.capabilities.map((c) => String(c || "").trim().toLowerCase());
    const hasThinking = caps.includes("thinking") || caps.includes("reasoning");
    return {
      supported: hasThinking,
      toggleable: hasThinking ? true : null,
      accepted: hasThinking ? ["none", "low", "high"] : null,
      supportsOllamaThinkToggle: hasThinking,
    };
  }

  if (!wanted) return null;
  const normalizedWanted = wanted.toLowerCase();
  const strippedWanted = stripModelPrefix(wanted).toLowerCase();

  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const entry = list.find((item) => {
    const id = String(item?.id ?? item?.slug ?? item?.name ?? "").trim();
    if (!id) return false;
    const lower = id.toLowerCase();
    return id === wanted || lower === normalizedWanted || (lower.startsWith("models/") && lower.slice(7) === strippedWanted);
  });
  if (!entry) return null;

  // 1. PrimaLabs explicit reasoning metadata
  const toggle = entry.reasoning_toggle?.[endpointPath];
  const accepted = entry.reasoning_effort_accepted?.[endpointPath];
  if (
    typeof entry.supports_reasoning === "boolean" ||
    typeof toggle === "boolean" ||
    Array.isArray(accepted)
  ) {
    const capabilities = {
      supported: typeof entry.supports_reasoning === "boolean" ? entry.supports_reasoning : null,
      toggleable: typeof toggle === "boolean" ? toggle : null,
      accepted: Array.isArray(accepted) ? accepted.map((v) => String(v).trim().toLowerCase()).filter(Boolean) : null,
    };
    if (capabilities.supported != null || capabilities.toggleable != null || capabilities.accepted != null) {
      return capabilities;
    }
  }

  // 2. OpenRouter `supported_parameters` metadata
  if (Array.isArray(entry.supported_parameters)) {
    const params = new Set(entry.supported_parameters.map((p) => String(p || "").trim().toLowerCase()));
    const hasReasoning = params.has("reasoning") || params.has("include_reasoning") || params.has("reasoning_effort");
    return {
      supported: hasReasoning,
      toggleable: hasReasoning ? true : null,
      accepted: hasReasoning ? ["none", "minimal", "low", "medium", "high"] : null,
      supportsJsonSchema: params.has("structured_outputs"),
      supportsJsonMode: params.has("response_format"),
      ...(Number.isFinite(entry.context_length) ? { contextLength: entry.context_length } : {}),
    };
  }

  // 3. Google Gemini model info (`thinking` boolean or `supportedGenerationMethods`)
  if (typeof entry.thinking === "boolean") {
    const isPro25 = /gemini-2\.5-pro/i.test(strippedWanted);
    return {
      supported: entry.thinking,
      toggleable: entry.thinking ? !isPro25 : false,
      accepted: entry.thinking ? (isPro25 ? ["low", "medium", "high"] : ["none", "low", "medium", "high"]) : null,
      minThinkingBudget: entry.thinking ? (isPro25 ? 128 : 0) : null,
      ...(Number.isFinite(entry.inputTokenLimit) ? { contextLength: entry.inputTokenLimit } : {}),
    };
  }

  return null;
};

/**
 * 4-tier capability resolver combining live catalog metadata, learned recovery
 * overrides, prefix-stripped model heuristics, and safe unknown fallback.
 */
export const resolveCapabilitiesForModel = ({
  model = "",
  catalogCapabilities = null,
  learnedCapabilities = null,
} = {}) => {
  const heuristic = inferModelReasoningCapabilities(model);
  const merged = {
    supported: null,
    toggleable: null,
    accepted: null,
    ...(heuristic || {}),
    ...(catalogCapabilities || {}),
    ...(learnedCapabilities || {}),
  };
  // Preserve explicit catalog/learned fields even if undefined wasn't passed
  if (catalogCapabilities && typeof catalogCapabilities.supported === "boolean") {
    merged.supported = catalogCapabilities.supported;
  }
  if (learnedCapabilities && typeof learnedCapabilities.supported === "boolean") {
    merged.supported = learnedCapabilities.supported;
  }
  return merged;
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
      // Reasoning cannot be switched off (e.g. GLM-5.3 over chat/completions or
      // o3/o4). Take the cheapest level it does allow.
      return [...accepted].sort((a, b) => (levelRank(a) ?? 99) - (levelRank(b) ?? 99))[0] || null;
    }
    // Unknown model: ask for reasoning off and let the caller drop/step the
    // field if the gateway rejects it as an unknown/unsupported parameter.
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

const isClientValidationStatus = (status) => status === 400 || status === 422;

// Does this 400/422 complain about the reasoning field itself (rather than about
// the model, the key or max_tokens)? Then the caller steps down or drops it.
export const isReasoningParamError = (status, body) => {
  if (!isClientValidationStatus(status)) return false;
  const text = String(body || "");
  if (!/reasoning|thinking|effort|think\b/i.test(text)) return false;
  return /unsupported|not supported|unrecognized|unknown|invalid|unexpected|extra|budget\s+0|cannot\s+disable|must\s+be/i.test(text);
};

export const isThinkingBudgetError = (status, body) => {
  if (!isClientValidationStatus(status)) return false;
  const text = String(body || "");
  return /thinking[_\s-]?budget|thinkingconfig|budget\s+0\s+is\s+invalid|thinking\s+mode/i.test(text);
};

export const isTemperatureParamError = (status, body) => {
  if (!isClientValidationStatus(status)) return false;
  const text = String(body || "");
  return /temperature/i.test(text) &&
    /unsupported|not supported|only the default|unrecognized|unknown|invalid|cannot be set|not allowed/i.test(text);
};

export const isTokenParamError = (status, body) => {
  if (!isClientValidationStatus(status)) return false;
  const text = String(body || "");
  if (/max_completion_tokens/i.test(text)) return true;
  return /max_tokens|max_output_tokens/i.test(text) &&
    /unsupported|not supported|unrecognized|unknown|invalid|use\s+['`"]?max_completion_tokens/i.test(text);
};

export const isJsonSchemaParamError = (status, body) => {
  if (!isClientValidationStatus(status)) return false;
  const text = String(body || "");
  return /json_schema|responseschema|structured_outputs|additionalproperties|strict/i.test(text) &&
    /unsupported|not supported|unrecognized|unknown|invalid|unexpected|failed/i.test(text);
};

/**
 * Generalized HTTP 400/422 error-recovery ladder across ALL providers.
 * Steps cleanly through:
 *   1. `json_schema` / `responseSchema` -> fallback to `json_object`
 *   2. `response_format` / `responseMimeType` -> disable `jsonMode`
 *   3. Gemini `thinkingBudget`: `0 -> 128 -> null` (omit)
 *   4. Reasoning effort: `none -> minimal -> low -> null` (omit)
 *   5. Token field switch: `max_tokens <-> max_completion_tokens`
 *   6. Temperature drop: `dropTemperature: true`
 */
export const nextReasoningRecoveryStep = ({
  adapter = "openai-chat",
  status,
  body,
  currentState = {},
} = {}) => {
  if (!isClientValidationStatus(status)) {
    return { changed: false, action: null, nextState: currentState };
  }
  const text = String(body || "");

  // 1. JSON Schema rejection -> downgrade to plain json_object
  if (currentState.jsonSchema && isJsonSchemaParamError(status, text)) {
    return {
      changed: true,
      action: "downgrade_json_schema",
      nextState: { ...currentState, jsonSchema: null, disableJsonSchema: true },
    };
  }

  // 2. Plain JSON mode rejection -> disable jsonMode
  if (
    currentState.jsonMode &&
    /response_format|responseMimeType|json_object/i.test(text) &&
    /unsupported|not supported|unrecognized|unknown|invalid|unexpected/i.test(text)
  ) {
    return {
      changed: true,
      action: "disable_json_mode",
      nextState: { ...currentState, jsonMode: false, jsonSchema: null },
    };
  }

  // 3. Gemini thinkingBudget recovery: 0 -> 128 -> omit (null)
  if (adapter === "google-gemini" && (isThinkingBudgetError(status, text) || isReasoningParamError(status, text))) {
    const currentBudget = currentState.thinkingBudget;
    const idx = GEMINI_THINKING_BUDGET_LADDER.indexOf(currentBudget);
    const nextBudget = idx >= 0 && idx + 1 < GEMINI_THINKING_BUDGET_LADDER.length
      ? GEMINI_THINKING_BUDGET_LADDER[idx + 1]
      : null;
    if (nextBudget !== currentBudget || currentState.effort != null) {
      return {
        changed: true,
        action: nextBudget === null ? "omit_thinking_config" : `step_thinking_budget_${nextBudget}`,
        nextState: {
          ...currentState,
          thinkingBudget: nextBudget,
          effort: nextBudget === null ? null : currentState.effort,
        },
      };
    }
  }

  // 4. Reasoning effort recovery ladder: none -> minimal -> low -> null
  if (currentState.effort != null && isReasoningParamError(status, text)) {
    const currentIdx = REASONING_RECOVERY_LADDER.indexOf(currentState.effort);
    const nextEffort = currentIdx >= 0 && currentIdx + 1 < REASONING_RECOVERY_LADDER.length
      ? REASONING_RECOVERY_LADDER[currentIdx + 1]
      : null;
    if (nextEffort !== currentState.effort) {
      return {
        changed: true,
        action: nextEffort === null ? "drop_reasoning_effort" : `step_reasoning_effort_${nextEffort}`,
        nextState: { ...currentState, effort: nextEffort },
      };
    }
  }

  // 5. Token parameter switch: classic <-> modern
  if (isTokenParamError(status, text)) {
    const wantsModern = /max_completion_tokens/i.test(text) && currentState.paramStyle !== "modern";
    const nextStyle = wantsModern ? "modern" : (currentState.paramStyle === "modern" ? "classic" : "modern");
    if (nextStyle !== currentState.paramStyle) {
      return {
        changed: true,
        action: `switch_param_style_${nextStyle}`,
        nextState: { ...currentState, paramStyle: nextStyle },
      };
    }
  }

  // 6. Temperature rejection -> drop temperature
  if (!currentState.dropTemperature && isTemperatureParamError(status, text)) {
    return {
      changed: true,
      action: "drop_temperature",
      nextState: { ...currentState, dropTemperature: true },
    };
  }

  return { changed: false, action: null, nextState: currentState };
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
