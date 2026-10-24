// Zen Tab Sorting — preferences-context setup.
// Watches for Sine's per-mod settings dialog and injects the rules editor widget,
// Sign in with ChatGPT (SIWC) widget, and JEV / provider test controls.

import { CONFIG, LOG, DEFAULT_RULES, BUILD_VERSION, h } from "./config.mjs";
import { ensureHybridPreferences } from "./hybrid-preferences.mjs";
import { organizeSettingsLayout, maskProviderKeys, setupNewGroupStrengthControl } from "./settings-layout.mjs";
import {
  readRulesPref,
  writeRulesPref,
  isDomainRulesEnabled,
} from "./rules.mjs";
import {
  buildRulesEditor,
  buildSkipDomainsEditor,
  buildBackupRestoreSection,
  teardownRulesPrefObserver,
  teardownSkipPrefObserver,
} from "./widget.mjs";
import { fetchZenColorsFromBrowser } from "./color-picker.mjs";
import { testProviderConnection } from "./remote-provider.mjs";
import { testJevConnection, defaultJevModelForProvider } from "./jev.mjs";
import { getDebugEvents, clearDebugEvents, formatDebugEventsAsText, isDebugMode } from "./debug-journal.mjs";
import {
  readChatGPTSession,
  clearChatGPTSession,
  startChatGPTSignInFlow,
  fetchChatGPTModels,
  ensureValidChatGPTToken,
} from "./chatgpt-auth.mjs";

console.log(`[ZenTabSort] prefs-ui.mjs loaded — v${BUILD_VERSION}`);

let settingsObserver = null;

const isOurDialog = (dialog) => {
  if (!dialog) return false;
  if (dialog.closest?.('.sineItem[mod-id="zen-tab-sorting"]')) return true;
  if (dialog.querySelector(".zao-rules-editor, .zao-chatgpt-signin, .zao-provider-test")) return true;
  const title = dialog.querySelector(".sineItemTitle")?.textContent || "";
  if (title.includes("Zen Tab Sorting")) return true;
  for (const lbl of dialog.querySelectorAll(".separator-label")) {
    const text = lbl.textContent.trim();
    if (
      text.startsWith("Group Rules") ||
      text.startsWith("Rules") ||
      text.startsWith("AI Sorting") ||
      text.startsWith("Skip Domains") ||
      text.startsWith("Backup & Restore") ||
      text.startsWith("Look & Feel")
    ) {
      return true;
    }
  }
  return false;
};

const injectStylesheet = async () => {
  try {
    const res = await fetch(new URL("../userChrome.css", import.meta.url).href, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const css = await res.text();
    const existing = document.querySelector("style[data-zao-style]");
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.setAttribute("data-zao-style", "1");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {
    console.warn(`${LOG} failed to inject stylesheet:`, e);
  }
};

const SECTION_DESCRIPTIONS = [
  ["AI Sorting", "Jev places tabs into existing groups. Your chosen LLM creates new groups for the remaining tabs. Both stages are part of every normal sort."],
  ["1. Existing groups", "Choose the Jev service and model used to recognize your existing groups. The same Jev configuration also powers sorting between Spaces."],
  ["Jev confidence", "Enter confidence as 0.70 or 70%, and the lead as 0.15 or 15 percentage points. These thresholds apply to existing groups. For moving between Spaces, the destination must instead score more than 10 percentage points above the current Space."],
  ["2. New groups", "Choose the LLM for tabs that Jev could not place. Only this provider’s connection and model settings are shown. New groups contain at least two tabs."],
  ["3. Sorting behavior", "Keep existing groups and sort loose tabs, or reconsider all tabs. Preview mode lets you review new groups before anything moves."],
  ["Group Rules", "Optional: match domains to saved groups before Jev runs. Leave this off for sorting by context."],
  ["Skip Domains", "Exclude sites from sorting. In a normal sort, matching tabs stay loose at the top. When sorting between Spaces, a matching member keeps the entire group in its current Space."],
  ["Backup & Restore", "Export or import your domain rules and excluded sites. Provider keys and account credentials are not part of this backup."],
  ["Look & Feel", "Choose how tab groups appear in the sidebar."],
];

const tagSeparatorContainers = (dialog) => {
  for (const lbl of dialog.querySelectorAll(".separator-label")) {
    const container = lbl.closest("vbox") || lbl.parentElement;
    container?.classList?.add("zao-section-header-row");
  }
};

const injectSectionDescriptions = (dialog) => {
  const seps = Array.from(dialog.querySelectorAll(".separator-label"));
  for (const [prefix, text] of SECTION_DESCRIPTIONS) {
    const sep = seps.find((lbl) => lbl.textContent.trim().startsWith(prefix));
    if (!sep) continue;
    const container = sep.closest("vbox") || sep.parentElement;
    if (container.nextElementSibling?.classList?.contains("zao-pref-description")) continue;
    const desc = h("div");
    desc.className = "zao-pref-description";
    desc.textContent = text;
    container.parentNode.insertBefore(desc, container.nextSibling);
  }
};

const findPrefRow = (dialog, prefName) => {
  const id = prefName.replace(/\./g, "-");
  return dialog.querySelector(`#${CSS.escape(id)}`);
};

const filterDropdownOptions = (row, validValues) => {
  if (!row) return;
  const items = [
    ...row.querySelectorAll("option"),
    ...row.querySelectorAll("menuitem"),
    ...row.querySelectorAll("[data-value]"),
    ...row.querySelectorAll('[role="option"]'),
  ];
  if (items.length === 0) return;
  for (const item of items) {
    const v = item.getAttribute("value") || item.getAttribute("data-value");
    if (v == null) continue;
    const allow = validValues.has(v);
    item.hidden = !allow;
    item.style.display = allow ? "" : "none";
  }
};

const getFallbackProviderPref = () => {
  try {
    return Services.prefs.getStringPref(CONFIG.AI_FALLBACK_PROVIDER_PREF, "chatgpt").trim() || "chatgpt";
  } catch {
    return "chatgpt";
  }
};

const updateConditionalFields = (dialog) => {
  const activeLlm = getFallbackProviderPref();
  const domainRulesOn = isDomainRulesEnabled();
  const setHidden = (row, hidden) => row?.classList.toggle("zao-pref-hidden", hidden);
  // The pipeline is fixed; old cached Sine dialogs must not offer a second
  // competing engine selector either.
  setHidden(findPrefRow(dialog, CONFIG.AI_ENGINE_PREF), true);
  setHidden(dialog.querySelector(".zao-rules-editor"), !domainRulesOn);
  setHidden(findPrefRow(dialog, CONFIG.STRICT_RULES_PREF), !domainRulesOn);
  setHidden(findPrefRow(dialog, CONFIG.AI_EXISTING_BEHAVIOR_PREF), !domainRulesOn);
  if (!domainRulesOn && Services.prefs.getStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "") === "auto-add") {
    Services.prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "transient");
  }
  filterDropdownOptions(findPrefRow(dialog, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF),
    new Set(domainRulesOn ? ["transient", "identify-only", "auto-add"] : ["transient", "identify-only"]));

  const fields = {
    chatgpt: [CONFIG.AI_CHATGPT_MODEL_PREF],
    primalabs: [CONFIG.AI_PRIMALABS_ENDPOINT_PREF, CONFIG.AI_PRIMALABS_API_KEY_PREF, CONFIG.AI_PRIMALABS_MODEL_PREF],
    openai: [CONFIG.AI_OPENAI_ENDPOINT_PREF, CONFIG.AI_OPENAI_API_KEY_PREF, CONFIG.AI_OPENAI_MODEL_PREF],
    gemini: [CONFIG.AI_GEMINI_API_KEY_PREF, CONFIG.AI_GEMINI_MODEL_PREF],
    ollama: [CONFIG.AI_OLLAMA_HOST_PREF, CONFIG.AI_OLLAMA_MODEL_PREF, CONFIG.AI_OLLAMA_WARMUP_PREF],
    custom: [CONFIG.AI_CUSTOM_FORMAT_PREF, CONFIG.AI_CUSTOM_ENDPOINT_PREF, CONFIG.AI_CUSTOM_API_KEY_PREF, CONFIG.AI_CUSTOM_MODEL_PREF],
  };
  for (const [provider, properties] of Object.entries(fields)) {
    for (const pref of properties) setHidden(findPrefRow(dialog, pref), activeLlm !== provider);
  }
  setHidden(dialog.querySelector(".zao-chatgpt-signin"), activeLlm !== "chatgpt");
  dialog.querySelector(".zao-chatgpt-signin")?._zaoRefreshState?.();
  for (const name of [CONFIG.AI_JEV_MODEL_PREF, CONFIG.AI_CHATGPT_MODEL_PREF]) {
    const input = findPrefRow(dialog, name)?.querySelector("input");
    if (input && document.activeElement !== input) input.value = Services.prefs.getStringPref(name, input.value);
  }
  for (const name of [CONFIG.AI_JEV_PROVIDER_PREF, CONFIG.AI_FALLBACK_PROVIDER_PREF,
    CONFIG.AI_SORT_MODE_PREF, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF]) {
    const menu = findPrefRow(dialog, name)?.querySelector("menulist");
    if (!menu) continue;
    const value = Services.prefs.getStringPref(name, menu.getAttribute("value") || "");
    const item = [...menu.querySelectorAll("menuitem")].find(item => item.getAttribute("value") === value);
    if (item) {
      menu.setAttribute("value", value);
      menu.setAttribute("label", item.getAttribute("label"));
    }
  }
};

const OBSERVED_PREFS = [
  CONFIG.AI_ENGINE_PREF,
  CONFIG.AI_FALLBACK_PROVIDER_PREF,
  CONFIG.AI_JEV_PROVIDER_PREF,
  CONFIG.USE_DOMAIN_RULES_PREF,
  CONFIG.PIP_SHAPE_PREF,
  CONFIG.AI_CHATGPT_SESSION_PREF,
  CONFIG.AI_CHATGPT_MODEL_PREF,
  CONFIG.AI_JEV_MODEL_PREF,
  CONFIG.AI_SORT_MODE_PREF,
  CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF,
];

let enginePrefObserver = null;
const setupEnginePrefObserver = () => {
  if (enginePrefObserver) return;
  enginePrefObserver = {
    observe(_subject, topic, data) {
      if (topic !== "nsPref:changed") return;
      if (data === CONFIG.AI_JEV_PROVIDER_PREF) {
        try {
          const prov = Services.prefs.getStringPref(CONFIG.AI_JEV_PROVIDER_PREF, "typesafe");
          const curModel = Services.prefs.getStringPref(CONFIG.AI_JEV_MODEL_PREF, "").trim();
          if (
            !curModel ||
            curModel === CONFIG.AI_JEV_TYPESAFE_MODEL_DEFAULT ||
            curModel === CONFIG.AI_JEV_OPENROUTER_MODEL_DEFAULT
          ) {
            Services.prefs.setStringPref(CONFIG.AI_JEV_MODEL_PREF, defaultJevModelForProvider(prov));
          }
        } catch {}
      }
      for (const d of document.querySelectorAll(".sineItemPreferenceDialog")) {
        if (isOurDialog(d)) {
          updateConditionalFields(d);

          break;
        }
      }
    },
  };
  for (const pref of OBSERVED_PREFS) {
    try { Services.prefs.addObserver(pref, enginePrefObserver); } catch {}
  }
};

const teardownEnginePrefObserver = () => {
  if (!enginePrefObserver) return;
  for (const pref of OBSERVED_PREFS) {
    try { Services.prefs.removeObserver(pref, enginePrefObserver); } catch {}
  }
  enginePrefObserver = null;
};

const findSeparatorContainer = (dialog, prefix) => {
  for (const lbl of dialog.querySelectorAll(".separator-label")) {
    if (lbl.textContent.trim().startsWith(prefix)) {
      return lbl.closest("vbox") || lbl.parentElement;
    }
  }
  return null;
};

const insertAfter = (parent, newNode, refNode) => {
  if (refNode && refNode.parentNode === parent) {
    parent.insertBefore(newNode, refNode.nextSibling);
  } else {
    parent.insertBefore(newNode, parent.firstChild);
  }
};

// Interactive "Sign in with ChatGPT" widget for OpenAI SIWC subscription quota.
const buildChatGPTSignInSection = () => {
  const container = h("div", { class: "zao-chatgpt-signin" });

  const signInBtn = h("button", { text: "Sign in with ChatGPT" });
  signInBtn.className = "zao-backup-btn";

  const signOutBtn = h("button", { text: "Sign out" });
  signOutBtn.className = "zao-backup-btn";

  const loadModelsBtn = h("button", { text: "Load ChatGPT models" });
  loadModelsBtn.className = "zao-backup-btn";

  const modelSelect = h("select");
  modelSelect.style.marginLeft = "6px";
  modelSelect.hidden = true;

  const status = h("span", { class: "zao-provider-test-status" });
  container.append(signInBtn, signOutBtn, loadModelsBtn, modelSelect, status);

  const refreshState = () => {
    const session = readChatGPTSession(Services.prefs);
    const connected = Boolean(session && (session.accessToken || session.refreshToken));
    signOutBtn.hidden = !connected;
    loadModelsBtn.hidden = !connected;
    if (connected) {
      const who = session.email || session.subject || "ChatGPT account";
      status.textContent = `Signed in (${who})`;
      status.dataset.state = "ok";
      signInBtn.textContent = "Reconnect ChatGPT";
    } else {
      status.textContent = "Not signed in — click to authorize with your ChatGPT subscription.";
      status.removeAttribute("data-state");
      signInBtn.textContent = "Sign in with ChatGPT";
      modelSelect.hidden = true;
    }
  };

  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) {
      try {
        Services.prefs.setStringPref(CONFIG.AI_CHATGPT_MODEL_PREF, modelSelect.value);
        status.textContent = `Selected model: ${modelSelect.value}`;
        status.dataset.state = "ok";
      } catch {}
    }
  });

  loadModelsBtn.addEventListener("click", async () => {
    loadModelsBtn.disabled = true;
    status.textContent = "Loading available ChatGPT models…";
    try {
      const token = await ensureValidChatGPTToken(Services.prefs);
      const models = await fetchChatGPTModels(token);
      if (models.length === 0) {
        status.textContent = "No models returned by /v1/models; type model slug manually below.";
      } else {
        modelSelect.replaceChildren();
        const currentModel = Services.prefs.getStringPref(
          CONFIG.AI_CHATGPT_MODEL_PREF,
          CONFIG.AI_CHATGPT_MODEL_DEFAULT,
        );
        for (const m of models) {
          const opt = h("option", { text: `${m.label} (${m.id})` });
          opt.value = m.id;
          if (m.id === currentModel) opt.selected = true;
          modelSelect.appendChild(opt);
        }
        modelSelect.hidden = false;
        status.textContent = `Loaded ${models.length} model(s).`;
        status.dataset.state = "ok";
      }
    } catch (e) {
      status.textContent = `Failed to load models: ${e?.message || e}`;
      status.dataset.state = "err";
    } finally {
      loadModelsBtn.disabled = false;
    }
  });

  signInBtn.addEventListener("click", async () => {
    signInBtn.disabled = true;
    try {
      const session = await startChatGPTSignInFlow({
        prefs: Services.prefs,
        onStatus: (msg) => {
          status.textContent = msg;
          status.removeAttribute("data-state");
        },
      });
      // Automatically enable data-sending consent when the user signs in with ChatGPT
      try {
        Services.prefs.setBoolPref(CONFIG.AI_PROVIDER_CONSENT_PREF, true);
      } catch {}
      refreshState();
      if (session?.accessToken) {
        loadModelsBtn.click();
      }
    } catch (e) {
      status.textContent = `Sign-in failed: ${e?.message || e}`;
      status.dataset.state = "err";
    } finally {
      signInBtn.disabled = false;
    }
  });

  signOutBtn.addEventListener("click", () => {
    clearChatGPTSession(Services.prefs);
    refreshState();
  });

  container._zaoRefreshState = refreshState;
  refreshState();
  return container;
};

const buildProviderTestSection = (stage) => {
  const isJev = stage === "jev";
  const container = h("div", { class: `zao-provider-test zao-${stage}-test` });
  const button = h("button", { text: isJev ? "Test Jev connection" : "Test LLM connection", class: "zao-backup-btn" });
  const status = h("span", { class: "zao-provider-test-status" });
  status.setAttribute("role", "status");
  container.append(button, status);
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Testing…";
    status.removeAttribute("data-state");
    try {
      const result = await (isJev ? testJevConnection() : testProviderConnection());
      status.dataset.state = result.ok ? "ok" : "err";
      status.textContent = result.ok ? "Connected — provider replied."
        : result.reason === "consent_required" ? "Allow sending tab data in AI Sorting first."
        : result.reason === "missing_required_config" ? (isJev ? "Enter your Jev API key first." : `Complete the provider settings: ${(result.missingFields || []).join(", ")}.`)
        : `Connection failed: ${result.error || result.reason}`;
    } catch (error) {
      status.textContent = `Connection failed: ${error?.message || error}`;
      status.dataset.state = "err";
    } finally { button.disabled = false; }
  });
  return container;
};

const buildDebugLogsSection = (dialog) => {
  const card = h("div", { class: "zao-debug-logs-card" });

  // Top header with status label and toggle button
  const header = h("div", { class: "zao-debug-logs-header" });
  const status = h("span", {
    text: isDebugMode()
      ? `Debug-Modus: Aktiviert (${getDebugEvents().length} Logs)`
      : "Debug-Modus: Deaktiviert",
  });

  const toggleBtn = h("button", {
    text: isDebugMode() ? "Debug-Modus deaktivieren" : "Debug-Modus aktivieren",
  });
  toggleBtn.className = "zao-backup-btn zao-debug-toggle-btn";
  toggleBtn.dataset.active = isDebugMode() ? "true" : "false";

  header.append(status, toggleBtn);

  // Actions row with plain text labels (no icons / emojis)
  const actions = h("div", { class: "zao-debug-logs-actions" });

  const refreshBtn = h("button", { text: "Aktualisieren" });
  refreshBtn.className = "zao-backup-btn";

  const copyBtn = h("button", { text: "Logs kopieren" });
  copyBtn.className = "zao-backup-btn";

  const clearBtn = h("button", { text: "Leeren" });
  clearBtn.className = "zao-backup-btn";

  actions.append(refreshBtn, copyBtn, clearBtn);

  const viewer = h("textarea", { class: "zao-debug-logs-viewer" });
  viewer.setAttribute("readonly", "true");
  viewer.setAttribute("spellcheck", "false");
  viewer.value = formatDebugEventsAsText();

  const refreshViewer = () => {
    const active = isDebugMode();
    toggleBtn.textContent = active ? "Debug-Modus deaktivieren" : "Debug-Modus aktivieren";
    toggleBtn.dataset.active = active ? "true" : "false";
    status.textContent = active
      ? `Debug-Modus: Aktiviert (${getDebugEvents().length} Logs)`
      : "Debug-Modus: Deaktiviert";
    viewer.value = formatDebugEventsAsText();
  };

  toggleBtn.addEventListener("click", () => {
    const current = isDebugMode();
    try {
      Services?.prefs?.setBoolPref?.(CONFIG.DEBUG_MODE_PREF, !current);
    } catch (e) {
      console.warn(`${LOG} could not toggle debug mode pref:`, e);
    }
    const prefRow = findPrefRow(dialog, CONFIG.DEBUG_MODE_PREF);
    const cb = prefRow?.querySelector?.("input[type='checkbox'], checkbox");
    if (cb) cb.checked = !current;

    refreshViewer();
  });

  copyBtn.addEventListener("click", async () => {
    try {
      if (typeof navigator?.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText(viewer.value);
      }
      copyBtn.textContent = "Kopiert!";
      setTimeout(() => { copyBtn.textContent = "Logs kopieren"; }, 2000);
    } catch {
      copyBtn.textContent = "Fehler!";
      setTimeout(() => { copyBtn.textContent = "Logs kopieren"; }, 2000);
    }
  });

  refreshBtn.addEventListener("click", refreshViewer);
  clearBtn.addEventListener("click", () => {
    clearDebugEvents();
    refreshViewer();
  });

  card.append(header, actions, viewer);
  card._zaoRefreshLogs = refreshViewer;
  return card;
};

const performInject = (dialog) => {
  if (dialog.querySelector(".zao-rules-editor")) return;

  const content = dialog.querySelector(".sineItemPreferenceDialogContent");
  if (!content) return;

  ensureHybridPreferences(Services.prefs);

  // Do NOT pre-populate deterministic domain rules unless the user explicitly adds them.
  let initial = readRulesPref({ keepIncomplete: true });
  if (!initial) {
    initial = JSON.parse(JSON.stringify(DEFAULT_RULES));
  }

  const rulesEditor = buildRulesEditor(initial);
  const skipEditor = buildSkipDomainsEditor();
  const backupSection = buildBackupRestoreSection();
  const chatGptSection = buildChatGPTSignInSection();
  const jevTest = buildProviderTestSection("jev");
  const llmTest = buildProviderTestSection("llm");

  const rulesCheckboxRow = findPrefRow(dialog, CONFIG.USE_DOMAIN_RULES_PREF) || findSeparatorContainer(dialog, "Group Rules");
  insertAfter(content, rulesEditor, rulesCheckboxRow);
  insertAfter(content, skipEditor, findSeparatorContainer(dialog, "Skip Domains"));
  insertAfter(content, backupSection, findSeparatorContainer(dialog, "Backup & Restore"));

  insertAfter(content, jevTest, findPrefRow(dialog, CONFIG.AI_JEV_MODEL_PREF));
  insertAfter(content, chatGptSection, findPrefRow(dialog, CONFIG.AI_FALLBACK_PROVIDER_PREF));
  const behaviorHeader = findSeparatorContainer(dialog, "3. Sorting behavior");
  if (behaviorHeader) content.insertBefore(llmTest, behaviorHeader);
  else content.appendChild(llmTest);

  const debugLogsSection = buildDebugLogsSection(dialog);
  const debugSep = findSeparatorContainer(dialog, "Debug & Diagnostics");
  if (debugSep) {
    insertAfter(content, debugLogsSection, debugSep);
  } else {
    content.appendChild(debugLogsSection);
  }

  tagSeparatorContainers(dialog);
  injectSectionDescriptions(dialog);
  organizeSettingsLayout(dialog, content);
  maskProviderKeys(dialog);
  setupNewGroupStrengthControl(dialog);
  setupEnginePrefObserver();
  updateConditionalFields(dialog);
  console.log(`${LOG} injected rules + skip + backup + ChatGPT SIWC sections into Sine settings dialog`);
};

const onOurDialogFound = (dialog) => {
  dialog.classList.add("zao-our-dialog");

  if (dialog.querySelector(".zao-rules-editor")) {
    const editor = dialog.querySelector(".zao-rules-editor");
    editor?._zaoRefresh?.("dialog reopened");
    return;
  }

  if (!dialog._zaoOpenWatcher) {
    const watcher = new MutationObserver(() => {
      if (dialog.hasAttribute("open")) {
        const editor = dialog.querySelector(".zao-rules-editor");
        editor?._zaoRefresh?.("dialog open attr");
        dialog.querySelector(".zao-debug-logs-card")?._zaoRefreshLogs?.();
        updateConditionalFields(dialog);
      }
    });
    watcher.observe(dialog, { attributes: true, attributeFilter: ["open"] });
    dialog._zaoOpenWatcher = watcher;
  }

  injectStylesheet();

  let attempts = 0;
  const poll = () => {
    if (!dialog.isConnected) return;
    if (dialog.querySelector(".zao-rules-editor")) return;
    const content = dialog.querySelector(".sineItemPreferenceDialogContent");
    const hasPrefs = content && findPrefRow(dialog, CONFIG.DEBUG_MODE_PREF);
    if (hasPrefs) {
      try { performInject(dialog); }
      catch (e) { console.error(`${LOG} inject failed:`, e); }
      return;
    }
    attempts++;
    if (attempts >= CONFIG.INJECT_MAX_POLL_ATTEMPTS) {
      console.warn(`${LOG} Rules separator not found after ${attempts * CONFIG.INJECT_POLL_INTERVAL_MS}ms; injecting at content top`);
      try { performInject(dialog); }
      catch (e) { console.error(`${LOG} inject failed:`, e); }
      return;
    }
    setTimeout(poll, CONFIG.INJECT_POLL_INTERVAL_MS);
  };
  poll();
};

export const setupSettingsObserver = () => {
  if (settingsObserver) return;

  fetchZenColorsFromBrowser();

  const scanForOurDialog = (root) => {
    if (!root || root.nodeType !== 1) return;
    const dialogs = [];
    if (root.matches?.(".sineItemPreferenceDialog")) dialogs.push(root);
    root.querySelectorAll?.(".sineItemPreferenceDialog").forEach((d) => dialogs.push(d));
    for (const d of dialogs) {
      if (isOurDialog(d)) onOurDialogFound(d);
    }
  };

  settingsObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        scanForOurDialog(node);
      }
      if (m.target?.closest) {
        const dialog = m.target.closest(".sineItemPreferenceDialog");
        if (dialog && isOurDialog(dialog)) onOurDialogFound(dialog);
      }
    }
  });
  settingsObserver.observe(document.body, { childList: true, subtree: true });

  document.querySelectorAll(".sineItemPreferenceDialog").forEach((d) => {
    if (isOurDialog(d)) onOurDialogFound(d);
  });
  console.log(`${LOG} settings observer installed`);
};

export const teardownSettingsObserver = () => {
  if (settingsObserver) {
    settingsObserver.disconnect();
    settingsObserver = null;
  }
  teardownEnginePrefObserver();
  teardownRulesPrefObserver();
  teardownSkipPrefObserver();
};
