import test from "node:test";
import assert from "node:assert/strict";

import { clearSnippetCache, fetchPageSnippet, fetchPageSnippets } from "../modules/tabs.mjs";
import { classifyExistingGroupsWithJev, testJevConnection } from "../modules/jev.mjs";
import { classifyWorkspaceUnitsWithJev } from "../modules/workspace-jev.mjs";
import { applyGroupColor, findExistingGroup } from "../modules/groups.mjs";
import { buildProviderRequest } from "../modules/provider-requests.mjs";
import { resetProviderReasoningCache, runOneShotFallbackNewGroups } from "../modules/remote-provider.mjs";
import { applyPass2 } from "../modules/ai.mjs";
import { PRESET_COLORS } from "../modules/config.mjs";

test("fetchPageSnippet streams early head/h1 cutoff, caps bytes, and caches results", async () => {
  clearSnippetCache();
  let fetchCalls = 0;
  let canceled = false;
  let chunksPulled = 0;

  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode('<html><head><meta property="og:type" content="article"><meta name="description" content="Fast stream"></head>'),
    encoder.encode("<body><h1>Main Heading</h1>"),
    encoder.encode("<p>Large trailing body that should never be pulled</p>".repeat(200)),
  ];

  const fakeFetch = async () => {
    fetchCalls += 1;
    let idx = 0;
    return {
      ok: true,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              chunksPulled += 1;
              return { done: false, value: chunks[idx++] };
            },
            async cancel() {
              canceled = true;
            },
          };
        },
      },
    };
  };

  const first = await fetchPageSnippet("https://example.test/article", { fetchImpl: fakeFetch });
  assert.match(first, /\[type: article\]/);
  assert.match(first, /\[topic: Main Heading\]/);
  assert.match(first, /Fast stream/);
  assert.equal(chunksPulled, 2, "must stop streaming once </head> and </h1> are received");
  assert.equal(canceled, true);

  const second = await fetchPageSnippet("https://example.test/article", { fetchImpl: fakeFetch });
  assert.equal(second, first);
  assert.equal(fetchCalls, 1, "cache hit must avoid a second network fetch");

  // Byte cap when </head> never arrives.
  let overflowReads = 0;
  const bigChunk = new Uint8Array(20_000).fill(65); // 'A'
  const bigFetch = async () => ({
    ok: true,
    headers: new Headers({ "content-type": "text/html" }),
    body: {
      getReader() {
        return {
          async read() {
            overflowReads += 1;
            return overflowReads <= 5 ? { done: false, value: bigChunk } : { done: true };
          },
          async cancel() {},
        };
      },
    },
  });
  await fetchPageSnippet("https://example.test/huge", { fetchImpl: bigFetch });
  assert.equal(overflowReads, 2, "streaming must cap reads at 32KB");
});

test("fetchPageSnippets deduplicates URLs and aborts slow requests at global budget", async () => {
  clearSnippetCache();
  const seen = [];
  let hangingAborted = false;

  const fakeFetch = (url, init = {}) => {
    seen.push(url);
    if (url.includes("slow.example")) {
      return new Promise((resolve) => {
        init.signal?.addEventListener("abort", () => {
          hangingAborted = true;
          resolve(new Response("", { status: 200 }));
        }, { once: true });
      });
    }
    return Promise.resolve(new Response(
      '<html><head><meta name="description" content="Quick page"></head></html>',
      { status: 200, headers: { "content-type": "text/html" } },
    ));
  };

  const startedAt = Date.now();
  const snippets = await fetchPageSnippets(
    [
      { url: "https://fast.example/1" },
      { url: "https://fast.example/1" },
      { url: "https://slow.example/hang" },
      { url: "about:config" },
    ],
    { globalBudgetMs: 120, perRequestTimeoutMs: 5000, fetchImpl: fakeFetch },
  );

  assert.equal(seen.length, 2, "duplicate URLs and about:* must not make extra requests");
  assert.equal(snippets[0], "Quick page");
  assert.equal(snippets[1], "Quick page");
  assert.equal(snippets[2], "");
  assert.equal(snippets[3], "");
  assert.equal(hangingAborted, true);
  assert.ok(Date.now() - startedAt < 800);
});

test("classifyExistingGroupsWithJev runs multi-batch requests concurrently while keeping order and testJevConnection reports latency", async () => {
  const tabs = Array.from({ length: 55 }, (_, i) => ({
    hostname: `site-${i}.example`,
    title: `Tab ${i}`,
    url: `https://site-${i}.example`,
  }));
  const existingGroups = [{ name: "Work", domains: ["site-0.example"], tabs: [] }];
  const jevSettings = {
    jevProvider: "typesafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    apiKey: "ts-test",
    minProbability: 0.7,
    minMargin: 0.15,
    consentToSendData: true,
  };

  let inFlight = 0;
  let maxInFlight = 0;

  const result = await classifyExistingGroupsWithJev({
    tabs,
    existingGroups,
    jevSettings,
    concurrency: 3,
    fetchImpl: async (_url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;

      const payload = JSON.parse(init.body);
      const count = Object.keys(payload.questions).length;
      const answers = {};
      for (let i = 0; i < count; i++) {
        answers[`tab_${i}`] = i % 2 === 0
          ? { choice: "Work", probabilities: { Work: 0.9, __none__: 0.1 } }
          : { choice: "__none__", probabilities: { __none__: 0.9, Work: 0.1 } };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    },
  });

  assert.ok(maxInFlight > 1, "multiple 25-tab JEV batches must execute concurrently");
  assert.equal(result.assignedToExisting.length + result.leftoverTabs.length, 55);
  assert.equal(result.assignedToExisting[0].tabInfo, tabs[0]);
  assert.equal(result.assignedToExisting.at(-1).tabInfo, tabs[54]);

  const probe = await testJevConnection(jevSettings, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ answers: { probe: { choice: "Dev" } } }), { status: 200 });
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.reply, 'JEV picked "Dev"');
  assert.equal(typeof probe.latencyMs, "number");
  assert.ok(probe.latencyMs >= 0);
});

test("classifyWorkspaceUnitsWithJev with concurrency=3 executes batches in parallel and preserves snapshot order", async () => {
  const spaces = [{ id: "a", name: "Work" }, { id: "b", name: "Play" }];
  const units = Array.from({ length: 55 }, (_, i) => ({
    id: `u_${i}`,
    name: `Unit ${i}`,
    kind: "tab",
    workspaceId: "a",
    tabs: [{ title: `Tab ${i}`, hostname: `h${i}.test` }],
  }));
  const settings = { model: "jev-test", apiKey: "ts-token", jevProvider: "typesafe", consentToSendData: true };

  let inFlight = 0;
  let maxInFlight = 0;
  const result = await classifyWorkspaceUnitsWithJev({
    units,
    workspaces: spaces,
    settings,
    concurrency: 3,
    fetchImpl: async (_url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      const payload = JSON.parse(init.body);
      const answers = {};
      for (let i = 0; i < payload.state.units.length; i++) {
        answers[`unit_${i}`] = { choice: "b", probabilities: { a: 0.1, b: 0.9 } };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    },
  });

  assert.ok(maxInFlight > 1);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.decisions.map((d) => d.unit.id), units.map((u) => u.id));
});

test("applyGroupColor supports hex colors via CSS color-mix and findExistingGroup matches empty workspace groups", () => {
  const props = new Map();
  const groupEl = {
    isConnected: true,
    getAttribute: () => "Design",
    style: {
      setProperty: (k, v, p) => props.set(k, [v, p]),
      removeProperty: (k) => props.delete(k),
    },
  };

  assert.doesNotThrow(() => applyGroupColor(groupEl, "#336699"));
  assert.deepEqual(props.get("--tab-group-color"), ["#336699", "important"]);
  assert.match(props.get("--tab-group-color-invert")[0], /^color-mix\(in srgb, #336699 55%, white\)$/);
  assert.match(props.get("--tab-group-color-pale")[0], /^color-mix\(in srgb, #336699 20%, white\)$/);

  const emptyGroup = {
    isConnected: true,
    closest: (sel) => (sel === "zen-workspace" ? { id: "ws-1" } : null),
    getAttribute: () => null,
    querySelector: () => null,
  };
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes('label="Empty"') ? [emptyGroup] : []),
  };
  try {
    assert.equal(findExistingGroup("Empty", "ws-1"), emptyGroup);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("jsonMode sets response_format / Gemini fast thinkingConfig and recovers on 400 rejection", async () => {
  const openAiBody = JSON.parse(buildProviderRequest({
    provider: "custom",
    format: "openai",
    endpoint: "https://custom.example/v1",
    apiKey: "sk-custom",
    model: "my-model",
  }, "sort", 500, undefined, { reasoningEffort: "none", jsonMode: true }).init.body);
  assert.deepEqual(openAiBody.response_format, { type: "json_object" });

  const geminiBody = JSON.parse(buildProviderRequest({
    provider: "gemini",
    apiKey: "AIza-test",
    model: "gemini-2.5-flash",
  }, "sort", 500, undefined, { reasoningEffort: "none", jsonMode: true }).init.body);
  assert.equal(geminiBody.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(geminiBody.generationConfig.thinkingConfig, { thinkingBudget: 0 });

  resetProviderReasoningCache();
  const requests = [];
  const customSettings = {
    provider: "custom",
    format: "openai",
    consentToSendData: true,
    endpoint: "https://custom-no-json-mode.example/v1",
    apiKey: "sk-custom",
    model: "local-shim",
  };
  const tabs = [
    { hostname: "a.test", title: "A", url: "" },
    { hostname: "b.test", title: "B", url: "" },
  ];
  const fakeFetch = async (_url, init = {}) => {
    if ((init.method || "GET").toUpperCase() === "GET") return new Response("not found", { status: 404 });
    const parsedBody = JSON.parse(init.body);
    requests.push(parsedBody);
    if (parsedBody.response_format) {
      return new Response(JSON.stringify({
        error: { message: "Unsupported parameter: 'response_format' is not supported by this backend" },
      }), { status: 400 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ 0: "Research", 1: "Research" }) } }],
    }), { status: 200 });
  };

  const firstRun = await runOneShotFallbackNewGroups({
    leftoverTabs: tabs,
    snippets: ["", ""],
    fallbackSettings: customSettings,
    fetchImpl: fakeFetch,
  });
  assert.equal(firstRun.newGroups[0].name, "Research");
  assert.equal(requests.length, 2, "must retry once without response_format");
  assert.equal("response_format" in requests[1], false);

  // Second run remembers response_format was rejected and omits it on first try.
  await runOneShotFallbackNewGroups({
    leftoverTabs: tabs,
    snippets: ["", ""],
    fallbackSettings: customSettings,
    fetchImpl: fakeFetch,
  });
  assert.equal(requests.length, 3);
  assert.equal("response_format" in requests[2], false);
});

test("ChatGPT reasoning effort 'none' rejection falls back to 'low' and remembers it", async () => {
  resetProviderReasoningCache();
  const bodies = [];
  const settings = {
    provider: "chatgpt",
    consentToSendData: true,
    model: "gpt-5-codex-mini",
    accessToken: "at_test",
    refreshToken: "",
    clientId: "oaiapp_test",
    expiresAt: Date.now() + 3600_000,
  };
  const tabs = [
    { hostname: "a.test", title: "A", url: "" },
    { hostname: "b.test", title: "B", url: "" },
  ];
  const fakeFetch = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.reasoning?.effort === "none") {
      return new Response(JSON.stringify({
        error: { message: "Invalid value for 'reasoning.effort': 'none' is not supported" },
      }), { status: 400 });
    }
    return new Response('data: {"type":"response.output_text.delta","delta":"{\\"0\\":\\"Dev\\",\\"1\\":\\"Dev\\"}"}\n', { status: 200 });
  };

  const first = await runOneShotFallbackNewGroups({
    leftoverTabs: tabs,
    snippets: ["", ""],
    fallbackSettings: settings,
    fetchImpl: fakeFetch,
  });
  assert.equal(first.newGroups[0].name, "Dev");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning.effort, "none");
  assert.equal(bodies[1].reasoning.effort, "low");

  await runOneShotFallbackNewGroups({
    leftoverTabs: tabs,
    snippets: ["", ""],
    fallbackSettings: settings,
    fetchImpl: fakeFetch,
  });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].reasoning.effort, "low");
});

test("applyPass2 picks a color unused by existing workspace DOM groups", () => {
  const used = PRESET_COLORS.slice(0, PRESET_COLORS.length - 1).map((c) => c.name);
  const expectedUnused = PRESET_COLORS.at(-1).name;
  const existingDomGroups = used.map((color) => ({
    isConnected: true,
    color,
    closest: () => null,
    getAttribute: (k) => (k === "color" ? color : null),
  }));

  const createdColors = [];
  const makeTab = () => ({ isConnected: true, closest: () => null });
  const tabs = [makeTab(), makeTab()];

  globalThis.window = {
    gZenWorkspaces: {
      activeWorkspaceElement: { tabsContainer: { firstChild: { isConnected: true } } },
    },
  };
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => existingDomGroups,
  };
  globalThis.gBrowser = {
    addTabGroup: (_t, options) => {
      createdColors.push(options.color);
      return {
        isConnected: true,
        getAttribute: () => options.label,
        querySelector: () => null,
        style: { removeProperty: () => {}, setProperty: () => {} },
      };
    },
  };

  try {
    applyPass2({
      assignedToExisting: [],
      newGroups: [{ name: "Fresh", tabs: tabs.map((tab, i) => ({ hostname: `h${i}.test`, _tab: tab })) }],
      skipped: [],
    }, "ws-1", [], { newGroupBehavior: "transient", existingBehavior: "transient", persistRules: false });

    assert.deepEqual(createdColors, [expectedUnused]);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.gBrowser;
  }
});
