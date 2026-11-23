import {
  buildChatGPTResponsesRequest,
  parseChatGPTResponsesOutput,
} from "./chatgpt-auth.mjs";

const AUTH_HEADER_NAME = ["author", "ization"].join("");

// OpenAI's chat/completions parameters split with the GPT-5 generation. Older
// models, and every OpenAI-compatible server built against them (Ollama's
// shim, LM Studio, llama.cpp, vLLM), take max_tokens plus any temperature.
// The newer models reject both: they want max_completion_tokens and only the
// default temperature. The endpoint does not tell you which you are talking
// to, since api.openai.com serves both generations and a gateway can serve a
// new model at a classic-looking URL, so the builder emits either shape and
// the caller picks one.
export const PARAM_STYLE_CLASSIC = "classic";
export const PARAM_STYLE_MODERN = "modern";
export const PARAM_STYLE_MODERN_BARE = "modern-bare";

// Shapes to try, best guess first. A gateway may serve a newer model but
// reject reasoning_effort, so the modern guess falls back to a bare modern
// request before giving up and trying the classic one.
export const paramStyleLadder = (model) =>
  guessParamStyle(model) === PARAM_STYLE_MODERN
    ? [PARAM_STYLE_MODERN, PARAM_STYLE_MODERN_BARE, PARAM_STYLE_CLASSIC]
    : [PARAM_STYLE_CLASSIC, PARAM_STYLE_MODERN, PARAM_STYLE_MODERN_BARE];

const isModernStyle = (paramStyle) =>
  paramStyle === PARAM_STYLE_MODERN || paramStyle === PARAM_STYLE_MODERN_BARE;

export const buildProviderRequest = (
  provider,
  prompt,
  maxTokens,
  paramStyle = PARAM_STYLE_CLASSIC,
  options = {},
) => {
  // `reasoningEffort` is an explicit override:
  //   undefined — keep the historical behaviour (modern shape defaults to
  //               "low", classic shape sends nothing)
  //   null      — send no reasoning field at all
  //   string    — send that effort ("none", "low", "medium", ...)
  // Sorting calls always pass it, because the provider default was burning
  // whole seconds on hidden thinking before the first visible token.
  const hasEffort = Object.hasOwn(options, "reasoningEffort");
  const reasoningEffort = hasEffort ? options.reasoningEffort : undefined;
  const jsonMode = Boolean(options.jsonMode);
  // Reasoning capability and parameter dialect are independent. GLM accepts
  // classic max_tokens while still spending that budget on hidden thinking.
  const modelNeedsReasoning = getProviderKind(provider) === "openai" &&
    reasoningEffort !== "none" &&
    /(?:^|\/)glm-5\.3(?:[-.]|$)/i.test(String(provider.model || "").trim());
  const boundedTokens = boundMaxTokens(maxTokens, paramStyle, modelNeedsReasoning, reasoningEffort === "none");
  switch (provider.provider) {
    case "openai":
    case "primalabs":
      return openAiRequest(provider.endpoint, provider.apiKey, provider.model, prompt, boundedTokens, paramStyle, reasoningEffort, hasEffort, jsonMode);
    case "chatgpt":
      return buildChatGPTResponsesRequest({
        accessToken: provider.accessToken,
        model: provider.model,
        inputText: prompt,
        ...(hasEffort && reasoningEffort ? { reasoningEffort } : {}),
      });
    case "gemini":
      return geminiRequest(provider.apiKey, provider.model, prompt, boundedTokens, { reasoningEffort, jsonMode });
    case "ollama":
      return ollamaRequest(provider.endpoint, provider.model, prompt, boundedTokens);
    case "custom":
      return provider.format === "ollama"
        ? ollamaRequest(provider.endpoint, provider.model, prompt, boundedTokens)
        : openAiRequest(provider.endpoint, provider.apiKey, provider.model, prompt, boundedTokens, paramStyle, reasoningEffort, hasEffort, jsonMode);
    default:
      throw new ProviderRequestError(provider.provider);
  }
};

// A model name that marks itself as the newer generation, so the first request
// can use the right shape instead of spending a round trip to learn it. A wrong
// guess here costs nothing: the retry covers both directions.
export const guessParamStyle = (model) =>
  /^(?:gpt-5|o[134])/i.test(String(model || "").trim()) ? PARAM_STYLE_MODERN : PARAM_STYLE_CLASSIC;

// True when a failed response is complaining about the parameter shape rather
// than about the key, the model or the quota, so retrying with the other shape
// is worth doing.
export const isParamStyleError = (status, body) => {
  if (status !== 400) return false;
  const text = String(body || "");
  if (/max_completion_tokens/i.test(text)) return true;
  return /unsupported|not supported|only the default|unrecognized|unknown/i.test(text)
    && /max_tokens|temperature|reasoning_effort/i.test(text);
};

export const isResponseFormatError = (status, body) => {
  if (status !== 400) return false;
  const text = String(body || "");
  return /response_format|responseMimeType|json_object/i.test(text)
    && /unsupported|not supported|unrecognized|unknown|invalid|unexpected/i.test(text);
};

// A 200 with no usable text is a dead end to debug from, so say why: a
// reasoning model that spent its whole budget thinking reports
// finish_reason "length" with the reasoning tokens it burned.
export const describeEmptyResponse = (kind, text) => {
  if (kind !== "openai") return "";
  const parsed = parseJson(text);
  const choice = parsed?.choices?.[0];
  if (!choice) return "";
  const parts = [];
  if (choice.finish_reason) parts.push(`finish_reason=${choice.finish_reason}`);
  if (choice.message?.refusal) parts.push(`refusal=${String(choice.message.refusal).slice(0, 80)}`);
  const reasoning = parsed?.usage?.completion_tokens_details?.reasoning_tokens;
  if (Number.isFinite(reasoning)) parts.push(`reasoning_tokens=${reasoning}`);
  return parts.join(", ");
};

export const isEmptyLengthResponse = (kind, text) => {
  if (kind !== "openai") return false;
  const choice = parseJson(text)?.choices?.[0];
  return choice?.finish_reason === "length" && !choice.message?.refusal &&
    (choice.message?.content == null || (typeof choice.message.content === "string" && !choice.message.content.trim()));
};

export const getProviderKind = (provider) => {
  if (provider.provider === "custom") return provider.format;
  if (provider.provider === "primalabs") return "openai";
  return provider.provider;
};

export const parseProviderResponse = (kind, text) => {
  if (kind === "chatgpt") return parseChatGPTResponsesOutput(text);
  const parsed = parseJson(text);
  if (parsed === null) return null;
  if (kind === "ollama") return typeof parsed.response === "string" ? parsed.response : null;
  if (kind === "openai") return parsed.choices?.[0]?.message?.content ?? null;
  if (kind === "gemini") return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  return null;
};

const openAiRequest = (
  endpoint,
  apiKey,
  model,
  prompt,
  maxTokens,
  paramStyle,
  reasoningEffort,
  hasEffort,
  jsonMode = false,
) => {
  // Modern models take max_completion_tokens and no temperature; classic ones
  // take max_tokens and a temperature. Both now carry an explicit reasoning
  // setting, because an omission means "whatever the provider defaults to" —
  // for reasoning models that is the slow path.
  const effortField = !hasEffort
    // Historical behaviour: the modern shape asked for "low" (at "minimal"
    // these models have been reported to return nothing at all on
    // extraction-shaped prompts); the classic shape sent nothing.
    ? (paramStyle === PARAM_STYLE_MODERN ? { reasoning_effort: "low" } : {})
    : (reasoningEffort ? { reasoning_effort: reasoningEffort } : {});

  return {
    url: appendPath(endpoint, "/chat/completions"),
    init: {
      method: "POST",
      headers: { "content-type": "application/json", [AUTH_HEADER_NAME]: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(isModernStyle(paramStyle)
          ? { max_completion_tokens: maxTokens, ...effortField }
          : { max_tokens: maxTokens, temperature: 0.2, ...effortField }),
      }),
    },
  };
};

const geminiRequest = (apiKey, model, prompt, maxTokens, { reasoningEffort, jsonMode = false } = {}) => {
  const generationConfig = { maxOutputTokens: maxTokens, temperature: 0.2 };
  if (jsonMode) generationConfig.responseMimeType = "application/json";
  if (reasoningEffort === "none" && /gemini-(?:2\.5|3)/i.test(String(model || ""))) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
    },
  };
};

const ollamaRequest = (endpoint, model, prompt, maxTokens) => ({
  url: appendPath(endpoint, "/api/generate"),
  init: {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: maxTokens } }),
  },
});

const appendPath = (endpoint, path) => {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return trimmed.endsWith(path) ? trimmed : `${trimmed}${path}`;
};

// Reasoning models bill hidden reasoning against max_completion_tokens before
// they emit a single visible character, so a budget sized for the answer alone
// comes back empty with finish_reason "length". The budget is a ceiling rather
// than an allocation — unused tokens cost nothing — so modern requests get
// generous headroom and a floor that a short reply cannot starve under.
const REASONING_HEADROOM = 4096;
const MODERN_MIN_TOKENS = 2048;
const MAX_COMPLETION_TOKENS = 16384;

const boundMaxTokens = (value, paramStyle, modelNeedsReasoning = false, reasoningOff = false) => {
  const requested = Number.isFinite(value) ? Math.trunc(value) : 800;
  // No thinking means no hidden-token reservation: the answer gets exactly the
  // budget the caller asked for, which also caps a runaway response.
  const needsReasoningBudget = !reasoningOff && (isModernStyle(paramStyle) || modelNeedsReasoning);
  return needsReasoningBudget
    ? Math.min(Math.max(requested + REASONING_HEADROOM, MODERN_MIN_TOKENS), MAX_COMPLETION_TOKENS)
    : Math.min(Math.max(requested, 64), MAX_COMPLETION_TOKENS);
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export class ProviderRequestError extends Error {
  constructor(provider) {
    super(`Unexpected provider: ${provider}`);
    this.name = "ProviderRequestError";
    this.provider = provider;
  }
}
