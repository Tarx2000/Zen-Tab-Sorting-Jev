import test from "node:test";
import assert from "node:assert/strict";

import {
  JEV_NONE_CHOICE,
  buildJevCriteria,
  buildJevHttpRequest,
  buildJevPayload,
  classifyExistingGroupsWithJev,
  evaluateJevBatchResponse,
} from "../modules/jev.mjs";

test("Given a single existing workspace group When building JEV criteria Then __none__ is included so criteria count >= 2", () => {
  const criteria = buildJevCriteria([
    {
      name: "Business Design",
      domains: ["canva.com"],
      tabs: [{ title: "Q4 Pitch Deck", hostname: "canva.com" }],
    },
  ]);

  const keys = Object.keys(criteria);
  assert.deepEqual(keys, ["Business Design", JEV_NONE_CHOICE]);
  assert.match(criteria["Business Design"], /Q4 Pitch Deck/);
});

test("Given TypeSafe vs OpenRouter JEV providers When building HTTP requests Then correct endpoints and models are used", () => {
  const payload = buildJevPayload({
    model: "jev-1.13.0",
    existingGroups: [{ name: "Dev", domains: ["github.com"], tabs: [] }],
    tabs: [{ hostname: "github.com", title: "PR #42", url: "https://github.com/org/repo/pull/42" }],
    snippets: ["[type: website] [site: GitHub] [topic: PR #42]"],
  });

  // Strict top-level keys required by JEV API
  assert.deepEqual(Object.keys(payload), ["model", "state", "questions"]);

  const tsReq = buildJevHttpRequest(
    { jevProvider: "typesafe", apiKey: "ts-test-token", model: "jev-1.13.0" },
    payload,
  );
  assert.equal(tsReq.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(tsReq.init.headers.authorization, "Bearer ts-test-token");

  const orReq = buildJevHttpRequest(
    { jevProvider: "openrouter", apiKey: "or-test-token", model: "typesafe/jev-1.13" },
    payload,
  );
  assert.equal(orReq.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(orReq.init.headers["X-OpenRouter-Title"], "Zen Tab Sorting");
});

test("Given JEV answers When evaluating probabilities and margins Then only confident matches are assigned and low-confidence tabs go to leftoverTabs", () => {
  const tabs = [
    { hostname: "github.com", title: "Issue tracker", url: "" },
    { hostname: "canva.com", title: "Birthday invitation", url: "" },
    { hostname: "arxiv.org", title: "Quantum computing paper", url: "" },
  ];
  const existingGroups = [
    { name: "Business", domains: ["canva.com", "linear.app"], tabs: [{ title: "Sales Deck", hostname: "canva.com" }] },
    { name: "Dev", domains: ["github.com"], tabs: [{ title: "Pull Request", hostname: "github.com" }] },
  ];

  const responseJson = {
    answers: {
      tab_0: {
        type: "choice",
        choice: "Dev",
        probabilities: { Dev: 0.88, Business: 0.07, [JEV_NONE_CHOICE]: 0.05 },
        confidence: 0.88,
      },
      // Low margin / low probability -> should fall through to Fallback-LLM
      tab_1: {
        type: "choice",
        choice: "Business",
        probabilities: { Business: 0.48, [JEV_NONE_CHOICE]: 0.42, Dev: 0.10 },
        confidence: 0.48,
      },
      // Explicit __none__ -> should fall through to Fallback-LLM
      tab_2: {
        type: "choice",
        choice: JEV_NONE_CHOICE,
        probabilities: { [JEV_NONE_CHOICE]: 0.85, Dev: 0.10, Business: 0.05 },
        confidence: 0.85,
      },
    },
  };

  const result = evaluateJevBatchResponse({
    tabs,
    existingGroups,
    responseJson,
    minProbability: 0.70,
    minMargin: 0.15,
  });

  assert.equal(result.assignedToExisting.length, 1);
  assert.equal(result.assignedToExisting[0].tabInfo, tabs[0]);
  assert.equal(result.assignedToExisting[0].groupName, "Dev");
  assert.deepEqual(result.leftoverTabs, [tabs[1], tabs[2]]);
});

test("Given 0 existing groups in workspace When classifyExistingGroupsWithJev is called Then 0 network calls are made and all tabs become leftoverTabs", async () => {
  let fetchCalls = 0;
  const tabs = [
    { hostname: "figma.com", title: "UI Mockup", url: "" },
    { hostname: "notion.so", title: "Roadmap", url: "" },
  ];

  const result = await classifyExistingGroupsWithJev({
    tabs,
    existingGroups: [],
    snippets: ["s1", "s2"],
    jevSettings: {
      jevProvider: "typesafe",
      apiKey: "ts-token",
      model: "jev-1.13.0",
      minProbability: 0.70,
      minMargin: 0.15,
      consentToSendData: true,
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("Should not call fetch when no existing groups exist");
    },
  });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(result.assignedToExisting, []);
  assert.deepEqual(result.leftoverTabs, tabs);
  assert.deepEqual(result.leftoverSnippets, ["s1", "s2"]);
});
