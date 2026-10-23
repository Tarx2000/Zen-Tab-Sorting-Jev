import test from "node:test";
import assert from "node:assert/strict";

import { buildProviderRequest } from "../modules/provider-requests.mjs";
import {
  runOneShotFallbackNewGroups,
  runPass2JevHybrid,
  validateFallbackSchema,
} from "../modules/remote-provider.mjs";

test("Given PrimaLabs provider When building request Then api.primalabs.ai/v1/chat/completions and DeepSeek model are used", () => {
  const req = buildProviderRequest(
    {
      provider: "primalabs",
      endpoint: "https://api.primalabs.ai/v1",
      apiKey: "sk-test",
      model: "primalabs-ai/DeepSeek-V4.1-Flash-1017",
      consentToSendData: true,
    },
    "sort tabs",
    1024,
  );

  assert.equal(req.url, "https://api.primalabs.ai/v1/chat/completions");
  assert.equal(req.init.headers.authorization, "Bearer sk-test");
  const body = JSON.parse(req.init.body);
  assert.equal(body.model, "primalabs-ai/DeepSeek-V4.1-Flash-1017");
});

test("Given Fallback-LLM output When validateFallbackSchema runs Then missing tab keys or non-string labels are rejected", () => {
  assert.deepEqual(validateFallbackSchema({ "0": "Design", "1": "skipped" }, 2), { ok: true });
  assert.equal(validateFallbackSchema({ "0": "Design" }, 2).ok, false);
  assert.equal(validateFallbackSchema({ "0": "Design", "1": 123 }, 2).ok, false);
  assert.equal(validateFallbackSchema({ "0": "Design", "1": "   " }, 2).ok, false);
});

test("Given Fallback-LLM returns broken schema on first 2 attempts and valid schema on 3rd attempt When runOneShotFallbackNewGroups runs Then it retries with repair instructions and succeeds on attempt 3", async () => {
  const leftoverTabs = [
    { hostname: "figma.com", title: "App Wireframe", url: "" },
    { hostname: "dribbble.com", title: "UI Inspiration", url: "" },
  ];

  let calls = 0;
  const result = await runOneShotFallbackNewGroups({
    leftoverTabs,
    snippets: ["[type: design]", "[type: design]"],
    existingGroupNames: ["Dev"],
    fallbackSettings: {
      provider: "primalabs",
      consentToSendData: true,
      endpoint: "https://api.primalabs.ai/v1",
      apiKey: "sk-test",
      model: "primalabs-ai/DeepSeek-V4.1-Flash-1017",
    },
    fetchImpl: async (_url, init) => {
      calls += 1;
      const bodyObj = JSON.parse(init.body);
      const userContent = bodyObj.messages[0].content;

      if (calls === 1) {
        // Attempt 1: non-JSON prose
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "Sorry, I cannot format that as JSON." } }] }),
          { status: 200 },
        );
      }
      if (calls === 2) {
        // Verify retry prompt mentions attempt 2/3 and the previous failure
        assert.match(userContent, /RETRY ATTEMPT 2\/3/);
        // Attempt 2: valid JSON, but missing tab index "1" (invalid schema!)
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ "0": "UI Design" }) } }] }),
          { status: 200 },
        );
      }
      // Attempt 3: valid schema with all tab indices "0" and "1"
      assert.match(userContent, /RETRY ATTEMPT 3\/3/);
      assert.match(userContent, /Missing required tab index key "1"/);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ "0": "UI Design", "1": "UI Design" }) } }],
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.failed, undefined);
  assert.equal(result.newGroups.length, 1);
  assert.equal(result.newGroups[0].name, "UI Design");
  assert.deepEqual(result.newGroups[0].tabs, leftoverTabs);
});

test("Given Fallback-LLM fails schema validation on all 3 attempts When runOneShotFallbackNewGroups runs Then it stops after 3 attempts, reports schema_validation_failed, and leaves tabs ungrouped", async () => {
  const leftoverTabs = [
    { hostname: "a.example", title: "Tab A", url: "" },
    { hostname: "b.example", title: "Tab B", url: "" },
  ];

  let calls = 0;
  const result = await runOneShotFallbackNewGroups({
    leftoverTabs,
    snippets: ["", ""],
    existingGroupNames: [],
    fallbackSettings: {
      provider: "primalabs",
      consentToSendData: true,
      endpoint: "https://api.primalabs.ai/v1",
      apiKey: "sk-test",
      model: "primalabs-ai/DeepSeek-V4.1-Flash-1017",
    },
    fetchImpl: async () => {
      calls += 1;
      // Always returns incomplete schema missing key "1"
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ "0": "OnlyZero" }) } }] }),
        { status: 200 },
      );
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.match(result.failed, /^schema_validation_failed:/);
  assert.deepEqual(result.newGroups, []);
  assert.deepEqual(result.skipped, leftoverTabs);
});

test("Given JEV + Fallback-LLM hybrid mode When sorting ungrouped tabs Then JEV assigns existing groups, Fallback-LLM groups >=2 leftovers in one shot, and 1-tab outliers stay skipped", async () => {
  const ungroupedTabs = [
    { hostname: "github.com", title: "Fix auth bug PR", url: "https://github.com/org/repo/pull/1" },
    { hostname: "canva.com", title: "Wedding Invitation Card", url: "https://canva.com/design/1" },
    { hostname: "pinterest.com", title: "Wedding Flower Ideas", url: "https://pinterest.com/pin/2" },
    { hostname: "random-exotic-tool.io", title: "obscure calculator", url: "https://random-exotic-tool.io" },
  ];

  const existingGroups = [
    {
      name: "Work Dev",
      domains: ["github.com", "linear.app"],
      tabs: [{ title: "Sprint Board", hostname: "linear.app", url: "https://linear.app" }],
    },
    {
      name: "Business Marketing",
      domains: ["canva.com"],
      tabs: [{ title: "B2B Sales Deck Q4", hostname: "canva.com", url: "https://canva.com/design/b2b" }],
    },
  ];

  const networkCalls = [];
  const fakeFetch = async (url, init) => {
    networkCalls.push({ url, init });

    // Call 1: JEV Stage 1
    if (url === "https://api.typesafe.ai/v1/systemone") {
      return new Response(
        JSON.stringify({
          answers: {
            tab_0: {
              type: "choice",
              choice: "Work Dev",
              probabilities: { "Work Dev": 0.91, "Business Marketing": 0.05, __none__: 0.04 },
              confidence: 0.91,
            },
            tab_1: {
              type: "choice",
              choice: "__none__",
              probabilities: { __none__: 0.78, "Business Marketing": 0.18, "Work Dev": 0.04 },
              confidence: 0.78,
            },
            tab_2: {
              type: "choice",
              choice: "__none__",
              probabilities: { __none__: 0.89, "Business Marketing": 0.07, "Work Dev": 0.04 },
              confidence: 0.89,
            },
            tab_3: {
              type: "choice",
              choice: "__none__",
              probabilities: { __none__: 0.94, "Work Dev": 0.04, "Business Marketing": 0.02 },
              confidence: 0.94,
            },
          },
        }),
        { status: 200 },
      );
    }

    // Call 2: One-Shot Fallback-LLM (ChatGPT SIWC /v1/responses)
    if (url === "https://api.openai.com/v1/responses") {
      const sse = [
        'data: {"type":"response.output_text.delta","delta":"{\\"0\\": \\"Wedding Planning\\", \\"1\\": \\"Wedding Planning\\", \\"2\\": \\"Calculators\\"}"}',
        'data: [DONE]',
      ].join("\n");
      return new Response(sse, { status: 200 });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runPass2JevHybrid(ungroupedTabs, existingGroups, {
    jevSettings: {
      jevProvider: "typesafe",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-1.13.0",
      apiKey: "ts-test",
      minProbability: 0.70,
      minMargin: 0.15,
      consentToSendData: true,
    },
    fallbackSettings: {
      provider: "chatgpt",
      consentToSendData: true,
      model: "gpt-5-codex-mini",
      accessToken: "at_valid_token",
      refreshToken: "",
      clientId: "oaiapp_test",
      expiresAt: Date.now() + 3600_000,
    },
    preFetchedSnippets: [
      "[type: website] [site: GitHub] [topic: Fix auth bug PR]",
      "[type: design] [site: Canva] [topic: Wedding Invitation Card]",
      "[type: pin] [site: Pinterest] [topic: Wedding Flower Ideas]",
      "[type: tool] [topic: obscure calculator]",
    ],
    fetchImpl: fakeFetch,
  });

  assert.equal(networkCalls.length, 2);
  assert.equal(networkCalls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(networkCalls[1].url, "https://api.openai.com/v1/responses");

  assert.equal(result.assignedToExisting.length, 1);
  assert.equal(result.assignedToExisting[0].groupName, "Work Dev");
  assert.equal(result.assignedToExisting[0].tabInfo, ungroupedTabs[0]);

  assert.equal(result.newGroups.length, 1);
  assert.equal(result.newGroups[0].name, "Wedding Planning");
  assert.deepEqual(result.newGroups[0].tabs, [ungroupedTabs[1], ungroupedTabs[2]]);

  assert.deepEqual(result.skipped, [ungroupedTabs[3]]);
});

test("Given JEV Stage 1 matches tabs but Fallback-LLM hits ChatGPT subscription sharing usage limit When runPass2JevHybrid runs Then Stage 1 assignments are preserved, newGroups is empty, and leftover tabs remain skipped", async () => {
  const ungroupedTabs = [
    { hostname: "github.com", title: "PR review", url: "https://github.com/a/b" },
    { hostname: "reddit.com", title: "Random discussion", url: "https://reddit.com/r/all" },
    { hostname: "picdrop.com", title: "Photos", url: "https://picdrop.com/album" },
  ];

  const existingGroups = [
    {
      name: "Development",
      domains: ["github.com"],
      tabs: [{ title: "Code", hostname: "github.com", url: "https://github.com" }],
    },
  ];

  const fakeFetch = async (url) => {
    if (url === "https://api.typesafe.ai/v1/systemone") {
      return new Response(
        JSON.stringify({
          answers: {
            tab_0: {
              type: "choice",
              choice: "Development",
              probabilities: { Development: 0.95, __none__: 0.05 },
              confidence: 0.95,
            },
            tab_1: {
              type: "choice",
              choice: "__none__",
              probabilities: { __none__: 0.9, Development: 0.1 },
              confidence: 0.9,
            },
            tab_2: {
              type: "choice",
              choice: "__none__",
              probabilities: { __none__: 0.92, Development: 0.08 },
              confidence: 0.92,
            },
          },
        }),
        { status: 200 },
      );
    }

    if (url === "https://api.openai.com/v1/responses") {
      return new Response(
        JSON.stringify({
          error: {
            message: "The ChatGPT user has reached their Subscription Sharing usage limit. Ask the user to try again after their usage limit resets or use an API key instead.",
          },
        }),
        { status: 429 },
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runPass2JevHybrid(ungroupedTabs, existingGroups, {
    jevSettings: {
      jevProvider: "typesafe",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-1.13.0",
      apiKey: "ts-test",
      minProbability: 0.70,
      minMargin: 0.15,
      consentToSendData: true,
    },
    fallbackSettings: {
      provider: "chatgpt",
      consentToSendData: true,
      model: "gpt-5-codex-mini",
      accessToken: "at_valid_token",
      refreshToken: "",
      clientId: "oaiapp_test",
      expiresAt: Date.now() + 3600_000,
    },
    preFetchedSnippets: ["", "", ""],
    fetchImpl: fakeFetch,
  });

  // Stage 1 assignment is kept!
  assert.equal(result.assignedToExisting.length, 1);
  assert.equal(result.assignedToExisting[0].groupName, "Development");
  assert.equal(result.assignedToExisting[0].tabInfo, ungroupedTabs[0]);

  // Stage 2 failed gracefully: no new groups, leftover tabs stayed skipped
  assert.deepEqual(result.newGroups, []);
  assert.deepEqual(result.skipped, [ungroupedTabs[1], ungroupedTabs[2]]);
  assert.equal(result.failed, "quota_exceeded");
  assert.match(result.failedMessage, /Subscription-Sharing-Limit/);
});
