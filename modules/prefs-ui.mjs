// Zen Tab Sorting — preferences-context setup.
// Watches for Sine's per-mod settings dialog and injects the rules editor widget,
// Sign in with ChatGPT (SIWC) widget, and JEV / provider test controls.

import { CONFIG, LOG, DEFAULT_RULES, BUILD_VERSION, h } from "./config.mjs";
import {
  readRulesPref,
  writeRulesPref,
  getAIEngine,
  getPipShape,
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
    const res = await fetch(`${CONFIG.CSS_URL}?t=${Date.now()}`, { cache: "no-store" });
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
  [
    "Group Rules",
    "Deterministic domain rules are off by default so JEV and your Fallback-LLM sort dynamically by context. Enable the checkbox below only if you want static domain rules.",
  ],
  [
    "Skip Domains",
    "Hostnames in this list are never touched by the tidy click — matching tabs are ejected from any group and parked at the top of the workspace. Useful for tabs you want to always keep visible and ungrouped.",
  ],
  [
    "Backup & Restore",
    "Export your rules and skip list as JSON for safekeeping, or import a previously-saved file to restore them.",
  ],
  [
    "Look & Feel",
    "Tweaks to how grouped tabs render in Zen's sidebar.",
  ],
  [
    "AI Sorting",
    "JEV (Stage 1) classifies ungrouped tabs into your existing workspace groups; your Fallback-LLM (Stage 2) clusters remaining tabs into new groups in one shot.",
  ],
  [
    "Remote Provider Settings",
    "Configure Sign in with ChatGPT, PrimaLabs, OpenAI-compatible, Gemini, or custom providers. Leave AI engine off or use Local/Ollama for local-only sorting.",
  ],
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

const LOCAL_NEW_GROUP_BEHAVIORS = new Set(["auto-add", "transient", "fresh-categories"]);

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
  const engine = getAIEngine();
  const fallbackProvider = getFallbackProviderPref();
  const domainRulesOn = isDomainRulesEnabled();

  // Active LLM target is either the standalone engine or JEV's Fallback-LLM
  const activeLlm = engine === "jev" ? fallbackProvider : engine;
  const isLocalOrOllama = activeLlm === "local" || activeLlm === "ollama";
  const isRemoteProvider =
    engine === "jev" ||
    ["chatgpt", "primalabs", "openai", "gemini", "custom"].includes(activeLlm);

  const setHidden = (row, hidden) => {
    if (!row) return;
    row.classList.toggle("zao-pref-hidden", hidden);
  };

  // Hide the Group Rules editor widget unless the user explicitly enables deterministic domain rules
  setHidden(dialog.querySelector(".zao-rules-editor"), !domainRulesOn);
  setHidden(findPrefRow(dialog, CONFIG.STRICT_RULES_PREF), !domainRulesOn);

  // JEV fields (visible when engine === "jev")
  setHidden(findPrefRow(dialog, CONFIG.AI_JEV_PROVIDER_PREF), engine !== "jev");
  setHidden(findPrefRow(dialog, CONFIG.AI_JEV_API_KEY_PREF), engine !== "jev");
  setHidden(findPrefRow(dialog, CONFIG.AI_JEV_MODEL_PREF), engine !== "jev");
  setHidden(findPrefRow(dialog, CONFIG.AI_JEV_MIN_PROB_PREF), engine !== "jev");
  setHidden(findPrefRow(dialog, CONFIG.AI_JEV_MIN_MARGIN_PREF), engine !== "jev");
  setHidden(findPrefRow(dialog, CONFIG.AI_FALLBACK_PROVIDER_PREF), engine !== "jev");

  // Domain-rule mutation behaviors (only relevant when domain rules are enabled)
  setHidden(findPrefRow(dialog, CONFIG.AI_EXISTING_BEHAVIOR_PREF), !domainRulesOn || engine !== "ollama");
  const newGroupBehaviorRow = findPrefRow(dialog, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF);
  setHidden(newGroupBehaviorRow, !domainRulesOn && !isLocalOrOllama);
  if (engine === "local") {
    filterDropdownOptions(newGroupBehaviorRow, LOCAL_NEW_GROUP_BEHAVIORS);
    try {
      const current = Services.prefs.getStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "");
      if (current && !LOCAL_NEW_GROUP_BEHAVIORS.has(current)) {
        Services.prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "transient");
      }
    } catch {}
  } else if (engine === "ollama") {
    filterDropdownOptions(
      newGroupBehaviorRow,
      new Set(["auto-add", "transient", "prompt", "fresh-categories", "identify-only"]),
    );
  }

  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_HOST_PREF), activeLlm !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_MODEL_PREF), activeLlm !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_OLLAMA_WARMUP_PREF), activeLlm !== "ollama");
  setHidden(findPrefRow(dialog, CONFIG.AI_LOCAL_BATCH_SIZE_PREF), !isLocalOrOllama);
  setHidden(findPrefRow(dialog, CONFIG.AI_SORT_MODE_PREF), !domainRulesOn || engine === "off");
  setHidden(findPrefRow(dialog, CONFIG.AI_PROVIDER_CONSENT_PREF), !isRemoteProvider);

  // ChatGPT (Sign in with ChatGPT) fields
  setHidden(dialog.querySelector(".zao-chatgpt-signin"), activeLlm !== "chatgpt");
  setHidden(findPrefRow(dialog, CONFIG.AI_CHATGPT_MODEL_PREF), activeLlm !== "chatgpt");

  // PrimaLabs fields
  setHidden(findPrefRow(dialog, CONFIG.AI_PRIMALABS_ENDPOINT_PREF), activeLlm !== "primalabs");
  setHidden(findPrefRow(dialog, CONFIG.AI_PRIMALABS_API_KEY_PREF), activeLlm !== "primalabs");
  setHidden(findPrefRow(dialog, CONFIG.AI_PRIMALABS_MODEL_PREF), activeLlm !== "primalabs");

  // OpenAI-compatible fields
  setHidden(findPrefRow(dialog, CONFIG.AI_OPENAI_ENDPOINT_PREF), activeLlm !== "openai");
  setHidden(findPrefRow(dialog, CONFIG.AI_OPENAI_API_KEY_PREF), activeLlm !== "openai");
  setHidden(findPrefRow(dialog, CONFIG.AI_OPENAI_MODEL_PREF), activeLlm !== "openai");

  // Gemini fields
  setHidden(findPrefRow(dialog, CONFIG.AI_GEMINI_API_KEY_PREF), activeLlm !== "gemini");
  setHidden(findPrefRow(dialog, CONFIG.AI_GEMINI_MODEL_PREF), activeLlm !== "gemini");

  // Custom fields
  setHidden(findPrefRow(dialog, CONFIG.AI_CUSTOM_ENDPOINT_PREF), activeLlm !== "custom");
  setHidden(findPrefRow(dialog, CONFIG.AI_CUSTOM_API_KEY_PREF), activeLlm !== "custom");
  setHidden(findPrefRow(dialog, CONFIG.AI_CUSTOM_MODEL_PREF), activeLlm !== "custom");
  setHidden(findPrefRow(dialog, CONFIG.AI_CUSTOM_FORMAT_PREF), activeLlm !== "custom");

  // Provider test buttons
  setHidden(dialog.querySelector(".zao-provider-test"), !isRemoteProvider);
  setHidden(dialog.querySelector(".zao-jev-test-btn"), engine !== "jev");

// Pip settings removed in favor of native Zen folder rendering
};

const COUNTDOWN_SECONDS = 3;

const showAckModal = ({ ackPref, contentNodes, logTag }) => {
  let alreadyAck = false;
  try { alreadyAck = Services.prefs.getBoolPref(ackPref, false); } catch {}
  if (alreadyAck) return;
  if (document.querySelector(".zao-warning-dialog[open]")) return;

  const modal = h("dialog", { class: "zao-warning-dialog" });
  for (const n of contentNodes) modal.appendChild(n);

  const actions = h("div", { class: "zao-warning-actions" });
  const btn = h("button", { class: "zao-warning-confirm" });
  btn.type = "button";
  btn.setAttribute("disabled", "true");
  let remaining = COUNTDOWN_SECONDS;
  const updateLabel = () => {
    btn.textContent = remaining > 0 ? `${remaining}  I Understand` : "I Understand";
  };
  updateLabel();
  const tick = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(tick);
      btn.removeAttribute("disabled");
    }
    updateLabel();
  }, 1000);

  btn.addEventListener("click", () => {
    if (btn.hasAttribute("disabled")) return;
    try { Services.prefs.setBoolPref(ackPref, true); }
    catch (e) { console.warn(`${LOG} failed to set ${ackPref}:`, e); }
    try { modal.close(); } catch {}
    modal.remove();
  });
  modal.addEventListener("close", () => { clearInterval(tick); });

  actions.appendChild(btn);
  modal.appendChild(actions);
  document.documentElement.appendChild(modal);
  try {
    modal.showModal();
  } catch (e) {
    console.warn(`${LOG} [${logTag}] showModal() failed:`, e);
    modal.remove();
  }
};

const maybeShowOllamaWarning = () => {
  const title = h("h3", { class: "zao-warning-title", text: "Heads up: Ollama runs on your machine" });
  const lead = h("p", { class: "zao-warning-lead" });
  lead.appendChild(document.createTextNode("Ollama uses your computer's "));
  lead.appendChild(h("strong", { text: "RAM and VRAM" }));
  lead.appendChild(document.createTextNode(" to run AI models."));
  const list = h("ul", { class: "zao-warning-list" });
  const li1 = h("li");
  li1.appendChild(h("strong", { text: "Risk: " }));
  li1.appendChild(document.createTextNode("a model too big for your hardware can slow or crash your system."));
  const li2 = h("li");
  li2.appendChild(h("strong", { text: "Safe default: " }));
  li2.appendChild(document.createTextNode("qwen2.5:1.5b (~1 GB) — runs on most machines."));
  list.append(li1, li2);
  showAckModal({
    ackPref: CONFIG.OLLAMA_ACKNOWLEDGED_PREF,
    contentNodes: [title, lead, list],
    logTag: "ollama-warning",
  });
};

const maybeShowLocalWarning = () => {
  const title = h("h3", { class: "zao-warning-title", text: "Heads up: Local AI runs inside Firefox" });
  const lead = h("p", { class: "zao-warning-lead" });
  lead.appendChild(document.createTextNode("The Local engine uses "));
  lead.appendChild(h("strong", { text: "Firefox's built-in ML model" }));
  lead.appendChild(document.createTextNode(" — no extra setup, but it runs inside the browser."));
  const list = h("ul", { class: "zao-warning-list" });
  const li1 = h("li");
  li1.appendChild(h("strong", { text: "Risk: " }));
  li1.appendChild(document.createTextNode("with hundreds of tabs, the AI pass can briefly spike CPU and lag the browser."));
  list.appendChild(li1);
  showAckModal({
    ackPref: CONFIG.LOCAL_ACKNOWLEDGED_PREF,
    contentNodes: [title, lead, list],
    logTag: "local-warning",
  });
};

const OBSERVED_PREFS = [
  CONFIG.AI_ENGINE_PREF,
  CONFIG.AI_FALLBACK_PROVIDER_PREF,
  CONFIG.AI_JEV_PROVIDER_PREF,
  CONFIG.USE_DOMAIN_RULES_PREF,
  CONFIG.PIP_SHAPE_PREF,
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
          if (data === CONFIG.AI_ENGINE_PREF) {
            const engine = getAIEngine();
            if (engine === "ollama") maybeShowOllamaWarning();
            else if (engine === "local") maybeShowLocalWarning();
          }
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
  const container = h("div", { class: "zao-chatgpt-signin zao-provider-test" });

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

  refreshState();
  return container;
};

const buildProviderTestSection = () => {
  const container = h("div", { class: "zao-provider-test" });

  const jevButton = h("button", { text: "Test JEV" });
  jevButton.className = "zao-backup-btn zao-jev-test-btn";

  const button = h("button", { text: "Test connection" });
  button.className = "zao-backup-btn";

  const status = h("span", { class: "zao-provider-test-status" });
  container.append(jevButton, button, status);

  jevButton.addEventListener("click", async () => {
    jevButton.disabled = true;
    status.textContent = "Testing JEV…";
    status.removeAttribute("data-state");
    try {
      const result = await testJevConnection();
      if (result.ok) {
        status.textContent = `JEV Connected — ${result.reply}`;
        status.dataset.state = "ok";
      } else if (result.reason === "consent_required") {
        status.textContent = "Consent required — tick the data-sending checkbox above first.";
        status.dataset.state = "err";
      } else if (result.reason === "missing_required_config") {
        status.textContent = "Missing JEV API key.";
        status.dataset.state = "err";
      } else {
        status.textContent = `JEV Failed: ${result.error || result.reason}`;
        status.dataset.state = "err";
      }
    } catch (e) {
      status.textContent = `JEV Failed: ${e?.message || e}`;
      status.dataset.state = "err";
    } finally {
      jevButton.disabled = false;
    }
  });

  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "Testing…";
    status.removeAttribute("data-state");
    try {
      const result = await testProviderConnection();
      if (result.ok) {
        status.textContent = "Connected — provider replied.";
        status.dataset.state = "ok";
      } else if (result.reason === "consent_required") {
        status.textContent = "Consent required — tick the data-sending checkbox above first.";
        status.dataset.state = "err";
      } else if (result.reason === "missing_required_config") {
        status.textContent = `Missing: ${(result.missingFields || []).join(", ")}.`;
        status.dataset.state = "err";
      } else if (result.reason === "provider_disabled") {
        status.textContent = "Select a remote AI engine or Fallback-LLM first.";
        status.dataset.state = "err";
      } else {
        status.textContent = `Failed: ${result.error || result.reason}`;
        status.dataset.state = "err";
      }
    } catch (e) {
      status.textContent = `Failed: ${e?.message || e}`;
      status.dataset.state = "err";
    } finally {
      button.disabled = false;
    }
  });

  return container;
};

const buildDebugLogsSection = () => {
  const card = h("div", { class: "zao-debug-logs-card" });

  const header = h("div", { class: "zao-debug-logs-header" });
  const status = h("span", {
    text: isDebugMode()
      ? `Debug-Logs (aktiv — ${getDebugEvents().length} Einträge)`
      : "Debug-Logs (inaktiv — aktiviere \"Enable debug logging\" oben)",
  });
  const actions = h("div", { class: "zao-debug-logs-actions" });

  const refreshBtn = h("button", { text: "🔄 Aktualisieren" });
  refreshBtn.className = "zao-backup-btn";

  const copyBtn = h("button", { text: "📋 Logs kopieren" });
  copyBtn.className = "zao-backup-btn";

  const clearBtn = h("button", { text: "🗑️ Leeren" });
  clearBtn.className = "zao-backup-btn";

  actions.append(refreshBtn, copyBtn, clearBtn);
  header.append(status, actions);

  const viewer = h("textarea", { class: "zao-debug-logs-viewer" });
  viewer.setAttribute("readonly", "true");
  viewer.setAttribute("spellcheck", "false");
  viewer.value = formatDebugEventsAsText();

  const refreshViewer = () => {
    viewer.value = formatDebugEventsAsText();
    status.textContent = isDebugMode()
      ? `Debug-Logs (aktiv — ${getDebugEvents().length} Einträge)`
      : "Debug-Logs (inaktiv — aktiviere \"Enable debug logging\" oben)";
  };

  copyBtn.addEventListener("click", async () => {
    try {
      if (typeof navigator?.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText(viewer.value);
      }
      copyBtn.textContent = "✓ Kopiert!";
      setTimeout(() => { copyBtn.textContent = "📋 Logs kopieren"; }, 2000);
    } catch {
      copyBtn.textContent = "Fehler!";
      setTimeout(() => { copyBtn.textContent = "📋 Logs kopieren"; }, 2000);
    }
  });

  refreshBtn.addEventListener("click", refreshViewer);
  clearBtn.addEventListener("click", () => {
    clearDebugEvents();
    refreshViewer();
  });

  card.append(header, viewer);
  card._zaoRefreshLogs = refreshViewer;
  return card;
};

const performInject = (dialog) => {
  if (dialog.querySelector(".zao-rules-editor")) return;

  const content = dialog.querySelector(".sineItemPreferenceDialogContent");
  if (!content) return;

  // Do NOT pre-populate deterministic domain rules unless the user explicitly adds them.
  let initial = readRulesPref({ keepIncomplete: true });
  if (!initial) {
    initial = JSON.parse(JSON.stringify(DEFAULT_RULES));
  }

  const rulesEditor = buildRulesEditor(initial);
  const skipEditor = buildSkipDomainsEditor();
  const backupSection = buildBackupRestoreSection();
  const chatGptSection = buildChatGPTSignInSection();
  const testSection = buildProviderTestSection();

  const rulesCheckboxRow = findPrefRow(dialog, CONFIG.USE_DOMAIN_RULES_PREF) || findSeparatorContainer(dialog, "Group Rules");
  insertAfter(content, rulesEditor, rulesCheckboxRow);
  insertAfter(content, skipEditor, findSeparatorContainer(dialog, "Skip Domains"));
  insertAfter(content, backupSection, findSeparatorContainer(dialog, "Backup & Restore"));

  const fallbackRow = findPrefRow(dialog, CONFIG.AI_FALLBACK_PROVIDER_PREF);
  if (fallbackRow) {
    insertAfter(content, testSection, fallbackRow);
    insertAfter(content, chatGptSection, fallbackRow);
  } else {
    const remoteSep = findSeparatorContainer(dialog, "Remote Provider Settings") ||
                      findSeparatorContainer(dialog, "AI Sorting");
    insertAfter(content, testSection, remoteSep);
    insertAfter(content, chatGptSection, remoteSep);
  }

  const debugLogsSection = buildDebugLogsSection();
  const debugSep = findSeparatorContainer(dialog, "Debug & Diagnostics");
  if (debugSep) {
    insertAfter(content, debugLogsSection, debugSep);
  } else {
    content.appendChild(debugLogsSection);
  }

  tagSeparatorContainers(dialog);
  injectSectionDescriptions(dialog);
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
    const hasPrefs = content && (content.children.length > 2 || dialog.querySelector(".separator-label"));
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
