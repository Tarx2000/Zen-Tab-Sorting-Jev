import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../modules/config.mjs";
import {
  JEV_NONE_CHOICE,
  buildJevCriteria,
  buildJevHttpRequest,
  buildJevPayload,
  clampMargin,
  clampProbability,
  classifyExistingGroupsWithJev,
  estimateJevTokens,
  evaluateJevBatchResponse,
  packJevBatches,
  readJevSettings,
} from "../modules/jev.mjs";
import { classifyWorkspaceUnitsWithJev } from "../modules/workspace-jev.mjs";

test("Given user-entered JEV probability and margin settings When parsed Then decimals, German commas, and percentages all work", () => {
  assert.equal(clampProbability("0.75"), 0.75);
  assert.equal(clampProbability("0,80"), 0.80);
  assert.equal(clampProbability("85%"), 0.85);
  assert.equal(clampProbability("85"), 0.85);

  assert.equal(clampMargin("0.15"), 0.15);
  assert.equal(clampMargin("0,20"), 0.20);
  assert.equal(clampMargin("25%"), 0.25);
  assert.equal(clampMargin("0"), 0);

  const fakePrefs = {
    PREF_STRING: "string",
    PREF_BOOL: "bool",
    prefHasUserValue: () => true,
    getPrefType: (name) => (name === CONFIG.AI_PROVIDER_CONSENT_PREF ? "bool" : "string"),
    getStringPref: (name) => {
      if (name === CONFIG.AI_JEV_MIN_PROB_PREF) return "0,82";
      if (name === CONFIG.AI_JEV_MIN_MARGIN_PREF) return "18%";
      if (name === CONFIG.AI_JEV_PROVIDER_PREF) return "openrouter";
      if (name === CONFIG.AI_JEV_API_KEY_PREF) return "or-token";
      return "";
    },
    getBoolPref: () => true,
  };

  const settings = readJevSettings(fakePrefs);
  assert.equal(settings.minProbability, 0.82);
  assert.equal(settings.minMargin, 0.18);
  assert.equal(settings.jevProvider, "openrouter");
  assert.equal(settings.model, "typesafe/jev-1.13");
});

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

test("buildJevPayload keeps large workspaces compact without duplicating sample tabs or snippets across 25 questions", () => {
  const existingGroups = Array.from({ length: 20 }, (_, g) => ({
    name: `Group ${g}`,
    domains: [`domain-${g}-a.example`, `domain-${g}-b.example`],
    tabs: Array.from({ length: 5 }, (_, t) => ({
      title: `Existing tab ${g}-${t} with a realistic long page title`,
      hostname: `domain-${g}-a.example`,
    })),
  }));
  const tabs = Array.from({ length: 25 }, (_, i) => ({
    hostname: `open-${i}.example`,
    title: `Open tab ${i} — Documentation and Overview`,
    url: `https://open-${i}.example/docs/getting-started`,
  }));
  const snippets = tabs.map((_, i) => `[type: article] [site: Docs ${i}] Overview of API configuration and setup steps.`);

  const payload = buildJevPayload({ model: "jev-1.13.0", existingGroups, tabs, snippets });
  assert.deepEqual(Object.keys(payload), ["model", "state", "questions"]);
  assert.equal(payload.state.existing_workspace_groups.length, 20);
  assert.equal(payload.state.tabs_to_classify.length, 25);
  assert.ok(payload.state.tabs_to_classify[0].snippet.includes("[type: article]"));
  assert.ok(estimateJevTokens(payload) < 14_000, `expected compact payload < 14K tokens, got ${estimateJevTokens(payload)}`);

  const splitBatches = packJevBatches({
    model: "jev-1.13.0",
    existingGroups,
    tabs,
    snippets,
    maxTokens: 4_000,
  });
  assert.ok(splitBatches.length > 1, "packJevBatches must split oversized batches below token ceiling");
  assert.equal(splitBatches.reduce((sum, b) => sum + b.chunkTabs.length, 0), 25);
});

test("classifyExistingGroupsWithJev bisects on HTTP 400 max tokens exceeded and retries 1-tab overflow in compact mode", async () => {
  const tabs = [
    { hostname: "a.example", title: "A", url: "https://a.example" },
    { hostname: "b.example", title: "B", url: "https://b.example" },
    { hostname: "c.example", title: "C", url: "https://c.example" },
    { hostname: "d.example", title: "D", url: "https://d.example" },
  ];
  const existingGroups = [{
    name: "Work",
    domains: ["a.example"],
    tabs: [{ title: "Existing Work Tab", hostname: "a.example" }],
  }];
  const jevSettings = {
    jevProvider: "typesafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    apiKey: "ts-token",
    minProbability: 0.7,
    minMargin: 0.15,
    consentToSendData: true,
  };

  const batchSizes = [];
  const result = await classifyExistingGroupsWithJev({
    tabs,
    existingGroups,
    snippets: ["long snippet", "long snippet", "long snippet", "long snippet"],
    jevSettings,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      const count = payload.state.tabs_to_classify.length;
      const hasCurrentTabs = Boolean(payload.state.existing_workspace_groups[0].current_tabs);
      batchSizes.push({ count, hasCurrentTabs });
      if (count > 1) {
        return new Response(JSON.stringify({ error: { message: "max tokens exceeded" } }), { status: 400 });
      }
      if (payload.state.tabs_to_classify[0].hostname === "d.example" && hasCurrentTabs) {
        return new Response("Request exceeds max_tokens limit", { status: 400 });
      }
      return new Response(JSON.stringify({
        answers: {
          tab_0: { choice: "Work", probabilities: { Work: 0.92, __none__: 0.08 } },
        },
      }), { status: 200 });
    },
  });

  assert.ok(batchSizes.some((b) => b.count === 4));
  assert.ok(batchSizes.some((b) => b.count === 1 && b.hasCurrentTabs === false));
  assert.deepEqual(result.assignedToExisting.map((a) => a.tabInfo.hostname), ["a.example", "b.example", "c.example", "d.example"]);
  assert.deepEqual(result.leftoverTabs, []);
});

test("classifyWorkspaceUnitsWithJev automatically bisects on HTTP 400 max tokens exceeded and preserves order", async () => {
  const spaces = [{ id: "a", name: "Work" }, { id: "b", name: "Dev" }];
  const units = Array.from({ length: 4 }, (_, i) => ({
    id: `u_${i}`,
    name: `Unit ${i}`,
    kind: "tab",
    workspaceId: "a",
    tabs: [{ title: `Tab ${i}`, hostname: `h${i}.test` }],
  }));
  const settings = { model: "jev-test", apiKey: "ts-token", jevProvider: "typesafe", consentToSendData: true };

  const sizes = [];
  const result = await classifyWorkspaceUnitsWithJev({
    units,
    workspaces: spaces,
    settings,
    wait: async () => {},
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(init.body);
      const count = payload.state.units.length;
      sizes.push(count);
      if (count > 2) {
        return new Response("max tokens exceeded", { status: 400 });
      }
      const answers = {};
      for (let i = 0; i < count; i++) {
        answers[`unit_${i}`] = { choice: "b", probabilities: { a: 0.1, b: 0.9 } };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    },
  });

  assert.deepEqual(sizes, [4, 2, 2]);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.decisions.map((d) => d.unit.id), ["u_0", "u_1", "u_2", "u_3"]);
});
