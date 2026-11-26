import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../modules/config.mjs";
import {
  getCachedSecret,
  getSecret,
  hydrateSecrets,
  migratePrefSecrets,
  resetSecretStoreForTests,
  setSecret,
  setSecretStoreBackend,
  deleteSecret,
} from "../modules/secret-store.mjs";
import {
  ERROR_CATEGORIES,
  ProviderHttpError,
  classifyProviderError,
  parseRetryAfterMs,
  withTransientRetry,
} from "../modules/provider-errors.mjs";
import {
  ADAPTER_KINDS,
  PROVIDER_PRESETS,
  getProviderPreset,
  isLoopbackHost,
  listProviderPresets,
  requiresApiKeyForProfile,
  requiresConsentForProfile,
} from "../modules/provider-registry.mjs";
import {
  PROVIDER_ADAPTERS,
  getAdapterForKind,
  streamSSEResponse,
  stripThinkingTags,
} from "../modules/provider-adapters.mjs";
import {
  buildEffortCacheKey,
  buildModelCacheKey,
  clearProviderModelCache,
  getFavoriteModels,
  getRecentModels,
  listProviderModels,
  recordRecentModel,
  resetModelPreferencesForTests,
  toggleFavoriteModel,
} from "../modules/provider-models.mjs";
import {
  inferModelReasoningCapabilities,
  isReasoningParamError,
  nextReasoningRecoveryStep,
  parseModelReasoningCapabilities,
  resolveCapabilitiesForModel,
  stripModelPrefix,
} from "../modules/reasoning.mjs";
import {
  getFallbackChain,
  getTaskProfile,
  listProviderProfiles,
  readProviderSettingsForName,
  setFallbackChain,
  setTaskProfile,
  upsertProviderProfile,
} from "../modules/provider-settings.mjs";
import { getProviderReadiness } from "../modules/provider-readiness.mjs";
import {
  buildProviderRequest,
  guessParamStyle,
  isEmptyLengthResponse,
  PARAM_STYLE_MODERN,
} from "../modules/provider-requests.mjs";
import {
  chunkTabs,
  chunkTabsByBudget,
  estimateTabTokens,
} from "../modules/provider-batching.mjs";
import {
  _setPendingSignInStateForTests,
  completeChatGPTSignInFromCallbackUrl,
  decodeJwtClaims,
  fetchChatGPTModels,
  forceRefreshChatGPTToken,
} from "../modules/chatgpt-auth.mjs";
import {
  checkOllamaReady,
  ollamaGenerateJson,
  pullOllamaModel,
} from "../modules/ollama-transport.mjs";
import { collectProviderTabMap } from "../modules/remote-assignment-retry.mjs";

const makePrefs = (initial = {}) => {
  const store = new Map(Object.entries(initial));
  return {
    store,
    PREF_STRING: "string",
    PREF_BOOL: "bool",
    prefHasUserValue: (name) => store.has(name),
    getPrefType: (name) => (typeof store.get(name) === "boolean" ? "bool" : "string"),
    getStringPref: (name, fallback = "") => (store.has(name) ? String(store.get(name)) : fallback),
    getBoolPref: (name, fallback = false) => (store.has(name) ? Boolean(store.get(name)) : fallback),
    setStringPref: (name, val) => store.set(name, String(val)),
    setBoolPref: (name, val) => store.set(name, Boolean(val)),
    clearUserPref: (name) => store.delete(name),
  };
};

// ─── 1. Secret Store ─────────────────────────────────────────────────────────

test("secret-store stores, hydrates, deletes, and migrates plaintext prefs cleanly with mock backend", async () => {
  resetSecretStoreForTests();
  const vault = new Map();
  setSecretStoreBackend({
    async get(k) { return vault.get(k) || ""; },
    async set(k, v) { vault.set(k, v); },
    async delete(k) { vault.delete(k); },
    async list() { return [...vault.keys()]; },
  });

  const prefs = makePrefs({
    [CONFIG.AI_OPENAI_API_KEY_PREF]: "test-openai-secret",
    [CONFIG.AI_GEMINI_API_KEY_PREF]: "test-gemini-secret",
  });

  const migration = await migratePrefSecrets({ prefs });
  assert.ok(migration.migrated.includes("openai"));
  assert.ok(migration.migrated.includes("gemini"));
  assert.equal(prefs.store.has(CONFIG.AI_OPENAI_API_KEY_PREF), false);
  assert.equal(prefs.store.has(CONFIG.AI_GEMINI_API_KEY_PREF), false);
  assert.equal(getCachedSecret("openai"), "test-openai-secret");
  assert.equal(await getSecret("gemini"), "test-gemini-secret");

  await setSecret("anthropic", "test-anthropic-key");
  await hydrateSecrets({ prefs, migrate: false });
  assert.equal(getCachedSecret("anthropic"), "test-anthropic-key");

  await deleteSecret("anthropic");
  assert.equal(getCachedSecret("anthropic"), "");
  resetSecretStoreForTests();
});

// ─── 2. Provider Errors & Transient Retry ────────────────────────────────────

test("provider-errors classifies all 9 categories, parses Retry-After, and never retries fatal errors", async () => {
  assert.equal(parseRetryAfterMs("2.5"), 2500);
  assert.equal(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")), 10000);
  assert.equal(parseRetryAfterMs("invalid"), null);

  assert.equal(classifyProviderError(401, ""), ERROR_CATEGORIES.AUTH);
  assert.equal(classifyProviderError(402, ""), ERROR_CATEGORIES.QUOTA);
  assert.equal(classifyProviderError(429, "Rate limit exceeded"), ERROR_CATEGORIES.RATE_LIMIT);
  assert.equal(classifyProviderError(429, "insufficient_quota"), ERROR_CATEGORIES.QUOTA);
  assert.equal(classifyProviderError(503, "overloaded"), ERROR_CATEGORIES.TRANSIENT);
  assert.equal(classifyProviderError(400, "bad input"), ERROR_CATEGORIES.BAD_REQUEST);
  assert.equal(classifyProviderError(404, "missing model"), ERROR_CATEGORIES.NOT_FOUND);
  assert.equal(classifyProviderError(0, "", Object.assign(new Error("aborted"), { name: "AbortError" })), ERROR_CATEGORIES.ABORT);
  assert.equal(classifyProviderError(0, "", new Error("request timeout")), ERROR_CATEGORIES.TIMEOUT);

  // 0 retries on auth/quota/not_found/bad_request
  for (const status of [401, 402, 404, 400]) {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(async () => {
        calls += 1;
        throw new ProviderHttpError({ status, body: "nope" });
      }, { maxAttempts: 3, sleepImpl: async () => {} }),
    );
    assert.equal(calls, 1, `HTTP ${status} must have 0 retries`);
  }

  // Retries transient 503 with Retry-After and succeeds
  let transientCalls = 0;
  const delays = [];
  const val = await withTransientRetry(async () => {
    transientCalls += 1;
    if (transientCalls < 3) {
      throw new ProviderHttpError({ status: 503, body: "try again", retryAfterMs: 120 });
    }
    return "recovered";
  }, {
    maxAttempts: 3,
    sleepImpl: async (ms) => { delays.push(ms); },
  });
  assert.equal(val, "recovered");
  assert.equal(transientCalls, 3);
  assert.deepEqual(delays, [120, 120]);
});

// ─── 3. Provider Registry & Readiness ────────────────────────────────────────

test("provider-registry defines 18 presets across 5 adapters and enforces loopback consent rules", () => {
  assert.equal(PROVIDER_PRESETS.length, 18);
  assert.equal(ADAPTER_KINDS.length, 5);
  assert.equal(listProviderPresets({ category: "local" }).length, 4);
  assert.equal(getProviderPreset("openrouter").defaultHeaders["HTTP-Referer"], "https://github.com/LoopRook/Zen-Tab-Sorting");
  assert.equal(getProviderPreset("perplexity").jsonMode, false);

  assert.equal(isLoopbackHost("http://localhost:11434"), true);
  assert.equal(isLoopbackHost("http://127.0.0.1:1234/v1"), true);
  assert.equal(isLoopbackHost("http://[::1]:8080/v1"), true);
  assert.equal(isLoopbackHost("http://localhost.evil.com:11434"), false);
  assert.equal(isLoopbackHost("http://192.168.1.50:11434"), false);

  // Remote Ollama requires consent; local LM Studio / vLLM / llama.cpp waive consent & key!
  assert.equal(requiresConsentForProfile({ provider: "ollama", endpoint: "http://192.168.1.50:11434" }), true);
  assert.equal(requiresConsentForProfile({ provider: "ollama", endpoint: "http://localhost:11434" }), false);
  assert.equal(requiresConsentForProfile({ provider: "lmstudio" }), false);
  assert.equal(requiresApiKeyForProfile({ provider: "lmstudio" }), false);
  assert.equal(requiresApiKeyForProfile({ provider: "vllm" }), false);
  assert.equal(requiresApiKeyForProfile({ provider: "anthropic" }), true);

  assert.deepEqual(
    getProviderReadiness({ provider: "ollama", endpoint: "http://192.168.1.50:11434", model: "qwen2.5:7b", consentToSendData: false }),
    { ok: false, reason: "consent_required" },
  );
  assert.equal(
    getProviderReadiness({ provider: "lmstudio", model: "local-model", consentToSendData: false }).ok,
    true,
  );
  assert.deepEqual(
    getProviderReadiness({ provider: "none", consentToSendData: false }),
    { ok: false, reason: "provider_disabled" },
  );
});

// ─── 4. Protocol Adapters ────────────────────────────────────────────────────

test("provider-adapters enforce x-goog-api-key header, empty-key omission, thinking strip, and generalized empty-length detection", async () => {
  assert.equal(Object.keys(PROVIDER_ADAPTERS).length, 5);

  // Gemini uses x-goog-api-key header, NEVER ?key= query string!
  const gemReq = buildProviderRequest(
    { provider: "gemini", apiKey: "test-gem-key", model: "gemini-2.5-flash" },
    { system: "System rules", user: "Sort tabs" },
    500,
    undefined,
    { jsonMode: true, reasoningEffort: "none" },
  );
  assert.equal(gemReq.url.includes("key="), false, "Gemini URL must never contain ?key=");
  assert.equal(gemReq.init.headers["x-goog-api-key"], "test-gem-key");
  const gemBody = JSON.parse(gemReq.init.body);
  assert.equal(gemBody.systemInstruction.parts[0].text, "System rules");

  // Local OpenAI-compat omits authorization header when apiKey is empty
  const lmReq = buildProviderRequest(
    { provider: "lmstudio", apiKey: "", model: "qwen2.5" },
    "Sort tabs",
    500,
  );
  assert.equal("authorization" in lmReq.init.headers, false);

  // Perplexity respects jsonMode: false
  const pplxReq = buildProviderRequest(
    { provider: "perplexity", apiKey: "test-key", model: "sonar" },
    "Sort tabs",
    500,
    undefined,
    { jsonMode: true },
  );
  assert.equal("response_format" in JSON.parse(pplxReq.init.body), false);

  // Anthropic systemPrompt + messages + x-api-key
  const anthReq = buildProviderRequest(
    { provider: "anthropic", apiKey: "test-anth-key", model: "claude-sonnet-4-5" },
    { system: "Be concise", user: "Group these" },
    600,
  );
  assert.equal(anthReq.init.headers["x-api-key"], "test-anth-key");
  assert.equal(JSON.parse(anthReq.init.body).system, "Be concise");

  // Ollama-native passes format, keep_alive, deterministic options, and think: false on thinking models
  const ollamaReq = buildProviderRequest(
    { provider: "ollama", endpoint: "localhost:11434/", model: "qwen3:8b" },
    "Sort",
    400,
    undefined,
    { jsonMode: true, reasoningPreference: "fast" },
  );
  assert.equal(ollamaReq.url, "http://localhost:11434/api/generate");
  const ollamaBody = JSON.parse(ollamaReq.init.body);
  assert.equal(ollamaBody.format, "json");
  assert.equal(ollamaBody.keep_alive, "30m");
  assert.equal(ollamaBody.options.temperature, 0);
  assert.equal(ollamaBody.options.seed, 42);
  assert.equal(ollamaBody.think, false);

  // Strip <think> blocks cleanly
  assert.equal(stripThinkingTags("<think>hidden plan</think>{\"0\":\"Dev\"}"), '{"0":"Dev"}');

  // Generalized isEmptyLengthResponse across all 4 families
  assert.equal(isEmptyLengthResponse("openai", JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }] })), true);
  assert.equal(isEmptyLengthResponse("gemini", JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] })), true);
  assert.equal(isEmptyLengthResponse("anthropic", JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "thinking", thinking: "..." }] })), true);
  assert.equal(isEmptyLengthResponse("ollama", JSON.stringify({ done_reason: "length", response: "<think>cut off" })), true);

  // Incremental SSE stream reader
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('data: {"type":"response.output_text.delta","delta":"{\\"0\\":"}\n\n'),
    encoder.encode('data: {"type":"response.output_text.delta","delta":"\\"Dev\\"}"}\n\n'),
  ];
  let idx = 0;
  const deltas = [];
  const raw = await streamSSEResponse({
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: {
      getReader: () => ({
        async read() { return idx < chunks.length ? { done: false, value: chunks[idx++] } : { done: true }; },
        releaseLock() {},
      }),
    },
  }, { onDelta: (d) => deltas.push(d) });
  assert.equal(deltas.join(""), '{"0":"Dev"}');
  assert.equal(getAdapterForKind("openai-responses").parseResponse(raw), '{"0":"Dev"}');
});

// ─── 5. Model Discovery, Recents, Favorites & Cache Keys ─────────────────────

test("provider-models caches models with collision-free keys, negative TTL, recents, and favorites", async () => {
  resetModelPreferencesForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ data: [{ id: "openai/gpt-5-mini", supported_parameters: ["reasoning", "structured_outputs"] }] });
  };
  const profile = { provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", apiKey: "test-key", model: "openai/gpt-5-mini" };

  const first = await listProviderModels(profile, { fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(first.fromCache, false);
  assert.equal(first.models.length, 1);
  assert.equal(first.models[0].capabilities.supported, true);

  const second = await listProviderModels(profile, { fetchImpl });
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1);

  assert.notEqual(
    buildModelCacheKey({ provider: "openai", endpoint: "https://a.test", model: "m" }),
    buildModelCacheKey({ provider: "openrouter", endpoint: "https://a.test", model: "m" }),
  );
  assert.notEqual(
    buildEffortCacheKey(profile, "fast"),
    buildEffortCacheKey(profile, "high"),
  );

  const prefs = makePrefs();
  recordRecentModel({ provider: "openrouter", model: "openai/gpt-5-mini" }, prefs);
  assert.equal(getRecentModels(prefs).length, 1);
  const fav = toggleFavoriteModel({ provider: "openrouter", model: "openai/gpt-5-mini" }, prefs);
  assert.equal(fav.favorited, true);
  assert.equal(getFavoriteModels(prefs).length, 1);
  clearProviderModelCache();
});

// ─── 6. Reasoning 4-Tier Capabilities & 400/422 Recovery Ladder ──────────────

test("reasoning supports prefix-stripped heuristics, multi-catalog parsing, and 400/422 recovery ladders", () => {
  assert.equal(stripModelPrefix("openai/gpt-5-mini"), "gpt-5-mini");
  assert.equal(guessParamStyle("openai/gpt-5-mini"), PARAM_STYLE_MODERN);
  assert.equal(guessParamStyle("x-ai/o4-mini"), PARAM_STYLE_MODERN);

  assert.equal(inferModelReasoningCapabilities("openai/gpt-6-mini").supported, true);
  assert.equal(inferModelReasoningCapabilities("deepseek/deepseek-r1").thinksInTags, true);
  assert.equal(inferModelReasoningCapabilities("gemini-2.5-pro").minThinkingBudget, 128);

  const ollamaShow = parseModelReasoningCapabilities({ capabilities: ["completion", "thinking"] }, "qwen3:8b");
  assert.equal(ollamaShow.supported, true);

  const resolved = resolveCapabilitiesForModel({ model: "openai/o3-mini" });
  assert.deepEqual(resolved.accepted, ["low", "medium", "high"]);

  assert.equal(isReasoningParamError(422, "Invalid value for reasoning_effort"), true);

  // Generalized effort ladder: none -> minimal -> low -> null
  const s1 = nextReasoningRecoveryStep({ adapter: "openai-chat", status: 422, body: "Unsupported reasoning_effort 'none'", currentState: { effort: "none" } });
  assert.equal(s1.nextState.effort, "minimal");
  const s2 = nextReasoningRecoveryStep({ adapter: "openai-chat", status: 400, body: "Unsupported reasoning_effort 'minimal'", currentState: s1.nextState });
  assert.equal(s2.nextState.effort, "low");
  const s3 = nextReasoningRecoveryStep({ adapter: "openai-chat", status: 400, body: "Unsupported reasoning_effort 'low'", currentState: s2.nextState });
  assert.equal(s3.nextState.effort, null);

  // Gemini 2.5 Pro thinkingBudget ladder: 0 -> 128 -> null
  const g1 = nextReasoningRecoveryStep({ adapter: "google-gemini", status: 400, body: "Budget 0 is invalid for thinkingConfig", currentState: { thinkingBudget: 0, effort: "none" } });
  assert.equal(g1.nextState.thinkingBudget, 128);
  const g2 = nextReasoningRecoveryStep({ adapter: "google-gemini", status: 400, body: "thinkingBudget unsupported", currentState: g1.nextState });
  assert.equal(g2.nextState.thinkingBudget, null);
});

// ─── 7. Provider Settings Profiles, Fallback Chain & Task Profiles ───────────

test("provider-settings supports structured profiles, fallback chains, and per-task profiles", () => {
  const prefs = makePrefs({
    [CONFIG.AI_FALLBACK_PROVIDER_PREF]: "openai",
    [CONFIG.AI_OPENAI_ENDPOINT_PREF]: "https://api.openai.com/v1",
    [CONFIG.AI_OPENAI_MODEL_PREF]: "gpt-4.1-mini",
    [CONFIG.AI_PROVIDER_CONSENT_PREF]: true,
  });

  upsertProviderProfile(prefs, { id: "work-claude", provider: "anthropic", model: "claude-sonnet-4-5" });
  assert.ok(listProviderProfiles(prefs).some((p) => p.id === "work-claude"));
  assert.equal(readProviderSettingsForName(prefs, "work-claude").provider, "anthropic");

  setFallbackChain(prefs, ["work-claude", "ollama"]);
  const chain = getFallbackChain(prefs);
  assert.deepEqual(chain.map((c) => c.provider), ["anthropic", "ollama"]);

  setTaskProfile("deep", { profileId: "work-claude", reasoningPreference: "high" }, prefs);
  assert.equal(getTaskProfile("deep", prefs).provider, "anthropic");
  assert.equal(getTaskProfile("deep", prefs).reasoningPreference, "high");
  assert.equal(getTaskProfile("offline", prefs).provider, "ollama");
});

// ─── 8. Token-Aware Batching ─────────────────────────────────────────────────

test("provider-batching estimates tokens and chunks tabs within input token budget", () => {
  assert.equal(typeof chunkTabs, "function");
  const tabs = Array.from({ length: 10 }, (_, i) => ({
    hostname: `site-${i}.example.com`,
    title: "Long title ".repeat(20),
  }));
  assert.ok(estimateTabTokens(tabs[0]) > 50);
  const chunks = chunkTabsByBudget(tabs, { maxTabs: 10, maxInputTokens: 450, overheadTokens: 100 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.reduce((sum, c) => sum + c.tabs.length, 0), 10);
});

// ─── 9. ChatGPT Auth Hardening ───────────────────────────────────────────────

test("chatgpt-auth enforces strict CSRF state, OIDC nonce, UTF-8 JWT decode, error propagation, and forceRefresh", async () => {
  // UTF-8 safe JWT decode (German umlauts + emoji)
  const payloadJson = JSON.stringify({ email: "müller@example.test", name: "Jürgen ✨", nonce: "n-123" });
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const fakeJwt = `eyJhbGciOiJub25lIn0.${payloadB64}.sig`;
  const claims = decodeJwtClaims(fakeJwt);
  assert.equal(claims.email, "müller@example.test");
  assert.equal(claims.name, "Jürgen ✨");

  // Missing state MUST reject (fixes CSRF bypass!)
  _setPendingSignInStateForTests({
    state: "expected-state",
    nonce: "expected-nonce",
    codeVerifier: "ver",
    redirectUri: "http://127.0.0.1:14555/auth/callback",
    clientId: "oaiapp_1",
  });
  await assert.rejects(
    completeChatGPTSignInFromCallbackUrl("http://127.0.0.1:14555/auth/callback?code=abc&client_id=oaiapp_1"),
    /OAuth state mismatch/,
  );

  // Wrong nonce in id_token MUST reject
  await assert.rejects(
    completeChatGPTSignInFromCallbackUrl(
      "http://127.0.0.1:14555/auth/callback?code=abc&state=expected-state&client_id=oaiapp_1",
      makePrefs(),
      async () => Response.json({ access_token: "at", refresh_token: "rt", id_token: fakeJwt }),
    ),
    /OAuth nonce mismatch/,
  );
  _setPendingSignInStateForTests(null);

  // fetchChatGPTModels propagates HTTP errors instead of swallowing as []
  await assert.rejects(
    fetchChatGPTModels("at_expired", async () => new Response("unauthorized", { status: 401 })),
    (err) => err instanceof ProviderHttpError && err.status === 401,
  );

  // forceRefreshChatGPTToken refreshes even when access token is not expired
  const prefs = makePrefs({
    [CONFIG.AI_CHATGPT_SESSION_PREF]: JSON.stringify({
      clientId: "oaiapp_force",
      accessToken: "still-fresh-but-401",
      refreshToken: "rt_1",
      expiresAt: Date.now() + 3600_000,
    }),
  });
  const rotated = await forceRefreshChatGPTToken(prefs, async () =>
    Response.json({ access_token: "new_after_401", refresh_token: "rt_2", expires_in: 3600 }),
  );
  assert.equal(rotated, "new_after_401");
});

// ─── 10. Ollama Transport Fixes ──────────────────────────────────────────────

test("ollama-transport fixes tag matching, wraps JSON parse errors, surfaces 403 OLLAMA_ORIGINS, and streams /api/pull", async () => {
  // Exact tag mismatch: qwen2.5:1.5b must NOT satisfy qwen2.5:7b
  const tagMismatch = await checkOllamaReady("http://localhost:11434", "qwen2.5:7b", {
    fetchImpl: async () => Response.json({ models: [{ name: "qwen2.5:1.5b" }] }),
  });
  assert.equal(tagMismatch.reachable, true);
  assert.equal(tagMismatch.modelAvailable, false);

  // Tagless family match still works when user asks for "qwen2.5"
  const familyMatch = await checkOllamaReady("http://localhost:11434", "qwen2.5", {
    fetchImpl: async () => Response.json({ models: [{ name: "qwen2.5:1.5b" }] }),
  });
  assert.equal(familyMatch.modelAvailable, true);

  // HTTP 403 gives OLLAMA_ORIGINS hint
  const forbidden = await ollamaGenerateJson("http://localhost:11434", "qwen2.5:1.5b", "sort", {
    fetchImpl: async () => new Response("Forbidden", { status: 403 }),
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.error, /OLLAMA_ORIGINS/);

  // Non-JSON 200 envelope returns parse error instead of throwing
  const badJson = await ollamaGenerateJson("http://localhost:11434", "qwen2.5:1.5b", "sort", {
    fetchImpl: async () => new Response("<html>proxy error</html>", { status: 200 }),
  });
  assert.equal(badJson.ok, false);
  assert.equal(badJson.errorType, "parse");

  // Streaming pullOllamaModel
  const progressEvents = [];
  const pullRes = await pullOllamaModel("http://localhost:11434", "qwen2.5:1.5b", {
    onProgress: (p) => progressEvents.push(p),
    fetchImpl: async () => new Response(
      '{"status":"pulling manifest"}\n{"status":"downloading","completed":50,"total":100}\n{"status":"success"}\n',
      { status: 200 },
    ),
  });
  assert.equal(pullRes.ok, true);
  assert.equal(progressEvents[1].percent, 50);
});

// ─── 11. Remote Assignment Retry Hardening ───────────────────────────────────

test("remote-assignment-retry short-circuits fatal errors, validates strict numeric keys, caps transport storms, and threads knownGroups", async () => {
  const tabs = Array.from({ length: 6 }, (_, i) => ({ hostname: `h${i}.test`, title: `T${i}` }));

  // Fatal auth error stops after 1 call (no bisection storm!)
  let authCalls = 0;
  const authRes = await collectProviderTabMap({
    tabs,
    initialBatchSize: 6,
    label: "test-auth",
    buildPrompt: () => "p",
    fetchJson: async () => {
      authCalls += 1;
      throw new ProviderHttpError({ status: 401, body: "Invalid key" });
    },
  });
  assert.equal(authCalls, 1);
  assert.ok(authRes.fatalError);

  // Strict /^\d+$/ keys + non-empty string values + knownGroups threading
  const seenKnown = [];
  let wave = 0;
  const strictRes = await collectProviderTabMap({
    tabs: tabs.slice(0, 3),
    initialBatchSize: 3,
    label: "test-strict",
    buildPrompt: (chunkTabs, _snips, known) => {
      seenKnown.push([...known]);
      return chunkTabs.map((t) => t.title).join(",");
    },
    fetchJson: async (prompt) => {
      wave += 1;
      if (wave === 1) {
        return { "0": "Dev", "1abc": "BadKey", "2": "   " };
      }
      return { "0": prompt === "T2" ? "Docs" : "Dev" };
    },
  });
  assert.equal(strictRes.parsedByIndex.get(0), "Dev");
  assert.equal(strictRes.parsedByIndex.get(1), "Dev");
  assert.equal(strictRes.parsedByIndex.get(2), "Docs");
  assert.deepEqual(seenKnown[1], ["Dev"]);

  // >50% transport failures abort retry wave instead of fanning out into 1-tab retries
  let transportCalls = 0;
  const stormRes = await collectProviderTabMap({
    tabs: Array.from({ length: 12 }, (_, i) => ({ hostname: `s${i}.test`, title: `S${i}` })),
    initialBatchSize: 4,
    concurrency: 1,
    label: "test-storm",
    buildPrompt: () => "p",
    fetchJson: async () => {
      transportCalls += 1;
      throw new ProviderHttpError({ status: 503, body: "unavailable" });
    },
  });
  assert.equal(transportCalls, 2, "must abort wave once >50% of chunks fail with transport errors");
  assert.equal(stormRes.missing.length, 12);
});
