import test from "node:test";
import assert from "node:assert/strict";

import { buildProviderRequest } from "../modules/provider-requests.mjs";
import { runPass2JevHybrid } from "../modules/remote-provider.mjs";

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
            // Tab 0 (GitHub PR) -> confident match for "Work Dev"
            tab_0: {
              type: "choice",
              choice: "Work Dev",
              probabilities: { "Work Dev": 0.91, "Business Marketing": 0.05, __none__: 0.04 },
              confidence: 0.91,
            },
            // Tab 1 (Canva Wedding Invitation) -> does NOT fit "Business Marketing" because context is private!
            tab_1: {
              type: "choice",
              choice: "__none__",
              probabilities: { __none__: 0.78, "Business Marketing": 0.18, "Work Dev": 0.04 },
              confidence: 0.78,
            },
            // Tab 2 (Pinterest Wedding Flowers) -> __none__
            tab_2: {
              type: "choice",
              choice: "__none__",
              probabilities: { __none__: 0.89, "Business Marketing": 0.07, "Work Dev": 0.04 },
              confidence: 0.89,
            },
            // Tab 3 (Exotic tool) -> __none__
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

    // Call 2: One-Shot Fallback-LLM (ChatGPT SIWC /v1/responses or PrimaLabs)
    // Receives the 3 leftover tabs (indices 0, 1, 2 of leftoverTabs = original tabs 1, 2, 3)
    if (url === "https://api.openai.com/v1/responses") {
      // Suppose the LLM proposes "Wedding Planning" for tabs 0 & 1, and even if it proposes
      // a 1-tab group "Calculators" for tab 2, the >=2 rule demotes "Calculators" to skipped!
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

  // Exactly 2 calls total: 1 JEV batch + 1 One-Shot Fallback-LLM call
  assert.equal(networkCalls.length, 2);
  assert.equal(networkCalls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(networkCalls[1].url, "https://api.openai.com/v1/responses");

  // Tab 0 assigned to existing group "Work Dev"
  assert.equal(result.assignedToExisting.length, 1);
  assert.equal(result.assignedToExisting[0].groupName, "Work Dev");
  assert.equal(result.assignedToExisting[0].tabInfo, ungroupedTabs[0]);

  // Tabs 1 & 2 grouped into new group "Wedding Planning" (Canva + Pinterest by private context!)
  assert.equal(result.newGroups.length, 1);
  assert.equal(result.newGroups[0].name, "Wedding Planning");
  assert.deepEqual(result.newGroups[0].tabs, [ungroupedTabs[1], ungroupedTabs[2]]);

  // Tab 3 (exotic singleton) stayed ungrouped in skipped
  assert.deepEqual(result.skipped, [ungroupedTabs[3]]);
});
