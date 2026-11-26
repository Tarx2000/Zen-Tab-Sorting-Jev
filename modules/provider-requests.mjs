// Zen Tab Sorting — Provider Request Builder & Response Parser facade.
//
// Delegates to the 5 unified protocol adapters in `provider-adapters.mjs` and
// the 18-preset catalog in `provider-registry.mjs` while keeping all existing
// exported signatures stable for `remote-provider.mjs` and unit tests.
//
// Supported protocol endpoints:
//   - OpenAI Chat Completions (`/chat/completions`)
//   - OpenAI Responses (`/responses`)
//   - Anthropic Messages (`/messages`)
//   - Google Gemini (`:generateContent`, API key via `x-goog-api-key` header)
//   - Ollama Native (`/api/generate`)
//   - Custom endpoints (`custom`)

import {
  buildChatGPTResponsesRequest,
  parseChatGPTResponsesOutput,
} from "./chatgpt-auth.mjs";
import {
  getAdapterForKind,
  getAdapterForProfile,
} from "./provider-adapters.mjs";
import {
  getProviderPreset,
  resolveAdapterKind,
} from "./provider-registry.mjs";
import {
  isJsonSchemaParamError,
  isReasoningParamError,
  isTemperatureParamError,
  isTokenParamError,
  stripModelPrefix,
} from "./reasoning.mjs";

// OpenAI's chat/completions parameters split with the GPT-5 generation. Older
// models, and every OpenAI-compatible server built against them (Ollama's
// shim, LM Studio, llama.cpp, vLLM), take max_tokens plus any temperature.
// The newer models reject both: they want max_completion_tokens and only the
// default temperature.
export const PARAM_STYLE_CLASSIC = "classic";
export const PARAM_STYLE_MODERN = "modern";
export const PARAM_STYLE_MODERN_BARE = "modern-bare";

export const paramStyleLadder = (model) =>
  guessParamStyle(model) === PARAM_STYLE_MODERN
    ? [PARAM_STYLE_MODERN, PARAM_STYLE_MODERN_BARE, PARAM_STYLE_CLASSIC]
    : [PARAM_STYLE_CLASSIC, PARAM_STYLE_MODERN, PARAM_STYLE_MODERN_BARE];

export const buildProviderRequest = (
  provider,
  prompt,
  maxTokens,
  paramStyle = PARAM_STYLE_CLASSIC,
  options = {},
) => {
  if (!provider || typeof provider !== "object") {
    throw new ProviderRequestError(provider?.provider);
  }
  const preset = getProviderPreset(provider.provider);
  if (!preset) {
    throw new ProviderRequestError(provider.provider);
  }

  // Keep ChatGPT SIWC helper path aligned when invoked with legacy options
  if (provider.provider === "chatgpt" && !options.systemPrompt && !options.jsonSchema && typeof prompt === "string") {
    const hasEffort = Object.hasOwn(options, "reasoningEffort");
    const reasoningEffort = hasEffort ? options.reasoningEffort : undefined;
    return buildChatGPTResponsesRequest({
      accessToken: provider.accessToken,
      model: provider.model,
      inputText: prompt,
      ...(hasEffort && reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  const adapter = getAdapterForProfile(provider);
  return adapter.buildRequest(provider, prompt, maxTokens, {
    ...options,
    paramStyle,
  });
};

// Prefix-stripped parameter style heuristic so both `gpt-5-nano` and
// `openai/gpt-5-mini`, `o3-mini`, `o4-mini`, `o5`, `gpt-6` map to modern.
export const guessParamStyle = (model) => {
  const stripped = stripModelPrefix(model);
  return /^(?:gpt-[56]|o[1345])(?:[-._]|$)/i.test(stripped)
    ? PARAM_STYLE_MODERN
    : PARAM_STYLE_CLASSIC;
};

// True when a failed 400/422 response is complaining about parameter shape
// rather than about the key, the model, or the quota.
export const isParamStyleError = (status, body) => {
  if (status !== 400 && status !== 422) return false;
  return isTokenParamError(status, body) ||
    isTemperatureParamError(status, body) ||
    isReasoningParamError(status, body);
};

export const isResponseFormatError = (status, body) => {
  if (status !== 400 && status !== 422) return false;
  if (isJsonSchemaParamError(status, body)) return true;
  const text = String(body || "");
  return /response_format|responseMimeType|json_object/i.test(text)
    && /unsupported|not supported|unrecognized|unknown|invalid|unexpected/i.test(text);
};

// Generalized across OpenAI, Responses, Gemini, Anthropic, and Ollama.
export const describeEmptyResponse = (kind, text) => {
  const adapter = getAdapterForKind(kind);
  return adapter ? adapter.describeEmptyResponse(text) : "";
};

export const isEmptyLengthResponse = (kind, text) => {
  const adapter = getAdapterForKind(kind);
  return adapter ? adapter.isEmptyLengthResponse(text) : false;
};

export const getProviderKind = (provider) => {
  if (!provider || typeof provider !== "object") return "";
  const adapterKind = resolveAdapterKind(provider);
  switch (adapterKind) {
    case "ollama-native":
      return "ollama";
    case "google-gemini":
      return "gemini";
    case "openai-responses":
      return "chatgpt";
    case "anthropic-messages":
      return "anthropic";
    case "openai-chat":
    default:
      return "openai";
  }
};

export const parseProviderResponse = (kind, text) => {
  if (kind === "chatgpt") return parseChatGPTResponsesOutput(text);
  const adapter = getAdapterForKind(kind);
  return adapter ? adapter.parseResponse(text) : null;
};

export class ProviderRequestError extends Error {
  constructor(provider) {
    super(`Unexpected provider: ${provider}`);
    this.name = "ProviderRequestError";
    this.provider = provider;
  }
}
