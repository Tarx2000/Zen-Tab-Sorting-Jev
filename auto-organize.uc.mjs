// Zen Tab Sorting — entry point.
// Loaded by Sine in both `chrome://browser/content/browser.xhtml` (the main browser
// window) and `about:preferences*` (the settings page). Branches on window.location
// and dynamically imports only the modules required for the active context.

import { CONFIG, LOG, BUILD_VERSION } from "./modules/config.mjs";
import {
  getDebugEvents,
  clearDebugEvents,
  formatDebugEventsAsText,
  flushDebugJournal,
} from "./modules/debug-journal.mjs";

const url = window.location.href;
const isBrowserContext = url === "chrome://browser/content/browser.xhtml";
const isPrefsContext =
  url.startsWith("about:preferences") ||
  url.includes("preferences") ||
  url.includes("paneSineMods") ||
  url.startsWith("chrome://browser/content/preferences/");

const OLLAMA_WARMUP_COOLDOWN_MS = 5 * 60 * 1000;

let initInterval = null;
let initialized = false;
let cleanedUp = false;
const teardownSteps = [];

const registerTeardown = (name, fn) => {
  if (typeof fn === "function") teardownSteps.push([name, fn]);
};

const runSafeInit = (name, fn) => {
  try {
    fn();
  } catch (e) {
    console.error(`${LOG} init error in ${name}:`, e);
  }
};

const runSafeTeardown = (name, fn) => {
  try {
    fn();
  } catch (e) {
    console.error(`${LOG} teardown error in ${name}:`, e);
  }
};

const shouldWarmupOllama = () => {
  const now = Date.now();
  try {
    const windows = globalThis.Services?.wm?.getEnumerator?.("navigator:browser");
    if (windows) {
      while (windows.hasMoreElements()) {
        const win = windows.getNext();
        if (win?._zaoOllamaWarmupAt && now - win._zaoOllamaWarmupAt < OLLAMA_WARMUP_COOLDOWN_MS) {
          return false;
        }
      }
    }
  } catch {}
  window._zaoOllamaWarmupAt = now;
  return true;
};

const isBrowserReady = (domCache) => {
  if (window.closed) return false;
  const commandSetExists = Boolean(domCache.getCommandSet());
  const gBrowserReady = typeof gBrowser !== "undefined" && Boolean(gBrowser?.tabContainer);
  const gZenWorkspacesReady = typeof window.gZenWorkspaces !== "undefined";
  return gBrowserReady && commandSetExists && gZenWorkspacesReady;
};

let browserModulesPromise = null;
const loadBrowserModules = () => {
  if (!browserModulesPromise) {
    browserModulesPromise = Promise.all([
      import("./modules/hybrid-preferences.mjs"),
      import("./modules/provider-settings.mjs"),
      import("./modules/tabs.mjs"),
      import("./modules/rules.mjs"),
      import("./modules/groups.mjs"),
      import("./modules/browser-ui.mjs"),
      import("./modules/group-drag.mjs"),
      import("./modules/group-state.mjs"),
      import("./modules/browser-hooks.mjs"),
      import("./modules/sort-session.mjs"),
      import("./modules/workspace-sort.mjs"),
    ]).then(([
      hybridPrefs,
      providerSettings,
      tabs,
      rules,
      groups,
      browserUi,
      groupDrag,
      groupState,
      browserHooks,
      sortSession,
      workspaceSort,
    ]) => ({
      hybridPrefs,
      providerSettings,
      tabs,
      rules,
      groups,
      browserUi,
      groupDrag,
      groupState,
      browserHooks,
      sortSession,
      workspaceSort,
    }));
  }
  return browserModulesPromise;
};

const initializeOnce = (mods) => {
  if (initialized || cleanedUp || window.closed) return true;
  initialized = true;

  const {
    hybridPrefs,
    providerSettings,
    tabs,
    rules,
    groups,
    browserUi,
    groupDrag,
    groupState,
    browserHooks,
    sortSession,
    workspaceSort,
  } = mods;

  // Register teardowns up front so cleanup always covers every subsystem.
  registerTeardown("sort-session", () => sortSession.abortSortSession(window));
  registerTeardown("dom-cache", () => tabs.domCache.invalidate());
  registerTeardown("tab-context-menu", () => browserHooks.teardownTabContextMenu(window));
  registerTeardown("tab-group-context-menu", () => browserHooks.teardownTabGroupContextMenu(window));
  registerTeardown("tab-group-create-hook", () => browserHooks.teardownTabGroupCreateHook(window));
  registerTeardown("collapsed-state", () => browserHooks.teardownCollapsedStatePersistence(window));
  registerTeardown("workspace-sort-menu", () => workspaceSort.teardownWorkspaceSortMenu(window));
  registerTeardown("organize-ui", () => browserUi.teardownOrganizeUI());
  registerTeardown("group-drag", () => groupDrag.teardownGroupDrag(window));
  registerTeardown("group-state", () => groupState.teardownGroupState(window));
  registerTeardown("minimal-style-observer", () => browserHooks.teardownMinimalStylePrefObserver(window));

  runSafeInit("hybrid-preferences", () => hybridPrefs.ensureHybridPreferences(Services.prefs));
  runSafeInit("command", () => browserUi.setupCommand());
  runSafeInit("separators", () => browserUi.addButtonToAllSeparators());
  runSafeInit("workspace-hooks", () => browserUi.setupWorkspaceHooks());
  runSafeInit("workspace-sort-menu", () => workspaceSort.setupWorkspaceSortMenu(window));
  runSafeInit("group-drag", () => groupDrag.setupGroupDrag(window));
  runSafeInit("tab-context-menu", () => browserHooks.setupTabContextMenu(window));
  runSafeInit("tab-group-context-menu", () => browserHooks.setupTabGroupContextMenu(window));
  // applyExisting: false avoids duplicating the startup syncAllGroupColors pass below.
  runSafeInit("tab-group-create-hook", () => browserHooks.setupTabGroupCreateHook(window, { applyExisting: false }));
  runSafeInit("group-state", () => groupState.setupGroupState(window));
  runSafeInit("collapsed-state-migration", () => browserHooks.setupCollapsedStatePersistence(window));
  runSafeInit("minimal-style-observer", () => browserHooks.setupMinimalStylePrefObserver(window));

  // Lazy-load heavy click-handler only when invoked.
  runSafeInit("public-api", () => {
    window.ZenTabSorting = Object.freeze({
      buildVersion: BUILD_VERSION,
      getDebugEvents,
      clearDebugEvents,
      formatDebugEventsAsText,
      organizeWorkspaces: async () => {
        const mod = await import("./modules/workspace-sort.mjs");
        return mod.organizeWorkspaces(window);
      },
      handleOrganizeClick: async () => {
        window.ZenTabSortingLastRun = {
          startedAt: Date.now(),
          finished: false,
          before: {
            eligibleTabs: tabs.getEligibleTabs().tabs.length,
            aiEngine: rules.getAIEngine(),
            aiSortMode: rules.getAISortMode(),
          },
        };
        try {
          const { handleOrganizeClick } = await import("./modules/click-handler.mjs");
          await handleOrganizeClick();
          window.ZenTabSortingLastRun.finished = true;
        } catch (e) {
          window.ZenTabSortingLastRun.error = e?.stack || e?.message || String(e);
          throw e;
        }
        return window.ZenTabSortingLastRun;
      },
    });
  });

  // Single deduplicated startup color sync across workspaces.
  runSafeInit("startup-color-sync", () => {
    const savedRules = rules.readRulesPref();
    if (savedRules) groups.syncAllGroupColors(null, savedRules);
  });

  // Optional Ollama warmup with cross-window cooldown & lazy module load.
  runSafeInit("ollama-warmup", () => {
    if (
      providerSettings.readFallbackProviderSettings(Services.prefs).provider === "ollama" &&
      rules.isOllamaWarmupEnabled() &&
      shouldWarmupOllama()
    ) {
      import("./modules/ollama.mjs")
        .then(({ warmupOllama }) => warmupOllama(rules.getOllamaHost(), rules.getOllamaModel()))
        .catch(() => {});
    }
  });

  console.log(`${LOG} initialized (browser) — build ${BUILD_VERSION}`);
  return true;
};

const initializeBrowserScript = async () => {
  try {
    const mods = await loadBrowserModules();
    if (cleanedUp || window.closed) return;
    if (isBrowserReady(mods.tabs.domCache)) {
      initializeOnce(mods);
      return;
    }
    let checkCount = 0;
    initInterval = setInterval(() => {
      if (cleanedUp || window.closed) {
        clearInterval(initInterval);
        initInterval = null;
        return;
      }
      checkCount++;
      if (isBrowserReady(mods.tabs.domCache)) {
        clearInterval(initInterval);
        initInterval = null;
        initializeOnce(mods);
      } else if (checkCount > CONFIG.MAX_INIT_CHECKS) {
        clearInterval(initInterval);
        initInterval = null;
        console.warn(`${LOG} init timed out`);
      }
    }, CONFIG.INIT_CHECK_INTERVAL);
  } catch (e) {
    console.error(`${LOG} failed to load browser modules:`, e);
  }
};

const initializePrefsScript = async () => {
  try {
    const { setupSettingsObserver, teardownSettingsObserver } = await import("./modules/prefs-ui.mjs");
    if (cleanedUp || window.closed) return;
    registerTeardown("settings-observer", () => teardownSettingsObserver());
    console.log(`${LOG} initialized (preferences) at ${url}`);
    runSafeInit("settings-observer", () => setupSettingsObserver());
  } catch (e) {
    console.error(`${LOG} failed to load preferences modules:`, e);
  }
};

const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;

  if (initInterval !== null) {
    clearInterval(initInterval);
    initInterval = null;
  }

  if (window._zaoDoneTimer) {
    try { window.clearTimeout?.(window._zaoDoneTimer); } catch {}
    delete window._zaoDoneTimer;
  }

  if (window._zaoSortSession?.controller) {
    try { window._zaoSortSession.controller.abort(); } catch {}
  }

  runSafeTeardown("debug-journal-flush", () => flushDebugJournal());

  while (teardownSteps.length > 0) {
    const [name, fn] = teardownSteps.pop();
    runSafeTeardown(name, fn);
  }
};

const entryPoint = () => {
  if (cleanedUp || window.closed) return;
  if (isBrowserContext) {
    void initializeBrowserScript();
  } else if (isPrefsContext) {
    void initializePrefsScript();
  }
};

if (document.readyState === "complete") {
  entryPoint();
} else {
  window.addEventListener("load", entryPoint, { once: true });
}
window.addEventListener("unload", cleanup, { once: true });
window.addEventListener("beforeunload", cleanup, { once: true });
