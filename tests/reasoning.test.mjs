import test from "node:test";
import assert from "node:assert/strict";

import {
  clampTimeBudgetSeconds,
  describeReasoningSelection,
  isReasoningParamError,
  normalizeReasoningPreference,
  parseModelReasoningCapabilities,
  resolveReasoningEffort,
} from "../modules/reasoning.mjs";
import { buildProviderRequest, PARAM_STYLE_MODERN } from "../modules/provider-requests.mjs";
import { runOneShotFallbackNewGroups } from "../modules/remote-provider.mjs";

// Shaped like PrimaLabs' /v1/models, which is what the plugin reads before it
// asks a model to sort anything.
const MODELS = {
  object: "list",
  data: [
    {
      id: "primalabs-ai/DeepSeek-V4.1-Flash-1017",
      supports_reasoning: true,
      reasoning_toggle: { "/v1/chat/completions": true, "/v1/responses": true },
      reasoning_effort_accepted: {
        "/v1/chat/completions": ["none", "low", "high", "xhigh", "max"],
        "/v1/responses": ["none", "low", "high", "xhigh", "max"],
      },
    },
    {
      id: "primalabs-ai/GLM-5.3-Flash",
      supports_reasoning: true,
      reasoning_toggle: { "/v1/chat/completions": false, "/v1/responses": true },
      reasoning_effort_accepted: {
        "/v1/chat/completions": ["low", "high", "max"],
        "/v1/responses": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      },
    },
    { id: "plain-model", supports_reasoning: false },
  ],
};

test("Reasoning preferences are normalized to the five known values", () => {
  assert.equal(normalizeReasoningPreference(""), "fast");
  assert.equal(normalizeReasoningPreference("OFF"), "fast");
  assert.equal(normalizeReasoningPreference("none"), "fast");
  assert.equal(normalizeReasoningPreference("auto"), "default");
  assert.equal(normalizeReasoningPreference("Medium"), "medium");
  assert.equal(normalizeReasoningPreference("nonsense"), "fast");
});

test("The fast preference picks the cheapest level the model actually accepts", () => {
  const deepseek = parseModelReasoningCapabilities(MODELS, "primalabs-ai/DeepSeek-V4.1-Flash-1017");
  const glm = parseModelReasoningCapabilities(MODELS, "primalabs-ai/GLM-5.3-Flash");
  const plain = parseModelReasoningCapabilities(MODELS, "plain-model");

  // DeepSeek can switch thinking off entirely.
  assert.equal(resolveReasoningEffort("fast", deepseek), "none");
  // GLM cannot: chat/completions only knows low|high|max, so low is the floor.
  assert.equal(resolveReasoningEffort("fast", glm), "low");
  assert.equal(deepseek.toggleable, true);
  assert.equal(glm.toggleable, false);
  assert.equal(resolveReasoningEffort("fast", plain), null);
});

test("Unknown capability metadata asks for reasoning off, and the default preference asks for nothing", () => {
  assert.equal(resolveReasoningEffort("fast", {}), "none");
  assert.equal(resolveReasoningEffort("default", {}), null);
  assert.equal(resolveReasoningEffort("medium", { accepted: ["low", "high"] }), "low");
  assert.equal(resolveReasoningEffort("high", { accepted: ["low", "high"] }), "high");
});

test("Only a 400 that names the reasoning field counts as a reasoning parameter rejection", () => {
  assert.equal(isReasoningParamError(400, JSON.stringify({
    error: { message: "Unrecognized request argument supplied: reasoning_effort" },
  })), true);
  assert.equal(isReasoningParamError(400, JSON.stringify({
    error: { message: "Unsupported value: reasoning_effort 'none' is not supported" },
  })), true);
  assert.equal(isReasoningParamError(400, JSON.stringify({
    error: { message: "Unsupported parameter: 'max_tokens' is not supported" },
  })), false);
  assert.equal(isReasoningParamError(400, JSON.stringify({
    error: { message: "Invalid value for 'reasoning.effort': 'none' is not supported by model gpt-6-luna" },
  })), true);
  assert.equal(isReasoningParamError(401, "reasoning_effort unsupported"), false);
  assert.equal(isReasoningParamError(400, JSON.stringify({
    error: { message: "Unsupported value: 'temperature' does not support 0.2" },
  })), false);
});

test("A classic OpenAI-compatible request carries the reasoning choice and needs no extra token headroom", () => {
  const body = JSON.parse(buildProviderRequest({
    provider: "primalabs",
    endpoint: "https://api.primalabs.test/v1",
    apiKey: "test-only",
    model: "primalabs-ai/DeepSeek-V4.1-Flash-1017",
  }, "sort tabs", 800, undefined, { reasoningEffort: "none" }).init.body);

  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.max_tokens, 800);
  assert.equal(body.temperature, 0.2);
});

test("A modern request uses the configured effort instead of a hard-coded low", () => {
  const body = JSON.parse(buildProviderRequest({
    provider: "openai",
    endpoint: "https://api.openai.test/v1",
    apiKey: "sk-test",
    model: "gpt-5-nano",
  }, "sort tabs", 800, PARAM_STYLE_MODERN, { reasoningEffort: "none" }).init.body);

  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.max_completion_tokens, 800);
});

test("The connection-test wording names the reasoning level that was used", () => {
  const glm = parseModelReasoningCapabilities(MODELS, "primalabs-ai/GLM-5.3-Flash");
  assert.match(describeReasoningSelection("fast", glm, "low"), /cannot switch it off/);
  assert.equal(describeReasoningSelection("fast", { supported: false }, null), "reasoning off");
  assert.equal(describeReasoningSelection("default", {}, null), "reasoning: provider default");
});

test("The AI time limit is clamped to a sane range", () => {
  assert.equal(clampTimeBudgetSeconds("5"), 5);
  assert.equal(clampTimeBudgetSeconds("5,5"), 5.5);
  assert.equal(clampTimeBudgetSeconds("0"), 3);
  assert.equal(clampTimeBudgetSeconds("9999"), 120);
  assert.equal(clampTimeBudgetSeconds("abc"), 10);
});

test("A slow provider is cut off by the AI time limit instead of blocking the sort", async () => {
  let calls = 0;
  const startedAt = Date.now();
  const result = await runOneShotFallbackNewGroups({
    leftoverTabs: [
      { hostname: "figma.com", title: "Wireframe", url: "" },
      { hostname: "dribbble.com", title: "Inspiration", url: "" },
    ],
    fallbackSettings: {
      provider: "primalabs",
      consentToSendData: true,
      endpoint: "https://api.primalabs.test/v1",
      apiKey: "test-only",
      model: "primalabs-ai/DeepSeek-V4.1-Flash-1017",
    },
    deadlineAt: Date.now() + 1000,
    fetchImpl: async (url, init = {}) => {
      if ((init.method || "GET").toUpperCase() === "GET") return new Response("not found", { status: 404 });
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 });
    },
  });

  assert.equal(result.failed, "time_budget_exceeded");
  assert.equal(result.newGroups.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.equal(calls, 1, "the second attempt must not start once the budget is gone");
  assert.ok(Date.now() - startedAt < 1800, "the pass must return near the deadline, not hang");
});
