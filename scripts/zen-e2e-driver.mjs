import { spawn } from "node:child_process";

import { resolveZenBinary } from "./zen-e2e-profile.mjs";

const SENSITIVE_ENV_TOKEN = /(^|_)(API[-_]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|PRIVATE[-_]?KEY)($|_)/i;
const PROVIDER_ENV_PREFIX = /^(OPENROUTER|OPENAI|ANTHROPIC|GOOGLE|GEMINI)_/i;

export const buildZenEnv = (sourceEnv = process.env, headed = false, marionettePort = 0) => {
  const env = {};
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (!PROVIDER_ENV_PREFIX.test(name) && !SENSITIVE_ENV_TOKEN.test(name)) env[name] = value;
  }
  if (!headed) env.MOZ_HEADLESS = "1";
  if (Number.isInteger(marionettePort) && marionettePort > 0) {
    env.MOZ_MARIONETTE_PORT = String(marionettePort);
  }
  return env;
};

export const launchZen = ({ options = {}, profileDir, marionettePort }) => {
  const args = [
    "--new-instance",
    "--no-remote",
    "--profile",
    profileDir,
    "--marionette",
    "--remote-allow-system-access",
    "about:blank",
  ];
  if (!options.headed) args.unshift("--headless");
  const env = buildZenEnv(process.env, options.headed, marionettePort);
  const binary = resolveZenBinary(options.zenBinary);
  const zen = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env });
  const lines = [];
  const collect = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      lines.push(line);
      if (lines.length > 80) lines.shift();
    }
  };
  zen.stdout.on("data", collect);
  zen.stderr.on("data", collect);
  zen.e2eLogTail = () => lines.slice(-30);
  return zen;
};

export const assertConnectedProfile = async (marionette, expectedProfileDir) => {
  const actualProfileDir = await marionette.execute(`
    return Services.dirsvc.get("ProfD", Ci.nsIFile).path;
  `);
  if (actualProfileDir !== expectedProfileDir) {
    throw new Error(`Marionette connected to ${actualProfileDir}, expected lab profile ${expectedProfileDir}`);
  }
};

export const stopZen = async (zen) => {
  if (!zen || zen.exitCode != null) return;
  zen.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      zen.kill("SIGKILL");
      resolvePromise();
    }, 5000);
    zen.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
};

export const driveZenScenario = async (marionette, scenario, { fallbackToCommand = false } = {}) => {
  await waitForZenReady(marionette);
  await prepareTabs(marionette, scenario);
  await waitForWorkspaceUrls(marionette, scenario.tabs.length);
  await clickWand(marionette, { fallbackToCommand });
  return await waitForSortedState(marionette, scenario.name, scenario.tabs.length);
};

export const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export const waitForZenReady = async (marionette) => waitUntil(async () => {
  const state = await marionette.execute(`
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    return {
      hasSineAPI: !!win?.SineAPI,
      hasButton: !!win?.document?.querySelector(".zao-organize-button, #tab-wand-button"),
      hasCommand: !!win?.document?.getElementById("cmd_zenAutoOrganize"),
      hasListener: !!win?.document?.querySelector("commandset#zenCommandSet")?._zaoCommandListener,
      hasHarness: typeof win?.ZenTabSorting?.handleOrganizeClick === "function",
      hasBrowser: !!win?.gBrowser?.tabs,
    };
  `);
  return {
    done:
      state.hasSineAPI &&
      state.hasButton &&
      state.hasCommand &&
      state.hasListener &&
      state.hasHarness &&
      state.hasBrowser,
    state,
  };
}, "Zen did not load Sine/Zen Tab Sorting");

const prepareTabs = async (marionette, scenario) => {
  await marionette.execute(`
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    const workspaceId = win.gZenWorkspaces.activeWorkspace;
    while (win.gBrowser.tabs.length > 1) win.gBrowser.removeTab(win.gBrowser.tabs.at(-1));
    const tabs = ${JSON.stringify(scenario.tabs)};
    for (const fixtureTab of tabs) {
      const tab = win.gBrowser.addTab(fixtureTab.url, {
        inBackground: true,
        skipAnimation: true,
        triggeringPrincipal: principal,
      });
      tab.setAttribute("label", fixtureTab.title);
      tab.setAttribute("zen-workspace-id", workspaceId);
    }
    win.gBrowser.selectedTab = win.gBrowser.tabs[0];
    win.gZenWorkspaces?.updateTabsContainers?.();
    return { tabs: win.gBrowser.tabs.length };
  `);
};

const waitForWorkspaceUrls = async (marionette, expectedTabs) => waitUntil(async () => {
  const state = await marionette.execute(`
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const workspaceId = win.gZenWorkspaces.activeWorkspace;
    const urls = [...win.gBrowser.tabs]
      .filter((tab) => tab.getAttribute("zen-workspace-id") === workspaceId)
      .map((tab) => win.gBrowser.getBrowserForTab(tab)?.currentURI?.spec || "");
    const fixtureUrls = urls.filter((url) => url.startsWith("http://"));
    return { urls: urls.slice(0, 6), fixtureCount: fixtureUrls.length };
  `);
  return { done: state.fixtureCount >= expectedTabs, state };
}, "Zen did not attach fixture URLs to tabs");

/**
 * Drive a real UI click on `.zao-organize-button` / `#tab-wand-button`.
 * Falls back to command invocation only when `fallbackToCommand` is explicitly true.
 */
export const clickWand = async (marionette, { fallbackToCommand = false } = {}) => {
  const result = await marionette.executeAsync(`
    const done = arguments[arguments.length - 1];
    const fallbackToCommand = ${JSON.stringify(Boolean(fallbackToCommand))};
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const doc = win?.document;
    if (!doc) {
      done({ error: "No active navigator:browser document" });
      return;
    }

    const activeWs = win.gZenWorkspaces?.activeWorkspaceElement;
    const candidates = [
      ...(activeWs ? activeWs.querySelectorAll(".zao-organize-button, #tab-wand-button") : []),
      ...doc.querySelectorAll(".zao-organize-button, #tab-wand-button"),
    ].filter((el, idx, arr) => el && el.isConnected && !el.closest("zen-library") && arr.indexOf(el) === idx);

    const visibleButton = candidates.find((el) => {
      if (el.disabled) return false;
      const rect = el.getBoundingClientRect?.();
      return rect && rect.width > 0 && rect.height > 0;
    }) || candidates.find((el) => !el.disabled);

    if (visibleButton) {
      visibleButton.dispatchEvent(new win.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        view: win,
      }));
      done({ clickedButton: true, buttonId: visibleButton.id || "", className: visibleButton.className || "" });
      return;
    }

    if (!fallbackToCommand) {
      done({ error: "No enabled .zao-organize-button / #tab-wand-button found to click (pass fallbackToCommand: true to invoke command directly)" });
      return;
    }

    const cmd = doc.getElementById("cmd_zenAutoOrganize");
    if (cmd && typeof cmd.doCommand === "function") {
      cmd.doCommand();
      done({ commandFallback: true });
      return;
    }

    if (typeof win.ZenTabSorting?.handleOrganizeClick === "function") {
      win.ZenTabSorting.handleOrganizeClick()
        .then(() => done({ commandFallback: true, directHandler: true }))
        .catch((error) => done({ error: error?.stack || error?.message || String(error) }));
      return;
    }

    done({ error: "Neither wand button nor fallback command is available" });
  `);
  if (result?.error) throw new Error(result.error);
  if (!result?.clickedButton && !result?.commandFallback) {
    throw new Error(`Zen wand activation did not succeed: ${JSON.stringify(result)}`);
  }
  return result;
};

const waitForSortedState = async (marionette, scenarioName, expectedTabs) => waitUntil(async () => {
  const state = await collectSortedState(marionette);
  return { done: !state.thinking && !state.sessionActive && state.groupedTabs >= expectedTabs, state };
}, `${scenarioName} did not produce the expected tab groups`);

const collectSortedState = async (marionette) => await marionette.execute(`
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const tabState = (tab) => {
    const spec = win.gBrowser.getBrowserForTab(tab)?.currentURI?.spec || "";
    let id = "";
    try {
      const url = new URL(spec);
      id = url.pathname.split("/").filter(Boolean).at(-1) || "";
    } catch {}
    return {
      id,
      title: tab.getAttribute("label") || "",
      url: spec,
    };
  };
  const groups = [...win.document.querySelectorAll("tab-group:not([split-view-group])")]
    .filter((group) => !group.closest("zen-library"))
    .map((group) => ({
      label: group.getAttribute("label") || "",
      tabs: group.querySelectorAll("tab").length,
      tabItems: [...group.querySelectorAll("tab")].map(tabState),
    }));
  const workspaceId = win.gZenWorkspaces.activeWorkspace;
  const workspaceTabs = [...win.gBrowser.tabs].filter((tab) => tab.getAttribute("zen-workspace-id") === workspaceId);
  const eligibleLikeTabs = workspaceTabs.filter((tab) =>
    tab.isConnected &&
    !tab.pinned &&
    !tab.hasAttribute("zen-empty-tab") &&
    !tab.hasAttribute("zen-glance-tab") &&
    !tab.hasAttribute("zen-essential")
  );
  const wandButton = win.document.querySelector(".zao-organize-button, #tab-wand-button");
  return {
    groups,
    groupedTabs: groups.reduce((sum, group) => sum + group.tabs, 0),
    predictedGroups: groups.map((group) => ({ label: group.label, tabs: group.tabItems })),
    workspaceId,
    workspaceTabs: workspaceTabs.length,
    eligibleLikeTabs: eligibleLikeTabs.length,
    emptyTabs: workspaceTabs.filter((tab) => tab.hasAttribute("zen-empty-tab")).length,
    lastRun: win.ZenTabSortingLastRun || null,
    sampleUrls: workspaceTabs.slice(0, 6).map((tab) => win.gBrowser.getBrowserForTab(tab)?.currentURI?.spec || ""),
    aiEngine: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-engine", "missing"),
    aiFallbackProvider: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-fallback-provider", "missing"),
    aiSortMode: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-sort-mode", "missing"),
    aiConsent: Services.prefs.getBoolPref("extensions.zen-auto-organize.ai-provider-consent", false),
    customEndpoint: Services.prefs.getStringPref("extensions.zen-auto-organize.ai-custom-endpoint", "missing"),
    thinking: Boolean(
      wandButton?.classList?.contains("zao-thinking") ||
      wandButton?.getAttribute("aria-busy") === "true"
    ),
    sessionActive: Boolean(win._zaoSortSession),
    hasCommand: !!win.document.getElementById("cmd_zenAutoOrganize"),
    hasListener: !!win.document.querySelector("commandset#zenCommandSet")?._zaoCommandListener,
    tabs: win.gBrowser.tabs.length,
  };
`);

export const waitUntil = async (probe, message, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await probe();
    last = result?.state ?? result;
    if (result?.done) return result.state;
    await delay(500);
  }
  throw new Error(`${message}; last state: ${JSON.stringify(last)}`);
};
