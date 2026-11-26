// Zen Tab Sorting — Ollama HTTP transport layer.
//
// Everything that talks to the Ollama daemon over HTTP lives here: timeouts,
// external AbortSignal wiring, ping/health-check (exact tag matching), warmup,
// streaming `POST /api/pull`, HTTP 403 OLLAMA_ORIGINS diagnostics, and the
// JSON generate-call wrapper delegating formatting through `ollama-native`.

import { CONFIG, LOG } from "./config.mjs";
import { getAdapterForKind, stripThinkingTags } from "./provider-adapters.mjs";
import { isOllamaWarmupEnabled } from "./rules.mjs";
import { showToast } from "./ui-toast.mjs";

const PING_TIMEOUT_MS = 3000;
const GENERATE_TIMEOUT_MS = 180000;
const WARMUP_TIMEOUT_MS = 30000;
const PULL_TIMEOUT_MS = 600000;

export const OLLAMA_ORIGINS_HINT =
  'HTTP 403 Forbidden from Ollama. Set OLLAMA_ORIGINS="*" (or moz-extension://*,chrome://*) and restart Ollama.';

const withKeepAlive = () =>
  isOllamaWarmupEnabled() ? { keepAlive: "30m" } : {};

// Normalize a user-entered host. Tolerates trailing slashes and missing scheme
// so settings like "localhost:11434" or "http://192.168.1.5:11434/" both work.
export const normalizeOllamaHost = (host) => {
  let h = (host || "").trim();
  if (!h) h = CONFIG.AI_OLLAMA_HOST_DEFAULT;
  if (!/^https?:\/\//i.test(h)) h = "http://" + h;
  return h.replace(/\/+$/, "");
};

/**
 * AbortController-backed fetch with both timeout AND optional caller `signal`.
 * Accepts either `(url, opts, timeoutMs)` or `(url, opts, { timeoutMs, signal, fetchImpl })`.
 */
export const ollamaFetch = async (url, opts = {}, timeoutOrOptions = PING_TIMEOUT_MS) => {
  const options = typeof timeoutOrOptions === "number"
    ? { timeoutMs: timeoutOrOptions }
    : (timeoutOrOptions || {});
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : PING_TIMEOUT_MS;
  const externalSignal = options.signal || opts.signal || null;
  const doFetch = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;

  if (externalSignal?.aborted) {
    const abortErr = new Error("Request aborted");
    abortErr.name = "AbortError";
    abortErr.isUserAbort = true;
    throw abortErr;
  }

  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(100, Math.round(timeoutMs)));

  try {
    return await doFetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      const timeoutErr = new Error(`timeout after ${Math.round(timeoutMs)}ms`);
      timeoutErr.name = "AbortError";
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    if (externalSignal?.aborted) {
      err.isUserAbort = true;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.("abort", onExternalAbort);
  }
};

// GET /api/tags — Ollama's "list models" endpoint. Cheap, no model load.
const pingOllama = async (host, { signal = null, fetchImpl = null, timeoutMs = PING_TIMEOUT_MS } = {}) => {
  const base = normalizeOllamaHost(host);
  try {
    const res = await ollamaFetch(`${base}/api/tags`, { cache: "no-store" }, { timeoutMs, signal, fetchImpl });
    if (!res.ok) {
      if (res.status === 403) {
        return { ok: false, status: 403, errorType: "forbidden", error: OLLAMA_ORIGINS_HINT };
      }
      return { ok: false, status: res.status, errorType: "http", error: `HTTP ${res.status}` };
    }
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, errorType: "parse", error: "Ollama /api/tags returned invalid JSON" };
    }
    const models = Array.isArray(data?.models) ? data.models : [];
    return { ok: true, models };
  } catch (e) {
    if (e?.isUserAbort) {
      return { ok: false, errorType: "abort", error: "aborted" };
    }
    return {
      ok: false,
      errorType: e?.isTimeout ? "timeout" : "network",
      error: e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (e.message || String(e)),
    };
  }
};

/**
 * Two-stage check: is the daemon reachable, AND is the chosen model pulled?
 *
 * Match strategy:
 *   - When `model` contains an explicit tag (e.g. "qwen2.5:7b"), require an
 *     exact match (`n === target`) so "qwen2.5:1.5b" never false-positives for
 *     "qwen2.5:7b".
 *   - Family match (`n.startsWith(target + ":")`) is ONLY applied when the
 *     configured model has NO tag (`!target.includes(":")`), e.g. "qwen2.5".
 */
export const checkOllamaReady = async (host, model, options = {}) => {
  const ping = await pingOllama(host, options);
  if (!ping.ok) {
    return {
      reachable: false,
      modelAvailable: false,
      error: ping.error,
      ...(ping.errorType ? { errorType: ping.errorType } : {}),
      ...(ping.status ? { status: ping.status } : {}),
    };
  }
  const target = (model || "").trim().toLowerCase();
  const hasExplicitTag = target.includes(":");
  const have = ping.models.map((m) => String(m?.name || "").toLowerCase());
  const found = Boolean(target) && have.some(
    (n) => n === target || (!hasExplicitTag && n.startsWith(`${target}:`)),
  );
  return { reachable: true, modelAvailable: found, availableModels: have };
};

/**
 * POST /api/generate via `ollama-native` adapter with `format: schema || "json"`,
 * deterministic `options: { temperature: 0, seed: 42 }`, `keep_alive`, and
 * `think: false` for fast reasoning on thinking models.
 *
 * Result shape:
 *   { ok: true,  parsed }
 *   { ok: false, error, errorType: "network"|"timeout"|"abort"|"http"|"forbidden"|"empty"|"parse", status? }
 */
export const ollamaGenerateJson = async (host, model, prompt, options = {}) => {
  const base = normalizeOllamaHost(host);
  const adapter = getAdapterForKind("ollama-native");
  const req = adapter.buildRequest(
    { provider: "ollama", endpoint: base, model },
    prompt,
    options.numPredict ?? options.maxTokens,
    {
      jsonMode: true,
      jsonSchema: options.jsonSchema || null,
      numCtx: options.numCtx,
      reasoningPreference: options.reasoningPreference || "fast",
      reasoningEffort: options.reasoningEffort,
      capabilities: options.capabilities,
      ...withKeepAlive(),
      ...(options.keepAlive !== undefined ? { keepAlive: options.keepAlive } : {}),
    },
  );

  let res;
  try {
    res = await ollamaFetch(req.url, req.init, {
      timeoutMs: options.timeoutMs ?? GENERATE_TIMEOUT_MS,
      signal: options.signal || null,
      fetchImpl: options.fetchImpl || null,
    });
  } catch (e) {
    if (e?.isUserAbort) {
      return { ok: false, errorType: "abort", error: "Request aborted" };
    }
    return {
      ok: false,
      errorType: e?.isTimeout ? "timeout" : "network",
      error: e.name === "AbortError" ? `timeout after ${options.timeoutMs ?? GENERATE_TIMEOUT_MS}ms` : (e.message || String(e)),
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403) {
      return {
        ok: false,
        status: 403,
        errorType: "forbidden",
        error: OLLAMA_ORIGINS_HINT,
      };
    }
    return { ok: false, status: res.status, errorType: "http", error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, errorType: "parse", error: "Ollama returned non-JSON envelope" };
  }

  const rawText = typeof data?.response === "string"
    ? data.response
    : typeof data?.message?.content === "string"
      ? data.message.content
      : "";
  const text = stripThinkingTags(rawText).trim();
  if (!text) {
    return { ok: false, errorType: "empty", error: "Ollama returned empty response" };
  }
  try {
    return { ok: true, parsed: JSON.parse(text) };
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return { ok: true, parsed: JSON.parse(text.slice(firstBrace, lastBrace + 1)) };
      } catch {}
    }
    return { ok: false, errorType: "parse", error: `Invalid JSON: ${text.slice(0, 200)}` };
  }
};

/**
 * Stream `POST /api/pull` to download a missing Ollama model with live progress
 * callbacks (`onProgress({ status, digest, completed, total, percent })`).
 */
export const pullOllamaModel = async (
  host,
  model,
  { signal = null, onProgress = null, fetchImpl = null, timeoutMs = PULL_TIMEOUT_MS } = {},
) => {
  const target = String(model || "").trim();
  if (!target) return { ok: false, errorType: "bad_request", error: "Model name is required" };
  const base = normalizeOllamaHost(host);

  let res;
  try {
    res = await ollamaFetch(
      `${base}/api/pull`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: target, stream: true }),
      },
      { timeoutMs, signal, fetchImpl },
    );
  } catch (e) {
    if (e?.isUserAbort) {
      return { ok: false, errorType: "abort", error: "Model pull aborted" };
    }
    return {
      ok: false,
      errorType: e?.isTimeout ? "timeout" : "network",
      error: e.message || String(e),
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 403) {
      return { ok: false, status: 403, errorType: "forbidden", error: OLLAMA_ORIGINS_HINT };
    }
    return { ok: false, status: res.status, errorType: "http", error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  let lastStatus = "";
  let streamError = null;

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (evt.error) {
      streamError = String(evt.error);
      return;
    }
    if (evt.status) lastStatus = String(evt.status);
    const completed = Number.isFinite(evt.completed) ? evt.completed : null;
    const total = Number.isFinite(evt.total) && evt.total > 0 ? evt.total : null;
    const percent = completed != null && total != null
      ? Math.min(100, Math.round((completed / total) * 100))
      : null;
    onProgress?.({
      status: lastStatus,
      digest: evt.digest || "",
      completed,
      total,
      percent,
    });
  };

  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      while (true) {
        if (signal?.aborted) {
          try { await reader.cancel(); } catch {}
          return { ok: false, errorType: "abort", error: "Model pull aborted" };
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += typeof value === "string" ? value : decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
        if (streamError) {
          try { await reader.cancel(); } catch {}
          return { ok: false, errorType: "http", error: streamError };
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
  } else {
    const raw = await res.text().catch(() => "");
    for (const line of raw.split(/\r?\n/)) processLine(line);
  }

  if (streamError) {
    return { ok: false, errorType: "http", error: streamError };
  }
  return { ok: true, model: target, status: lastStatus || "success" };
};

// Preload a model into VRAM without generating any output. Fire-and-forget at
// browser startup so the first tidy click doesn't pay the cold-start cost.
export const warmupOllama = async (host, model, { signal = null, fetchImpl = null } = {}) => {
  const base = normalizeOllamaHost(host);
  const t0 = performance.now();
  try {
    const keepAliveObj = isOllamaWarmupEnabled() ? { keep_alive: "30m" } : {};
    const res = await ollamaFetch(
      `${base}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: "",
          stream: false,
          ...keepAliveObj,
        }),
      },
      { timeoutMs: WARMUP_TIMEOUT_MS, signal, fetchImpl },
    );
    if (res.ok) {
      console.log(`${LOG} Ollama: warmed up "${model}" on ${base} in ${Math.round(performance.now() - t0)}ms`);
    } else if (res.status === 403) {
      console.warn(`${LOG} Ollama warmup blocked: ${OLLAMA_ORIGINS_HINT}`);
    } else {
      console.log(`${LOG} Ollama warmup non-OK (HTTP ${res.status}) — first click will cold-start`);
    }
  } catch (e) {
    console.log(`${LOG} Ollama warmup skipped (${e?.isUserAbort ? "aborted" : e.name === "AbortError" ? "timeout" : "unreachable"})`);
  }
};

// User-facing error surfacing — toast + console.warn. Pass the result of
// checkOllamaReady. No-op when the status is fully healthy.
export const reportOllamaError = (host, model, status) => {
  const base = normalizeOllamaHost(host);
  if (!status.reachable) {
    const msg = status.status === 403 || status.errorType === "forbidden"
      ? `Ollama at ${base} blocked the browser origin. ${OLLAMA_ORIGINS_HINT}`
      : `Ollama not reachable at ${base} (${status.error || "unknown error"})`;
    console.warn(`${LOG} ${msg}`);
    showToast(msg);
    return;
  }
  if (!status.modelAvailable) {
    const have = (status.availableModels || []).join(", ") || "(no models pulled)";
    const msg = `Ollama running at ${base}, but model "${model}" not found. Run: ollama pull ${model}`;
    console.warn(`${LOG} ${msg} — installed models: ${have}`);
    showToast(msg);
  }
};
