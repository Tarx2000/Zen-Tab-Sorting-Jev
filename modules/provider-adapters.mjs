// Zen Tab Sorting — 5 Protocol Adapters (`openai-chat`, `openai-responses`,
// `anthropic-messages`, `google-gemini`, `ollama-native`).
//
// Each adapter exposes a uniform interface:
//   {
//     kind,
//     buildRequest(profile, prompt, maxTokens, options),
//     parseResponse(rawText),
//     listModels(profile, options),
//     parseCapabilities(payload, model, endpointPath),
//     classifyError(status, body, err),
//     extractUsage(rawText),
//     isEmptyLengthResponse(rawText),
//     describeEmptyResponse(rawText),
//     streamSSE(response, options),
//   }

import { CONFIG } from "./config.mjs";
import {
  ProviderHttpError,
  classifyProviderError,
  parseRetryAfterMs,
} from "./provider-errors.mjs";
import {
  getProviderPreset,
  resolveAdapterKind,
  resolveProfileEndpoint,
} from "./provider-registry.mjs";
import {
  inferModelReasoningCapabilities,
  parseModelReasoningCapabilities,
  stripModelPrefix,
} from "./reasoning.mjs";

const AUTH_HEADER_KEY = ["author", "ization"].join("");
const API_KEY_HEADER_KEY = ["api", "key"].join("-");
const ANTHROPIC_KEY_HEADER = ["x", "api", "key"].join("-");
const GEMINI_KEY_HEADER = ["x", "goog", "api", "key"].join("-");

const REASONING_HEADROOM = 4096;
const MODERN_MIN_TOKENS = 2048;
const MAX_COMPLETION_TOKENS = 16384;

// ─── Shared utilities ────────────────────────────────────────────────────────

export const normalizeHostUrl = (host, fallback = CONFIG.AI_OLLAMA_HOST_DEFAULT) => {
  let h = String(host || "").trim();
  if (!h) h = fallback;
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, "");
};

export const appendEndpointPath = (endpoint, path) => {
  const trimmed = String(endpoint || "").trim().replace(/\/+$/, "");
  if (!trimmed) return path;
  return trimmed.endsWith(path) ? trimmed : `${trimmed}${path}`;
};

export const normalizeGeminiModelId = (value) => {
  let model = String(value ?? "").trim();
  if (model.toLowerCase().startsWith("models/")) model = model.slice("models/".length);
  if (/\s/.test(model) || /[A-Z]/.test(model)) {
    model = model.toLowerCase().replace(/\s+/g, "-");
  }
  return model;
};

/**
 * Strip `<think>...</think>` and `<reasoning>...</reasoning>` chain-of-thought
 * blocks emitted inline by reasoning models (DeepSeek-R1, Qwen3, QwQ, etc.).
 * Also strips an unclosed trailing `<think>...` block so partial reasoning never
 * corrupts JSON extraction.
 */
export const stripThinkingTags = (text) => {
  if (typeof text !== "string") return "";
  let cleaned = text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, "");
  // Handle unclosed `<think>` when output was truncated mid-thought.
  cleaned = cleaned
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<reasoning\b[^>]*>[\s\S]*$/gi, "");
  return cleaned.trim();
};

const parseJsonSafe = (text) => {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const normalizePromptParts = (prompt, options = {}) => {
  if (prompt && typeof prompt === "object" && !Array.isArray(prompt)) {
    return {
      systemPrompt: String(prompt.system ?? options.systemPrompt ?? "").trim(),
      userPrompt: String(prompt.user ?? prompt.prompt ?? ""),
    };
  }
  return {
    systemPrompt: String(options.systemPrompt ?? "").trim(),
    userPrompt: String(prompt ?? ""),
  };
};

const parseCustomHeaders = (customHeaders) => {
  if (!customHeaders) return {};
  let obj = customHeaders;
  if (typeof customHeaders === "string") {
    const trimmed = customHeaders.trim();
    if (!trimmed) return {};
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || "").trim();
    const val = v == null ? "" : String(v).trim();
    if (key && val) out[key] = val;
  }
  return out;
};

const buildMergedHeaders = (profile, extra = {}) => {
  const preset = getProviderPreset(profile?.provider);
  return {
    ...(preset?.defaultHeaders || {}),
    ...parseCustomHeaders(profile?.customHeaders),
    ...extra,
  };
};

const resolveFetch = (customFetch) => {
  if (typeof customFetch === "function") return customFetch;
  try {
    if (
      typeof Services !== "undefined" &&
      typeof window !== "undefined" &&
      window.location?.href !== "chrome://browser/content/browser.xhtml"
    ) {
      const win = Services.wm?.getMostRecentWindow?.("navigator:browser");
      if (win?.fetch) return win.fetch.bind(win);
    }
  } catch {}
  return globalThis.fetch;
};

const fetchWithSignalAndTimeout = async (url, init, { fetchImpl, signal, timeoutMs = 15000 } = {}) => {
  const doFetch = resolveFetch(fetchImpl);
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) {
    throw new ProviderHttpError({ category: "abort", message: "Request aborted" });
  }
  signal?.addEventListener?.("abort", onExternalAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(500, Math.round(timeoutMs)));
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new ProviderHttpError({
        category: "timeout",
        message: `timeout after ${Math.round(timeoutMs)}ms`,
        cause: err,
      });
    }
    if (signal?.aborted || err?.name === "AbortError") {
      throw new ProviderHttpError({
        category: "abort",
        message: "Request aborted",
        cause: err,
      });
    }
    throw new ProviderHttpError({
      category: "network",
      message: err?.message || String(err),
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onExternalAbort);
  }
};

export const boundMaxTokens = (value, { isModern = false, modelNeedsReasoning = false, reasoningOff = false } = {}) => {
  const requested = Number.isFinite(value) ? Math.trunc(value) : 800;
  const needsReasoningBudget = !reasoningOff && (isModern || modelNeedsReasoning);
  return needsReasoningBudget
    ? Math.min(Math.max(requested + REASONING_HEADROOM, MODERN_MIN_TOKENS), MAX_COMPLETION_TOKENS)
    : Math.min(Math.max(requested, 64), MAX_COMPLETION_TOKENS);
};

// ─── Incremental SSE reader (with response.text() fallback) ──────────────────

/**
 * Incrementally read an SSE response stream via `response.body.getReader()`,
 * falling back cleanly to `response.text()` for non-streaming/mocked responses.
 * Calls `onEvent(parsedJsonOrRaw)` / `onDelta(textChunk)` as chunks arrive and
 * returns the full raw text buffer so adapter parsers work uniformly.
 */
export const streamSSEResponse = async (response, { signal = null, onDelta = null, onEvent = null } = {}) => {
  if (!response) return "";
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  const hasReader = Boolean(response.body && typeof response.body.getReader === "function");

  if (!hasReader || (contentType && contentType.includes("application/json") && !contentType.includes("event-stream"))) {
    return await response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let raw = "";
  let lineBuffer = "";

  const emitLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") return;
    const event = parseJsonSafe(payload);
    if (!event) return;
    onEvent?.(event);
    const delta =
      (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) ||
      (typeof event.choices?.[0]?.delta?.content === "string" && event.choices[0].delta.content) ||
      (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) ||
      (typeof event.candidates?.[0]?.content?.parts?.[0]?.text === "string" && event.candidates[0].content.parts[0].text) ||
      "";
    if (delta) onDelta?.(delta);
  };

  try {
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch {}
        throw new ProviderHttpError({ category: "abort", message: "Stream aborted" });
      }
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = typeof value === "string" ? value : decoder.decode(value, { stream: true });
      raw += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) emitLine(line);
    }
    const flushed = decoder.decode();
    if (flushed) {
      raw += flushed;
      lineBuffer += flushed;
    }
    if (lineBuffer.trim()) emitLine(lineBuffer);
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }

  return raw;
};

// ─── Schema sanitizer for Google Gemini `responseSchema` ─────────────────────

const sanitizeGeminiSchema = (schema) => {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "additionalProperties" || key === "title") continue;
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
};

// ─── Adapter 1: openai-chat ──────────────────────────────────────────────────

const openaiChatAdapter = {
  kind: "openai-chat",

  buildRequest(profile, prompt, maxTokens, options = {}) {
    const preset = getProviderPreset(profile?.provider);
    const endpoint = resolveProfileEndpoint(profile);
    const model = String(profile?.model || preset?.defaultModel || "").trim();
    const apiKey = String(profile?.apiKey || "").trim();
    const paramStyle = options.paramStyle || "classic";
    const isModern = paramStyle === "modern" || paramStyle === "modern-bare";
    const hasEffort = Object.hasOwn(options, "reasoningEffort");
    const reasoningEffort = hasEffort ? options.reasoningEffort : undefined;
    const dropTemperature = Boolean(options.dropTemperature);

    const heuristic = inferModelReasoningCapabilities(model);
    const modelNeedsReasoning = reasoningEffort !== "none" &&
      (Boolean(heuristic?.needsReasoningHeadroom) || /(?:^|\/)glm-5\.3(?:[-.]|$)/i.test(model));
    const boundedTokens = boundMaxTokens(maxTokens, {
      isModern,
      modelNeedsReasoning,
      reasoningOff: reasoningEffort === "none",
    });

    const { systemPrompt, userPrompt } = normalizePromptParts(prompt, options);
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });

    const effortField = !hasEffort
      ? (paramStyle === "modern" ? { reasoning_effort: "low" } : {})
      : (reasoningEffort ? { reasoning_effort: reasoningEffort } : {});

    // Structured output: prefer native json_schema when provided & supported,
    // cleanly falling back to json_object (and skipping when preset.jsonMode === false, e.g. Perplexity).
    let responseFormatField = {};
    const allowJsonMode = preset ? preset.jsonMode !== false : true;
    const allowJsonSchema = (preset ? preset.supportsJsonSchema !== false : true) && !options.disableJsonSchema;
    if (options.jsonSchema && allowJsonSchema) {
      responseFormatField = {
        response_format: {
          type: "json_schema",
          json_schema: {
            name: options.schemaName || "tab_groups",
            strict: true,
            schema: options.jsonSchema,
          },
        },
      };
    } else if (options.jsonMode && allowJsonMode) {
      responseFormatField = { response_format: { type: "json_object" } };
    }

    let url = appendEndpointPath(endpoint, "/chat/completions");
    if (preset?.id === "azure-openai" && !/[?&]api-version=/i.test(url)) {
      const apiVersion = String(profile?.apiVersion || preset.apiVersion || "2024-10-21").trim();
      url += `${url.includes("?") ? "&" : "?"}api-version=${encodeURIComponent(apiVersion)}`;
    }

    const authHeaders = {};
    if (apiKey) {
      if (preset?.authStyle === "api-key") {
        authHeaders[API_KEY_HEADER_KEY] = apiKey;
      } else {
        authHeaders[AUTH_HEADER_KEY] = `Bearer ${apiKey}`;
      }
    }

    const headers = buildMergedHeaders(profile, {
      "content-type": "application/json",
      ...authHeaders,
    });

    const tokenAndTemp = isModern
      ? { max_completion_tokens: boundedTokens, ...effortField }
      : {
          max_tokens: boundedTokens,
          ...(dropTemperature ? {} : { temperature: options.temperature ?? 0.2 }),
          ...effortField,
        };

    return {
      url,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          ...responseFormatField,
          ...tokenAndTemp,
        }),
      },
    };
  },

  parseResponse(rawText) {
    const text = String(rawText || "").trim();
    if (!text) return null;

    // Handle SSE stream if returned by an OpenAI-compatible server
    if (!text.startsWith("{") && text.includes("data:")) {
      let acc = "";
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const evt = parseJsonSafe(payload);
        const delta = evt?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") acc += delta;
      }
      const cleaned = stripThinkingTags(acc);
      return cleaned || null;
    }

    const parsed = parseJsonSafe(text);
    if (!parsed) return null;
    const rawContent = parsed.choices?.[0]?.message?.content;
    if (typeof rawContent === "string") {
      const cleaned = stripThinkingTags(rawContent);
      // Preserve empty string vs null distinction when caller expects raw content
      if (!rawContent.includes("<think") && !rawContent.includes("<reasoning")) {
        return rawContent;
      }
      return cleaned;
    }
    if (Array.isArray(rawContent)) {
      const joined = rawContent
        .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
        .map((p) => p.text || "")
        .join("");
      return stripThinkingTags(joined) || null;
    }
    return null;
  },

  isEmptyLengthResponse(rawText) {
    const choice = parseJsonSafe(rawText)?.choices?.[0];
    if (!choice || choice.finish_reason !== "length" || choice.message?.refusal) return false;
    const content = choice.message?.content;
    if (content == null) return true;
    if (typeof content === "string") return !stripThinkingTags(content);
    return false;
  },

  describeEmptyResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    const choice = parsed?.choices?.[0];
    if (!choice) return "";
    const parts = [];
    if (choice.finish_reason) parts.push(`finish_reason=${choice.finish_reason}`);
    if (choice.message?.refusal) parts.push(`refusal=${String(choice.message.refusal).slice(0, 80)}`);
    const reasoning = parsed?.usage?.completion_tokens_details?.reasoning_tokens;
    if (Number.isFinite(reasoning)) parts.push(`reasoning_tokens=${reasoning}`);
    return parts.join(", ");
  },

  extractUsage(rawText) {
    const usage = parseJsonSafe(rawText)?.usage;
    if (!usage || typeof usage !== "object") return null;
    return {
      inputTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
      outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
      reasoningTokens: Number.isFinite(usage.completion_tokens_details?.reasoning_tokens)
        ? usage.completion_tokens_details.reasoning_tokens
        : null,
      totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
    };
  },

  parseCapabilities(payload, model, endpointPath = "/v1/chat/completions") {
    return parseModelReasoningCapabilities(payload, model, endpointPath);
  },

  classifyError(status, body, err) {
    return classifyProviderError(status, body, err);
  },

  async listModels(profile, { signal, fetchImpl, timeoutMs = 15000 } = {}) {
    const preset = getProviderPreset(profile?.provider);
    if (preset && preset.supportsModelList === false) return [];
    const endpoint = resolveProfileEndpoint(profile);
    if (!endpoint) return [];
    const apiKey = String(profile?.apiKey || "").trim();
    const url = appendEndpointPath(endpoint, "/models");
    const authHeaders = {};
    if (apiKey) {
      if (preset?.authStyle === "api-key") authHeaders[API_KEY_HEADER_KEY] = apiKey;
      else authHeaders[AUTH_HEADER_KEY] = `Bearer ${apiKey}`;
    }
    const headers = buildMergedHeaders(profile, { accept: "application/json", ...authHeaders });
    const response = await fetchWithSignalAndTimeout(url, { method: "GET", headers }, { fetchImpl, signal, timeoutMs });
    const body = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError({
        status: response.status,
        body,
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
        provider: profile?.provider || "openai-chat",
      });
    }
    const payload = parseJsonSafe(body);
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return list
      .filter((m) => m && typeof (m.id ?? m.name) === "string")
      .map((m) => {
        const id = String(m.id ?? m.name).trim();
        return {
          id,
          label: String(m.name && m.name !== id ? m.name : id),
          contextLength: Number.isFinite(m.context_length) ? m.context_length : null,
          capabilities: parseModelReasoningCapabilities(payload, id, "/v1/chat/completions"),
          raw: m,
        };
      });
  },

  streamSSE: streamSSEResponse,
};

// ─── Adapter 2: openai-responses ─────────────────────────────────────────────

const openaiResponsesAdapter = {
  kind: "openai-responses",

  buildRequest(profile, prompt, maxTokens, options = {}) {
    const preset = getProviderPreset(profile?.provider);
    const endpoint = resolveProfileEndpoint(profile) || "https://api.openai.com/v1";
    const model = String(profile?.model || preset?.defaultModel || CONFIG.AI_CHATGPT_MODEL_DEFAULT).trim();
    const token = String(profile?.accessToken || profile?.apiKey || "").trim();
    const { systemPrompt, userPrompt } = normalizePromptParts(prompt, options);
    const hasEffort = Object.hasOwn(options, "reasoningEffort");
    const reasoningEffort = hasEffort ? options.reasoningEffort : undefined;

    const url = appendEndpointPath(endpoint, "/responses");
    const authHeaders = token ? { [AUTH_HEADER_KEY]: `Bearer ${token}` } : {};
    const headers = buildMergedHeaders(profile, {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...authHeaders,
    });

    let textField = {};
    if (options.jsonSchema && !options.disableJsonSchema) {
      textField = {
        text: {
          format: {
            type: "json_schema",
            name: options.schemaName || "tab_groups",
            strict: true,
            schema: options.jsonSchema,
          },
        },
      };
    }

    const body = {
      model,
      ...(systemPrompt ? { instructions: systemPrompt } : {}),
      input: [{ role: "user", content: userPrompt }],
      store: false,
      stream: options.stream !== false,
      ...(Number.isFinite(maxTokens) && options.includeMaxOutputTokens ? { max_output_tokens: Math.max(64, Math.trunc(maxTokens)) } : {}),
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      ...textField,
    };

    return {
      url,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    };
  },

  parseResponse(rawText) {
    const text = String(rawText || "").trim();
    if (!text) return null;

    if (text.startsWith("{")) {
      const parsed = parseJsonSafe(text);
      if (parsed) {
        if (typeof parsed.output_text === "string" && parsed.output_text.trim()) {
          return stripThinkingTags(parsed.output_text);
        }
        const outItems = Array.isArray(parsed.output) ? parsed.output : [];
        const chunks = [];
        for (const item of outItems) {
          for (const contentPart of Array.isArray(item?.content) ? item.content : []) {
            if (typeof contentPart?.text === "string") chunks.push(contentPart.text);
          }
        }
        if (chunks.length > 0) return stripThinkingTags(chunks.join(""));
        if (typeof parsed.choices?.[0]?.message?.content === "string") {
          return stripThinkingTags(parsed.choices[0].message.content);
        }
      }
    }

    let deltaText = "";
    let completedText = "";
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const event = parseJsonSafe(payload);
      if (!event) continue;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        deltaText += event.delta;
      } else if (event.type === "response.output_text.done" && typeof event.text === "string") {
        completedText = event.text;
      } else if (event.type === "response.completed" && event.response) {
        const resp = event.response;
        if (typeof resp.output_text === "string" && resp.output_text.trim()) {
          completedText = resp.output_text;
        } else if (Array.isArray(resp.output)) {
          const parts = [];
          for (const item of resp.output) {
            for (const c of Array.isArray(item?.content) ? item.content : []) {
              if (typeof c?.text === "string") parts.push(c.text);
            }
          }
          if (parts.length > 0) completedText = parts.join("");
        }
      } else if (event.type === "error" || event.error) {
        const msg = event.error?.message || event.message || "Responses stream error";
        throw new Error(msg);
      }
    }

    const finalOut = stripThinkingTags(deltaText || completedText);
    return finalOut || null;
  },

  isEmptyLengthResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (parsed?.status === "incomplete" && parsed?.incomplete_details?.reason === "max_output_tokens") {
      return !this.parseResponse(rawText);
    }
    const text = String(rawText || "");
    if (text.includes("response.incomplete") && text.includes("max_output_tokens")) {
      return !this.parseResponse(rawText);
    }
    return false;
  },

  describeEmptyResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed) return "";
    const parts = [];
    if (parsed.status) parts.push(`status=${parsed.status}`);
    if (parsed.incomplete_details?.reason) parts.push(`reason=${parsed.incomplete_details.reason}`);
    const reasoning = parsed.usage?.output_tokens_details?.reasoning_tokens;
    if (Number.isFinite(reasoning)) parts.push(`reasoning_tokens=${reasoning}`);
    return parts.join(", ");
  },

  extractUsage(rawText) {
    const parsed = parseJsonSafe(rawText);
    const usage = parsed?.usage;
    if (!usage) return null;
    return {
      inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
      outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
      reasoningTokens: Number.isFinite(usage.output_tokens_details?.reasoning_tokens)
        ? usage.output_tokens_details.reasoning_tokens
        : null,
      totalTokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
    };
  },

  parseCapabilities(payload, model, endpointPath = "/v1/responses") {
    return parseModelReasoningCapabilities(payload, model, endpointPath);
  },

  classifyError(status, body, err) {
    return classifyProviderError(status, body, err);
  },

  async listModels(profile, { signal, fetchImpl, timeoutMs = 15000 } = {}) {
    const endpoint = resolveProfileEndpoint(profile) || "https://api.openai.com/v1";
    const token = String(profile?.accessToken || profile?.apiKey || "").trim();
    const url = appendEndpointPath(endpoint, "/models");
    const authHeaders = token ? { [AUTH_HEADER_KEY]: `Bearer ${token}` } : {};
    const headers = buildMergedHeaders(profile, { accept: "application/json", ...authHeaders });
    const response = await fetchWithSignalAndTimeout(url, { method: "GET", headers }, { fetchImpl, signal, timeoutMs });
    const body = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError({
        status: response.status,
        body,
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
        provider: profile?.provider || "openai-responses",
      });
    }
    const data = parseJsonSafe(body);
    if (Array.isArray(data?.models)) {
      return data.models
        .filter((m) => m && typeof m.slug === "string" && m.visibility !== "hidden")
        .map((m) => ({
          id: m.slug,
          label: m.display_name || m.slug,
          contextLength: Number.isFinite(m.context_window) ? m.context_window : null,
          capabilities: parseModelReasoningCapabilities(data, m.slug, "/v1/responses"),
          raw: m,
        }));
    }
    if (Array.isArray(data?.data)) {
      return data.data
        .filter((m) => m && typeof m.id === "string")
        .map((m) => ({
          id: m.id,
          label: m.id,
          contextLength: Number.isFinite(m.context_length) ? m.context_length : null,
          capabilities: parseModelReasoningCapabilities(data, m.id, "/v1/responses"),
          raw: m,
        }));
    }
    return [];
  },

  streamSSE: streamSSEResponse,
};

// ─── Adapter 3: anthropic-messages ───────────────────────────────────────────

const ANTHROPIC_THINKING_BUDGETS = {
  low: 1024,
  medium: 2048,
  high: 4096,
};

const anthropicMessagesAdapter = {
  kind: "anthropic-messages",

  buildRequest(profile, prompt, maxTokens, options = {}) {
    const preset = getProviderPreset(profile?.provider);
    const endpoint = resolveProfileEndpoint(profile) || "https://api.anthropic.com/v1";
    const model = String(profile?.model || preset?.defaultModel || "claude-sonnet-4-5").trim();
    const apiKey = String(profile?.apiKey || "").trim();
    const apiVersion = String(profile?.apiVersion || preset?.apiVersion || "2023-06-01").trim();
    const { systemPrompt, userPrompt } = normalizePromptParts(prompt, options);

    const effort = options.reasoningEffort;
    const thinkingBudget = effort && ANTHROPIC_THINKING_BUDGETS[effort] ? ANTHROPIC_THINKING_BUDGETS[effort] : null;
    const enableThinking = Boolean(thinkingBudget && /claude-(?:3[.-]7|4|(?:sonnet|opus|haiku)-4)/i.test(stripModelPrefix(model)));
    const requestedTokens = Number.isFinite(maxTokens) ? Math.max(64, Math.trunc(maxTokens)) : 1024;
    const boundedTokens = enableThinking
      ? Math.min(MAX_COMPLETION_TOKENS, Math.max(requestedTokens + thinkingBudget, thinkingBudget + 1024))
      : Math.min(MAX_COMPLETION_TOKENS, requestedTokens);

    const headers = buildMergedHeaders(profile, {
      "content-type": "application/json",
      "anthropic-version": apiVersion,
      ...(apiKey ? { [ANTHROPIC_KEY_HEADER]: apiKey } : {}),
    });

    const body = {
      model,
      max_tokens: boundedTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: "user", content: userPrompt }],
      ...(enableThinking
        ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } }
        : (options.dropTemperature ? {} : { temperature: options.temperature ?? 0.2 })),
    };

    return {
      url: appendEndpointPath(endpoint, "/messages"),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    };
  },

  parseResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed) return null;
    if (!Array.isArray(parsed.content)) return null;
    const textParts = parsed.content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text);
    if (textParts.length === 0) return null;
    const joined = stripThinkingTags(textParts.join(""));
    return joined || null;
  },

  isEmptyLengthResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed || parsed.stop_reason !== "max_tokens") return false;
    return !this.parseResponse(rawText);
  },

  describeEmptyResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed) return "";
    const parts = [];
    if (parsed.stop_reason) parts.push(`stop_reason=${parsed.stop_reason}`);
    if (Number.isFinite(parsed.usage?.output_tokens)) parts.push(`output_tokens=${parsed.usage.output_tokens}`);
    return parts.join(", ");
  },

  extractUsage(rawText) {
    const usage = parseJsonSafe(rawText)?.usage;
    if (!usage) return null;
    const input = Number.isFinite(usage.input_tokens) ? usage.input_tokens : null;
    const output = Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
    return {
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: null,
      totalTokens: input != null && output != null ? input + output : null,
    };
  },

  parseCapabilities(payload, model) {
    return parseModelReasoningCapabilities(payload, model) || inferModelReasoningCapabilities(model);
  },

  classifyError(status, body, err) {
    return classifyProviderError(status, body, err);
  },

  async listModels(profile, { signal, fetchImpl, timeoutMs = 15000 } = {}) {
    const preset = getProviderPreset(profile?.provider);
    const endpoint = resolveProfileEndpoint(profile) || "https://api.anthropic.com/v1";
    const apiKey = String(profile?.apiKey || "").trim();
    const apiVersion = String(profile?.apiVersion || preset?.apiVersion || "2023-06-01").trim();
    const url = appendEndpointPath(endpoint, "/models");
    const headers = buildMergedHeaders(profile, {
      accept: "application/json",
      "anthropic-version": apiVersion,
      ...(apiKey ? { [ANTHROPIC_KEY_HEADER]: apiKey } : {}),
    });
    const response = await fetchWithSignalAndTimeout(url, { method: "GET", headers }, { fetchImpl, signal, timeoutMs });
    const body = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError({
        status: response.status,
        body,
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
        provider: profile?.provider || "anthropic",
      });
    }
    const data = parseJsonSafe(body);
    const list = Array.isArray(data?.data) ? data.data : [];
    return list
      .filter((m) => m && typeof m.id === "string")
      .map((m) => ({
        id: m.id,
        label: m.display_name || m.id,
        contextLength: null,
        capabilities: inferModelReasoningCapabilities(m.id),
        raw: m,
      }));
  },

  streamSSE: streamSSEResponse,
};

// ─── Adapter 4: google-gemini ────────────────────────────────────────────────

const GEMINI_EFFORT_BUDGETS = {
  none: 0,
  minimal: 128,
  low: 1024,
  medium: 4096,
  high: 8192,
};

const googleGeminiAdapter = {
  kind: "google-gemini",

  buildRequest(profile, prompt, maxTokens, options = {}) {
    const preset = getProviderPreset(profile?.provider);
    const baseUrl = (resolveProfileEndpoint(profile) || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const model = normalizeGeminiModelId(profile?.model || preset?.defaultModel || "gemini-2.5-flash");
    const apiKey = String(profile?.apiKey || "").trim();
    const { systemPrompt, userPrompt } = normalizePromptParts(prompt, options);
    const boundedTokens = boundMaxTokens(maxTokens, { reasoningOff: options.reasoningEffort === "none" });

    const generationConfig = {
      maxOutputTokens: boundedTokens,
      ...(options.dropTemperature ? {} : { temperature: options.temperature ?? 0.2 }),
    };

    if (options.jsonSchema && !options.disableJsonSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = sanitizeGeminiSchema(options.jsonSchema);
    } else if (options.jsonMode) {
      generationConfig.responseMimeType = "application/json";
    }

    const isThinkingModel = /gemini-(?:2\.5|3)/i.test(model);
    if (isThinkingModel) {
      if (Object.hasOwn(options, "thinkingBudget")) {
        if (Number.isFinite(options.thinkingBudget)) {
          generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
        }
      } else if (options.reasoningEffort && Object.hasOwn(GEMINI_EFFORT_BUDGETS, options.reasoningEffort)) {
        const isPro25 = /gemini-2\.5-pro/i.test(model);
        const budget = GEMINI_EFFORT_BUDGETS[options.reasoningEffort];
        // Gemini 2.5 Pro rejects thinkingBudget: 0; clamp to its 128 minimum
        // unless caller explicitly overrode thinkingBudget.
        const effectiveBudget = isPro25 && budget === 0 ? 128 : budget;
        generationConfig.thinkingConfig = { thinkingBudget: effectiveBudget };
      }
    }

    // Security: NEVER pass the API key in `?key=` query params — ALWAYS use
    // the `x-goog-api-key` HTTP header so keys stay out of URLs, logs, and history.
    const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const headers = buildMergedHeaders(profile, {
      "content-type": "application/json",
      ...(apiKey ? { [GEMINI_KEY_HEADER]: apiKey } : {}),
    });

    const body = {
      ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig,
    };

    return {
      url,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    };
  },

  parseResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed) return null;
    const parts = parsed.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) return null;
    // Skip Gemini thought parts (`part.thought === true`) when present
    const visible = parts
      .filter((p) => p && typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");
    if (!visible) return null;
    const cleaned = stripThinkingTags(visible);
    return cleaned || null;
  },

  isEmptyLengthResponse(rawText) {
    const candidate = parseJsonSafe(rawText)?.candidates?.[0];
    if (!candidate || candidate.finishReason !== "MAX_TOKENS") return false;
    return !this.parseResponse(rawText);
  },

  describeEmptyResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    const candidate = parsed?.candidates?.[0];
    if (!candidate) return "";
    const parts = [];
    if (candidate.finishReason) parts.push(`finishReason=${candidate.finishReason}`);
    const thoughts = parsed?.usageMetadata?.thoughtsTokenCount;
    if (Number.isFinite(thoughts)) parts.push(`thoughtsTokenCount=${thoughts}`);
    return parts.join(", ");
  },

  extractUsage(rawText) {
    const meta = parseJsonSafe(rawText)?.usageMetadata;
    if (!meta) return null;
    return {
      inputTokens: Number.isFinite(meta.promptTokenCount) ? meta.promptTokenCount : null,
      outputTokens: Number.isFinite(meta.candidatesTokenCount) ? meta.candidatesTokenCount : null,
      reasoningTokens: Number.isFinite(meta.thoughtsTokenCount) ? meta.thoughtsTokenCount : null,
      totalTokens: Number.isFinite(meta.totalTokenCount) ? meta.totalTokenCount : null,
    };
  },

  parseCapabilities(payload, model) {
    return parseModelReasoningCapabilities(payload, model) || inferModelReasoningCapabilities(model);
  },

  classifyError(status, body, err) {
    return classifyProviderError(status, body, err);
  },

  async listModels(profile, { signal, fetchImpl, timeoutMs = 15000 } = {}) {
    const baseUrl = (resolveProfileEndpoint(profile) || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const apiKey = String(profile?.apiKey || "").trim();
    const url = `${baseUrl}/models`;
    const headers = buildMergedHeaders(profile, {
      accept: "application/json",
      ...(apiKey ? { [GEMINI_KEY_HEADER]: apiKey } : {}),
    });
    const response = await fetchWithSignalAndTimeout(url, { method: "GET", headers }, { fetchImpl, signal, timeoutMs });
    const body = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError({
        status: response.status,
        body,
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
        provider: profile?.provider || "gemini",
      });
    }
    const data = parseJsonSafe(body);
    const list = Array.isArray(data?.models) ? data.models : [];
    return list
      .filter((m) => {
        if (!m || typeof m.name !== "string") return false;
        if (Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes("generateContent")) {
          return false;
        }
        return true;
      })
      .map((m) => {
        const id = normalizeGeminiModelId(m.name);
        return {
          id,
          label: m.displayName || id,
          contextLength: Number.isFinite(m.inputTokenLimit) ? m.inputTokenLimit : null,
          capabilities: parseModelReasoningCapabilities(data, id) || inferModelReasoningCapabilities(id),
          raw: m,
        };
      });
  },

  streamSSE: streamSSEResponse,
};

// ─── Adapter 5: ollama-native ────────────────────────────────────────────────

const isOllamaThinkingModel = (model, capabilities) => {
  if (capabilities?.supportsOllamaThinkToggle === true || capabilities?.supported === true) return true;
  const stripped = stripModelPrefix(model).toLowerCase();
  return /^(?:qwen3|qwq|deepseek-r1|gpt-oss|magistral|cogito)(?:[-._:]|$)/.test(stripped);
};

const ollamaNativeAdapter = {
  kind: "ollama-native",

  buildRequest(profile, prompt, maxTokens, options = {}) {
    const host = normalizeHostUrl(resolveProfileEndpoint(profile), CONFIG.AI_OLLAMA_HOST_DEFAULT);
    const model = String(profile?.model || CONFIG.AI_OLLAMA_MODEL_DEFAULT).trim();
    const apiKey = String(profile?.apiKey || "").trim();
    const { systemPrompt, userPrompt } = normalizePromptParts(prompt, options);

    const ollamaOptions = {
      temperature: options.temperature ?? 0,
      seed: options.seed ?? 42,
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      ollamaOptions.num_predict = Math.min(MAX_COMPLETION_TOKENS, Math.max(64, Math.trunc(maxTokens)));
    }
    if (Number.isFinite(options.numCtx) && options.numCtx > 0) {
      ollamaOptions.num_ctx = Math.trunc(options.numCtx);
    }

    const body = {
      model,
      prompt: userPrompt,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      stream: false,
      options: ollamaOptions,
    };

    // Always pass structured format when jsonMode or jsonSchema is requested.
    if (options.jsonSchema && !options.disableJsonSchema) {
      body.format = options.jsonSchema;
    } else if (options.jsonMode) {
      body.format = "json";
    }

    const keepAlive = options.keepAlive === false || profile?.keepAlive === false
      ? null
      : (options.keepAlive ?? profile?.keepAlive ?? "30m");
    if (keepAlive !== null && keepAlive !== "") {
      body.keep_alive = keepAlive;
    }

    // Disable hidden thinking on Ollama thinking models when fast/none reasoning is requested.
    const wantsFast = options.reasoningEffort === "none" || options.reasoningPreference === "fast";
    if (wantsFast && isOllamaThinkingModel(model, options.capabilities)) {
      body.think = false;
    }

    const headers = buildMergedHeaders(profile, {
      "content-type": "application/json",
      ...(apiKey ? { [AUTH_HEADER_KEY]: `Bearer ${apiKey}` } : {}),
    });

    return {
      url: appendEndpointPath(host, "/api/generate"),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    };
  },

  parseResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed) return null;
    const raw = typeof parsed.response === "string"
      ? parsed.response
      : typeof parsed.message?.content === "string"
        ? parsed.message.content
        : null;
    if (raw === null) return null;
    if (!raw.includes("<think") && !raw.includes("<reasoning")) return raw;
    return stripThinkingTags(raw);
  },

  isEmptyLengthResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed || parsed.done_reason !== "length") return false;
    const visible = this.parseResponse(rawText);
    return !visible || !visible.trim();
  },

  describeEmptyResponse(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed) return "";
    const parts = [];
    if (parsed.done_reason) parts.push(`done_reason=${parsed.done_reason}`);
    if (Number.isFinite(parsed.eval_count)) parts.push(`eval_count=${parsed.eval_count}`);
    return parts.join(", ");
  },

  extractUsage(rawText) {
    const parsed = parseJsonSafe(rawText);
    if (!parsed) return null;
    const input = Number.isFinite(parsed.prompt_eval_count) ? parsed.prompt_eval_count : null;
    const output = Number.isFinite(parsed.eval_count) ? parsed.eval_count : null;
    if (input == null && output == null) return null;
    return {
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: null,
      totalTokens: input != null && output != null ? input + output : null,
    };
  },

  parseCapabilities(payload, model) {
    return parseModelReasoningCapabilities(payload, model) || inferModelReasoningCapabilities(model);
  },

  classifyError(status, body, err) {
    return classifyProviderError(status, body, err);
  },

  async listModels(profile, { signal, fetchImpl, timeoutMs = 10000 } = {}) {
    const host = normalizeHostUrl(resolveProfileEndpoint(profile), CONFIG.AI_OLLAMA_HOST_DEFAULT);
    const apiKey = String(profile?.apiKey || "").trim();
    const url = appendEndpointPath(host, "/api/tags");
    const headers = buildMergedHeaders(profile, {
      accept: "application/json",
      ...(apiKey ? { [AUTH_HEADER_KEY]: `Bearer ${apiKey}` } : {}),
    });
    const response = await fetchWithSignalAndTimeout(url, { method: "GET", headers, cache: "no-store" }, { fetchImpl, signal, timeoutMs });
    const body = await response.text();
    if (!response.ok) {
      throw new ProviderHttpError({
        status: response.status,
        body,
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
        provider: "ollama",
        message: response.status === 403
          ? `Ollama rejected request (HTTP 403). Set OLLAMA_ORIGINS="*" (or moz-extension://*,chrome://*) and restart Ollama.`
          : undefined,
      });
    }
    const data = parseJsonSafe(body);
    const list = Array.isArray(data?.models) ? data.models : [];
    return list
      .filter((m) => m && typeof m.name === "string")
      .map((m) => ({
        id: m.name,
        label: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
        contextLength: null,
        capabilities: inferModelReasoningCapabilities(m.name),
        raw: m,
      }));
  },

  streamSSE: streamSSEResponse,
};

// ─── Adapter Registry & Helpers ──────────────────────────────────────────────

export const PROVIDER_ADAPTERS = Object.freeze({
  "openai-chat": openaiChatAdapter,
  "openai-responses": openaiResponsesAdapter,
  "anthropic-messages": anthropicMessagesAdapter,
  "google-gemini": googleGeminiAdapter,
  "ollama-native": ollamaNativeAdapter,
});

const LEGACY_KIND_MAP = Object.freeze({
  openai: "openai-chat",
  primalabs: "openai-chat",
  chatgpt: "openai-responses",
  anthropic: "anthropic-messages",
  gemini: "google-gemini",
  ollama: "ollama-native",
});

export const getAdapterForKind = (kindOrAdapter) => {
  const key = String(kindOrAdapter || "").trim().toLowerCase();
  if (PROVIDER_ADAPTERS[key]) return PROVIDER_ADAPTERS[key];
  const mapped = LEGACY_KIND_MAP[key];
  if (mapped && PROVIDER_ADAPTERS[mapped]) return PROVIDER_ADAPTERS[mapped];
  return null;
};

export const getAdapterForProfile = (profile) => {
  const kind = resolveAdapterKind(profile);
  return PROVIDER_ADAPTERS[kind] || openaiChatAdapter;
};
