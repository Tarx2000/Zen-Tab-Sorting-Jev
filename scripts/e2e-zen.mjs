#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertConnectedProfile,
  clickWand,
  delay,
  launchZen,
  stopZen,
  waitForZenReady,
  waitUntil,
} from "./zen-e2e-driver.mjs";
import { createSemanticFixture } from "./zen-e2e-fixtures.mjs";
import { helpText, parseArgs, runZenE2E } from "./zen-e2e-harness.mjs";
import { MarionetteClient, reserveTcpPort } from "./zen-e2e-marionette.mjs";
import {
  createLabProfile,
  findDefaultSineProfile,
  removeLabProfile,
  resolveZenBinary,
  scenarioPrefs,
  writeUserPrefs,
} from "./zen-e2e-profile.mjs";
import { scoreZenQuality } from "./zen-e2e-quality.mjs";
import { startFixturePageServer, startProviderServer } from "./zen-e2e-servers.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Shipped Jev + Fallback-LLM hybrid scenario:
 * Exercises real `ai-engine = "jev"` + `ai-fallback-provider = "custom"` +
 * `ai-sort-mode = "rules-first"` preferences, real UI button click via `clickWand`,
 * Stage 1 Jev classification into existing workspace groups, and Stage 2 Fallback-LLM
 * clustering of leftover tabs into new groups.
 */
export const runJevHybridScenario = async (options) => {
  const sineProfile = await findDefaultSineProfile(options.sineProfile);
  const lab = await createLabProfile(REPO_ROOT, sineProfile);
  let pages = null;
  let provider = null;
  let zen = null;
  let marionette = null;

  try {
    pages = await startFixturePageServer();
    const fixture = createSemanticFixture(options.tabs, pages.port);
    provider = await startProviderServer(options.provider);
    const marionettePort = await reserveTcpPort();
    const prefs = scenarioPrefs({
      scenario: "jev-hybrid",
      providerPort: provider.port,
      marionettePort,
    });
    await writeUserPrefs(lab.profileDir, prefs);

    zen = launchZen({ options, profileDir: lab.profileDir, marionettePort });
    marionette = await MarionetteClient.connect(marionettePort);
    await marionette.newSession();
    await marionette.setScriptTimeout();
    await marionette.setChromeContext();
    await assertConnectedProfile(marionette, lab.profileDir);
    await waitForZenReady(marionette);

    // Seed workspace tabs + an existing "Development" anchor group and intercept
    // Jev's Stage 1 decision endpoint in-browser so Stage 1 routes Dev tabs to the
    // existing group and leaves remaining tabs for Stage 2 Fallback-LLM.
    await marionette.execute(`
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const workspaceId = win.gZenWorkspaces.activeWorkspace;
      while (win.gBrowser.tabs.length > 1) win.gBrowser.removeTab(win.gBrowser.tabs.at(-1));
      const tabs = ${JSON.stringify(fixture.tabs)};
      const created = [];
      for (const fixtureTab of tabs) {
        const tab = win.gBrowser.addTab(fixtureTab.url, {
          inBackground: true,
          skipAnimation: true,
          triggeringPrincipal: principal,
        });
        tab.setAttribute("label", fixtureTab.title);
        tab.setAttribute("zen-workspace-id", workspaceId);
        created.push(tab);
      }
      win.gBrowser.selectedTab = win.gBrowser.tabs[0];
      const anchorGroup = win.gBrowser.addTabGroup([], {
        label: "Development",
        color: "blue",
        insertBefore: win.gZenWorkspaces.activeWorkspaceElement?.tabsContainer?.firstChild || null,
      });
      anchorGroup?.setAttribute?.("zen-workspace-id", workspaceId);
      win.gZenWorkspaces?.updateTabsContainers?.();

      const originalFetch = win.fetch.bind(win);
      win.__jevHybridCalls = 0;
      win.fetch = async (url, init) => {
        if (String(url).includes("api.typesafe.ai/v1/systemone")) {
          win.__jevHybridCalls += 1;
          const payload = JSON.parse(init?.body || "{}");
          const questions = payload.questions || {};
          const answers = {};
          const stateTabs = payload.state?.tabs || [];
          for (const [key, q] of Object.entries(questions)) {
            const idx = Number.parseInt(key.replace(/^tab_/, ""), 10);
            const tab = stateTabs[idx];
            const text = String((tab?.title || "") + " " + (tab?.url || "")).toLowerCase();
            const isDev = /github|code|pull request|commit|build|typescript|rust|docker/.test(text);
            const optionsMap = {};
            for (const opt of q.options || []) {
              if (opt === "Development") optionsMap[opt] = isDev ? 0.92 : 0.08;
              else if (opt === "__NONE__" || opt === "None") optionsMap[opt] = isDev ? 0.08 : 0.92;
              else optionsMap[opt] = 0.0;
            }
            answers[key] = {
              choice: isDev ? "Development" : "__NONE__",
              probabilities: optionsMap,
            };
          }
          return new win.Response(JSON.stringify({ answers }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return originalFetch(url, init);
      };
    `);

    await waitUntil(async () => {
      const probe = await marionette.execute(`
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        const workspaceId = win.gZenWorkspaces.activeWorkspace;
        const count = [...win.gBrowser.tabs]
          .filter((tab) => tab.getAttribute("zen-workspace-id") === workspaceId)
          .map((tab) => win.gBrowser.getBrowserForTab(tab)?.currentURI?.spec || "")
          .filter((url) => url.startsWith("http://")).length;
        return { count };
      `);
      return { done: probe.count >= fixture.tabs.length, state: probe };
    }, "Zen did not attach fixture URLs for jev-hybrid");

    const clickResult = await clickWand(marionette, {
      fallbackToCommand: Boolean(options.fallbackToCommand),
    });

    const state = await waitUntil(async () => {
      const snapshot = await marionette.execute(`
        const win = Services.wm.getMostRecentWindow("navigator:browser");
        const tabState = (tab) => {
          const spec = win.gBrowser.getBrowserForTab(tab)?.currentURI?.spec || "";
          let id = "";
          try {
            const url = new URL(spec);
            id = url.pathname.split("/").filter(Boolean).at(-1) || "";
          } catch {}
          return { id, title: tab.getAttribute("label") || "", url: spec };
        };
        const groups = [...win.document.querySelectorAll("tab-group:not([split-view-group])")]
          .filter((group) => !group.closest("zen-library"))
          .map((group) => ({
            label: group.getAttribute("label") || "",
            tabs: group.querySelectorAll("tab").length,
            tabItems: [...group.querySelectorAll("tab")].map(tabState),
          }));
        const wandButton = win.document.querySelector(".zao-organize-button, #tab-wand-button");
        return {
          groups,
          groupedTabs: groups.reduce((sum, g) => sum + g.tabs, 0),
          predictedGroups: groups.map((g) => ({ label: g.label, tabs: g.tabItems })),
          jevCalls: win.__jevHybridCalls || 0,
          aiEngine: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-engine", "missing"),
          aiFallbackProvider: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-fallback-provider", "missing"),
          sessionActive: Boolean(win._zaoSortSession),
          thinking: Boolean(wandButton?.getAttribute("aria-busy") === "true"),
        };
      `);
      return {
        done: !snapshot.sessionActive && !snapshot.thinking && snapshot.groupedTabs >= fixture.tabs.length,
        state: snapshot,
      };
    }, "jev-hybrid scenario did not produce expected tab groups");

    const quality = scoreZenQuality({
      tabCount: options.tabs,
      goldTabs: fixture.goldTabs,
      predictedGroups: state.predictedGroups.map((group) => ({
        label: group.label,
        tabs: group.tabs.map((tab) => tab.id).filter(Boolean),
      })),
    });

    if (options.holdOpenMs > 0) await delay(options.holdOpenMs);

    return {
      scenario: "jev-hybrid",
      profileDir: lab.profileDir,
      clickResult,
      jevCalls: state.jevCalls,
      providerCalls: provider.calls.length,
      providerBatchSizes: provider.calls.map((call) => call.tabCount),
      providerCallMetadata: provider.calls,
      quality,
      state,
    };
  } finally {
    marionette?.close();
    if (zen) await stopZen(zen);
    if (provider) await provider.close();
    if (pages) await pages.close();
    if (!options.keepProfile) await removeLabProfile(lab.profileDir);
  }
};

const parseExtendedArgs = (argv) => {
  const filtered = [];
  let requestedJevHybrid = false;
  let fallbackToCommand = false;
  let explicitZenBinary = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fallback-to-command") {
      fallbackToCommand = true;
      continue;
    }
    if (arg === "--scenario" && argv[i + 1] === "jev-hybrid") {
      requestedJevHybrid = true;
      filtered.push("--scenario", "hybrid");
      i += 1;
      continue;
    }
    if (arg === "--zen-binary") explicitZenBinary = true;
    filtered.push(arg);
  }

  const options = parseArgs(filtered);
  if (!explicitZenBinary && !process.env.ZEN_BINARY) {
    options.zenBinary = resolveZenBinary();
  }
  if (!options.sineProfile && process.env.ZEN_PROFILE) {
    options.sineProfile = process.env.ZEN_PROFILE;
  }
  options.fallbackToCommand = fallbackToCommand;
  if (requestedJevHybrid) options.scenario = "jev-hybrid";
  return options;
};

const main = async () => {
  const options = parseExtendedArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      `${helpText().replace(
        "--scenario <all|full-ai|hybrid>",
        "--scenario <all|full-ai|hybrid|jev-hybrid>",
      )}  --fallback-to-command            Allow command fallback if wand button is unavailable\n`,
    );
    return;
  }

  let results = [];
  if (options.scenario === "jev-hybrid") {
    const jevResult = await runJevHybridScenario(options);
    if (!jevResult.quality.pass) {
      throw new Error(`Zen E2E quality failed for jev-hybrid: ${JSON.stringify(jevResult.quality)}`);
    }
    results = [jevResult];
  } else {
    results = await runZenE2E(options);
    if (options.scenario === "all") {
      const jevResult = await runJevHybridScenario(options);
      if (!jevResult.quality.pass) {
        throw new Error(`Zen E2E quality failed for jev-hybrid: ${JSON.stringify(jevResult.quality)}`);
      }
      results.push(jevResult);
    }
  }

  for (const result of results) {
    console.log(JSON.stringify({
      scenario: result.scenario,
      profileDir: result.profileDir,
      jevCalls: result.jevCalls ?? 0,
      providerCalls: result.providerCalls,
      providerBatchSizes: result.providerBatchSizes,
      quality: result.quality,
      groups: result.state.groups,
      groupedTabs: result.state.groupedTabs,
    }));
  }
};

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
