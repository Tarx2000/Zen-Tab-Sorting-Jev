// Zen Tab Sorting — preferences-context setup.
// Watches for Sine's per-mod settings dialog and injects:
// - ATG conflict detection banner
// - Unified Provider Card (18 presets, masked secret store, searchable model combobox,
//   Ollama status & 1-click Pull with Cancel, collapsible Fallback Chain & Per-Task Profiles)
// - Sign in with ChatGPT (SIWC) card with manual callback URL fallback & consent sync
// - JEV & LLM 2-step connection tests
// - Rules editor, Skip Domains editor, Backup & Restore, Debug Logs
// - Q6 Standard vs Fine-Tuning layout + per-section & global Reset-to-Defaults

import { CONFIG, LOG, DEFAULT_RULES, BUILD_VERSION, RESETTABLE_TUNING_PREFS, h } from "./config.mjs";
import { ensureHybridPreferences } from "./hybrid-preferences.mjs";
import { organizeSettingsLayout, maskProviderKeys, setupNewGroupStrengthControl } from "./settings-layout.mjs";
import { readRulesPref, isDomainRulesEnabled } from "./rules.mjs";
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
  completeChatGPTSignInFromCallbackUrl,
  fetchChatGPTModels,
  ensureValidChatGPTToken,
} from "./chatgpt-auth.mjs";
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  listProviderPresets,
} from "./provider-registry.mjs";
import {
  getFavoriteModels,
  getRecentModels,
  listProviderModels,
  recordRecentModel,
  toggleFavoriteModel,
} from "./provider-models.mjs";
import {
  getTaskProfile,
  readFallbackChainIds,
  readProviderSettingsForName,
  setFallbackChain,
  setTaskProfile,
  upsertProviderProfile,
} from "./provider-settings.mjs";
import {
  getCachedSecret,
  hydrateSecrets,
  setSecret,
} from "./secret-store.mjs";
import {
  checkOllamaReady,
  pullOllamaModel,
} from "./ollama-transport.mjs";
import { getLocale } from "./i18n.mjs";

console.log(`[ZenTabSort] prefs-ui.mjs loaded — v${BUILD_VERSION}`);

const isGerman = () => getLocale() === "de";
const loc = (de, en) => (isGerman() ? de : en);

const PROVIDER_KEY_URLS = Object.freeze({
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  "azure-openai": "https://portal.azure.com/",
  openrouter: "https://openrouter.ai/keys",
  groq: "https://console.groq.com/keys",
  mistral: "https://console.mistral.ai/api-keys/",
  deepseek: "https://platform.deepseek.com/api_keys",
  xai: "https://console.x.ai/",
  perplexity: "https://www.perplexity.ai/settings/api",
  "github-models": "https://github.com/settings/tokens",
  primalabs: "https://primalabs.ai/",
});

const LEGACY_PREFS_BY_PROVIDER = Object.freeze({
  chatgpt: { model: CONFIG.AI_CHATGPT_MODEL_PREF },
  primalabs: { endpoint: CONFIG.AI_PRIMALABS_ENDPOINT_PREF, key: CONFIG.AI_PRIMALABS_API_KEY_PREF, model: CONFIG.AI_PRIMALABS_MODEL_PREF },
  openai: { endpoint: CONFIG.AI_OPENAI_ENDPOINT_PREF, key: CONFIG.AI_OPENAI_API_KEY_PREF, model: CONFIG.AI_OPENAI_MODEL_PREF },
  gemini: { key: CONFIG.AI_GEMINI_API_KEY_PREF, model: CONFIG.AI_GEMINI_MODEL_PREF },
  ollama: { endpoint: CONFIG.AI_OLLAMA_HOST_PREF, model: CONFIG.AI_OLLAMA_MODEL_PREF },
  custom: { endpoint: CONFIG.AI_CUSTOM_ENDPOINT_PREF, key: CONFIG.AI_CUSTOM_API_KEY_PREF, model: CONFIG.AI_CUSTOM_MODEL_PREF },
});

let settingsObserver = null;
const watchedDialogs = new Set();

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

const injectCssFile = async (relativeUrl, attrName) => {
  try {
    const res = await fetch(new URL(relativeUrl, import.meta.url).href, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const css = await res.text();
    const existing = document.querySelector(`style[${attrName}]`);
    if (existing) existing.remove();
    const style = document.createElement("style");
    style.setAttribute(attrName, "1");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {
    console.warn(`${LOG} failed to inject stylesheet ${relativeUrl}:`, e);
  }
};

const injectStylesheet = async () => {
  await Promise.all([
    injectCssFile("../userChrome.css", "data-zao-style"),
    injectCssFile("../styles/settings-ui.css", "data-zao-settings-style"),
  ]);
};

// Detect Advanced Tab Groups (ATG) across any open browser window or global scope.
const detectAdvancedTabGroups = () => {
  try {
    if (globalThis.advancedTabGroups || globalThis.window?.atgFolderLook) return true;
    const wm = globalThis.Services?.wm;
    if (wm?.getEnumerator) {
      const enumerator = wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) {
        const win = enumerator.getNext();
        if (
          win?._zaoAtgConflictDetected ||
          win?.advancedTabGroups ||
          win?.atgFolderLook ||
          win?.document?.getElementById?.("advanced-tab-groups-context-menu")
        ) {
          return true;
        }
      }
    }
  } catch {}
  return false;
};

const buildAtgBanner = () => {
  const banner = h("div", { class: "zao-atg-banner" });
  banner.setAttribute("role", "alert");
  banner.append(
    h("span", { class: "zao-atg-banner-icon", text: "⚠" }),
    h("div", {
      class: "zao-atg-banner-text",
      text: loc(
        "Advanced Tab Groups erkannt — bitte in Sine deaktivieren/entfernen, damit die eingebaute Folder-Engine von Zen Tab Sorting übernehmen kann.",
        "Advanced Tab Groups detected — please disable/remove it in Sine so Zen Tab Sorting's built-in Folder Engine can take over.",
      ),
    }),
  );
  return banner;
};

const getSectionDescriptions = () => [
  [
    "AI Sorting",
    loc(
      "Jev sortiert Tabs in bestehende Ordner. Dein gewähltes LLM erstellt neue Gruppen für übrige Tabs. Beide Stufen laufen bei jeder normalen Sortierung zusammen.",
      "Jev places tabs into existing groups. Your chosen LLM creates new groups for the remaining tabs. Both stages are part of every normal sort.",
    ),
  ],
  [
    "1. Existing groups",
    loc(
      "Wähle den Jev-Dienst und das Modell zur Erkennung bestehender Ordner. Dieselbe Konfiguration steuert auch das Sortieren zwischen Spaces.",
      "Choose the Jev service and model used to recognize your existing groups. The same Jev configuration also powers sorting between Spaces.",
    ),
  ],
  [
    "Jev confidence",
    loc(
      "Konfidenz als 0.70 oder 70% und Vorsprung als 0.15 oder 15 Prozentpunkte angeben. Diese Werte gelten für bestehende Ordner.",
      "Enter confidence as 0.70 or 70%, and the lead as 0.15 or 15 percentage points. These thresholds apply to existing groups. For moving between Spaces, the destination must instead score more than 10 percentage points above the current Space.",
    ),
  ],
  [
    "2. New groups",
    loc(
      "Wähle das LLM für übrige Tabs (18 Presets oder Custom). Neue Gruppen enthalten mindestens zwei Tabs. Feineinstellungen wie Reasoning und Zeitlimit findest du unter Erweitert / Fine-Tuning.",
      "Choose the LLM for tabs that Jev could not place (18 presets or custom). New groups contain at least two tabs. Reasoning effort and time budget live under Advanced / Fine-Tuning.",
    ),
  ],
  [
    "3. Sorting behavior",
    loc(
      "Bestehende Ordner behalten und lose Tabs sortieren, oder alle Tabs neu ordnen. Der Vorschau-Modus lässt dich neue Gruppen vor dem Anwenden prüfen.",
      "Keep existing groups and sort loose tabs, or reconsider all tabs. Preview mode lets you review new groups before anything moves.",
    ),
  ],
  [
    "Group Rules",
    loc(
      "Optional: Domains vor Jev festen Gruppen zuordnen. Für rein kontextbasiertes Sortieren deaktiviert lassen.",
      "Optional: match domains to saved groups before Jev runs. Leave this off for sorting by context.",
    ),
  ],
  [
    "Skip Domains",
    loc(
      "Websites vom Sortieren ausnehmen. Passende Tabs bleiben lose oben; beim Space-Sortieren bleibt ihre Gruppe im aktuellen Space.",
      "Exclude sites from sorting. In a normal sort, matching tabs stay loose at the top. When sorting between Spaces, a matching member keeps the entire group in its current Space.",
    ),
  ],
  [
    "Backup & Restore",
    loc(
      "Exportiere oder importiere Domain-Regeln und Ausnahmen. API-Keys und Account-Logins sind nie Teil dieses Backups.",
      "Export or import your domain rules and excluded sites. Provider keys and account credentials are not part of this backup.",
    ),
  ],
  [
    "Look & Feel",
    loc(
      "Lege Aussehen, Farbintensität, Animationen und die eingebaute Folder-Engine fest.",
      "Choose how tab groups appear in the sidebar, plus motion and built-in Folder Engine options.",
    ),
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
  for (const [prefix, text] of getSectionDescriptions()) {
    const sep = seps.find((lbl) => lbl.textContent.trim().startsWith(prefix));
    if (!sep) continue;
    const container = sep.closest("vbox") || sep.parentElement;
    if (container.nextElementSibling?.classList?.contains("zao-pref-description")) continue;
    const desc = h("div", { class: "zao-pref-description", text });
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

const syncPrefDomValue = (dialog, prefName, type) => {
  const row = findPrefRow(dialog, prefName);
  if (!row) return;
  if (type === "bool") {
    let val = false;
    try { val = Services.prefs.getBoolPref(prefName, false); } catch {}
    const cb = row.querySelector("input[type='checkbox'], checkbox");
    if (cb) {
      cb.checked = val;
      if (val) cb.setAttribute?.("checked", "true");
      else cb.removeAttribute?.("checked");
    }
    return;
  }
  let strVal = "";
  try { strVal = Services.prefs.getStringPref(prefName, ""); } catch {}
  const input = row.querySelector("input");
  if (input && document.activeElement !== input) {
    input.value = strVal;
    if (input.type === "range") input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const menu = row.querySelector("menulist");
  if (menu) {
    const item = [...menu.querySelectorAll("menuitem")].find((it) => it.getAttribute("value") === strVal);
    if (item) {
      menu.setAttribute("value", strVal);
      menu.setAttribute("label", item.getAttribute("label"));
    }
  }
};

const updateConditionalFields = (dialog) => {
  const activeLlm = getFallbackProviderPref();
  const domainRulesOn = isDomainRulesEnabled();
  const setHidden = (row, hidden) => row?.classList.toggle("zao-pref-hidden", hidden);

  setHidden(findPrefRow(dialog, CONFIG.AI_ENGINE_PREF), true);
  setHidden(dialog.querySelector(".zao-rules-editor"), !domainRulesOn);
  setHidden(findPrefRow(dialog, CONFIG.STRICT_RULES_PREF), !domainRulesOn);
  setHidden(findPrefRow(dialog, CONFIG.AI_EXISTING_BEHAVIOR_PREF), !domainRulesOn);

  if (!domainRulesOn && Services.prefs.getStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "") === "auto-add") {
    Services.prefs.setStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "transient");
  }
  filterDropdownOptions(
    findPrefRow(dialog, CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF),
    new Set(domainRulesOn ? ["transient", "identify-only", "auto-add"] : ["transient", "identify-only"]),
  );

  // Sync consent checkbox DOM whenever AI_PROVIDER_CONSENT_PREF changes (e.g. via ChatGPT Sign-In)
  syncPrefDomValue(dialog, CONFIG.AI_PROVIDER_CONSENT_PREF, "bool");

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
  dialog.querySelector(".zao-unified-provider-card")?._zaoRefreshProvider?.();

  for (const name of [
    CONFIG.AI_JEV_MODEL_PREF,
    CONFIG.AI_CHATGPT_MODEL_PREF,
    CONFIG.AI_PRIMALABS_MODEL_PREF,
    CONFIG.AI_OPENAI_MODEL_PREF,
    CONFIG.AI_GEMINI_MODEL_PREF,
    CONFIG.AI_OLLAMA_MODEL_PREF,
    CONFIG.AI_CUSTOM_MODEL_PREF,
  ]) {
    const input = findPrefRow(dialog, name)?.querySelector("input");
    if (input && document.activeElement !== input) {
      try { input.value = Services.prefs.getStringPref(name, input.value); } catch {}
    }
  }
  for (const name of [
    CONFIG.AI_JEV_PROVIDER_PREF,
    CONFIG.AI_FALLBACK_PROVIDER_PREF,
    CONFIG.AI_SORT_MODE_PREF,
    CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF,
    CONFIG.AI_REASONING_EFFORT_PREF,
    CONFIG.AI_WORKSPACE_SORT_STRICTNESS_PREF,
    CONFIG.ANIMATION_STYLE_PREF,
  ]) {
    syncPrefDomValue(dialog, name, "string");
  }
};

const OBSERVED_PREFS = [
  CONFIG.AI_ENGINE_PREF,
  CONFIG.AI_FALLBACK_PROVIDER_PREF,
  CONFIG.AI_JEV_PROVIDER_PREF,
  CONFIG.AI_PROVIDER_CONSENT_PREF,
  CONFIG.USE_DOMAIN_RULES_PREF,
  CONFIG.PIP_SHAPE_PREF,
  CONFIG.AI_CHATGPT_SESSION_PREF,
  CONFIG.AI_CHATGPT_MODEL_PREF,
  CONFIG.AI_JEV_MODEL_PREF,
  CONFIG.AI_SORT_MODE_PREF,
  CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF,
  CONFIG.AI_PROVIDER_PROFILES_PREF,
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

// ─── Unified Provider Card (18 presets, Secret Store, Model Combobox, Ollama Pull, Chain/Profiles) ───

const buildUnifiedProviderCard = (dialog) => {
  const card = h("div", { class: "zao-unified-provider-card" });

  // Header: active provider title + category/adapter badge + Ollama live status badge
  const header = h("div", { class: "zao-provider-card-header" });
  const titleWrap = h("div", { class: "zao-provider-card-title" });
  const titleText = h("span");
  const categoryBadge = h("span", { class: "zao-provider-badge" });
  const ollamaBadge = h("span", { class: "zao-provider-badge" });
  ollamaBadge.hidden = true;
  titleWrap.append(titleText, categoryBadge, ollamaBadge);
  header.appendChild(titleWrap);

  // Grid: Endpoint + Secret API Key + Searchable Model Combobox
  const grid = h("div", { class: "zao-provider-grid" });

  const endpointLabel = h("label", { text: loc("Endpoint-URL", "Endpoint URL") });
  const endpointRow = h("div", { class: "zao-provider-field-row" });
  const endpointInput = h("input");
  endpointInput.type = "text";
  endpointInput.placeholder = "https://api.openai.com/v1";
  endpointRow.appendChild(endpointInput);

  const secretLabel = h("label", { text: loc("API-Key (gesichert)", "API key (secured)") });
  const secretRow = h("div", { class: "zao-provider-field-row" });
  const secretInput = h("input");
  secretInput.type = "password";
  secretInput.autocomplete = "off";
  secretInput.spellcheck = false;
  secretInput.placeholder = loc("In Firefox Passwort-Tresor gespeichert", "Stored in browser credential store");
  const secretToggle = h("button", { class: "zao-backup-btn", text: loc("Anzeigen", "Show") });
  secretToggle.type = "button";
  const getKeyLink = h("a", { class: "zao-get-key-link", text: loc("Key holen ↗", "Get key ↗") });
  getKeyLink.target = "_blank";
  getKeyLink.rel = "noopener noreferrer";
  secretRow.append(secretInput, secretToggle, getKeyLink);

  const modelLabel = h("label", { text: loc("Modell-Auswahl", "Model picker") });
  const combobox = h("div", { class: "zao-model-combobox" });
  const comboRow = h("div", { class: "zao-model-combobox-row" });
  const modelSearchInput = h("input", { class: "zao-model-combobox-input" });
  modelSearchInput.type = "text";
  modelSearchInput.placeholder = loc("Modell suchen oder eigene ID eingeben…", "Search models or type custom model ID…");
  modelSearchInput.setAttribute("role", "combobox");
  modelSearchInput.setAttribute("aria-autocomplete", "list");
  modelSearchInput.setAttribute("aria-expanded", "false");
  const refreshModelsBtn = h("button", { class: "zao-backup-btn", text: loc("Laden", "Refresh") });
  refreshModelsBtn.type = "button";
  comboRow.append(modelSearchInput, refreshModelsBtn);

  const modelDropdown = h("div", { class: "zao-model-dropdown" });
  modelDropdown.setAttribute("role", "listbox");
  modelDropdown.hidden = true;
  const modelStatus = h("span", { class: "zao-provider-test-status" });
  combobox.append(comboRow, modelDropdown, modelStatus);

  grid.append(endpointLabel, endpointRow, secretLabel, secretRow, modelLabel, combobox);

  // Ollama status + optional 1-click Pull with Cancel
  const ollamaTools = h("div", { class: "zao-ollama-tools" });
  ollamaTools.hidden = true;
  const pullBtn = h("button", { class: "zao-backup-btn", text: loc("Modell herunterladen (Pull)", "Pull model") });
  pullBtn.type = "button";
  const cancelPullBtn = h("button", { class: "zao-backup-btn", text: loc("Abbrechen", "Cancel") });
  cancelPullBtn.type = "button";
  cancelPullBtn.hidden = true;
  const progressTrack = h("div", { class: "zao-ollama-progress" });
  progressTrack.hidden = true;
  const progressBar = h("div", { class: "zao-ollama-progress-bar" });
  progressTrack.appendChild(progressBar);
  const ollamaPullStatus = h("span", { class: "zao-provider-test-status" });
  ollamaTools.append(pullBtn, cancelPullBtn, progressTrack, ollamaPullStatus);

  // Collapsible Fallback Chain & Per-Task Profiles drawer (starts closed!)
  const drawer = h("details", { class: "zao-provider-drawer" });
  drawer.appendChild(h("summary", { text: loc("Fallback-Kette & Aufgaben-Profile (Fast / Deep / Offline)", "Fallback Chain & Per-Task Profiles (Fast / Deep / Offline)") }));
  const drawerBody = h("div", { class: "zao-drawer-body" });

  const buildProviderOptions = (select, includeNoneLabel, onlyLocal = false) => {
    select.replaceChildren();
    const noneOpt = h("option", { text: includeNoneLabel });
    noneOpt.value = "";
    select.appendChild(noneOpt);
    const categories = onlyLocal
      ? [["local", loc("Lokal", "Local")]]
      : [
          ["cloud", loc("Cloud", "Cloud")],
          ["local", loc("Lokal", "Local")],
          ["custom", loc("Benutzerdefiniert", "Custom")],
        ];
    for (const [cat, label] of categories) {
      const group = h("optgroup");
      group.label = label;
      for (const preset of listProviderPresets({ category: cat })) {
        const opt = h("option", { text: preset.name });
        opt.value = preset.id;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
  };

  const chainGrid = h("div", { class: "zao-provider-grid" });
  const secLabel = h("label", { text: loc("2. Fallback-Provider", "Secondary fallback") });
  const secSelect = h("select");
  buildProviderOptions(secSelect, loc("— Keiner —", "— None —"));
  const terLabel = h("label", { text: loc("3. Lokaler Fallback", "Local / tertiary fallback") });
  const terSelect = h("select");
  buildProviderOptions(terSelect, loc("— Keiner —", "— None —"));
  const fastLabel = h("label", { text: loc("Fast-Profil", "Fast profile") });
  const fastSelect = h("select");
  buildProviderOptions(fastSelect, loc("Standard (Primär)", "Default (Primary)"));
  const deepLabel = h("label", { text: loc("Deep-Profil", "Deep profile") });
  const deepSelect = h("select");
  buildProviderOptions(deepSelect, loc("Standard (Primär)", "Default (Primary)"));
  const offlineLabel = h("label", { text: loc("Offline-Profil", "Offline profile") });
  const offlineSelect = h("select");
  buildProviderOptions(offlineSelect, loc("Standard (Ollama)", "Default (Ollama)"), true);

  const wrapSelect = (sel) => {
    const r = h("div", { class: "zao-provider-field-row" });
    r.appendChild(sel);
    return r;
  };
  chainGrid.append(
    secLabel, wrapSelect(secSelect),
    terLabel, wrapSelect(terSelect),
    fastLabel, wrapSelect(fastSelect),
    deepLabel, wrapSelect(deepSelect),
    offlineLabel, wrapSelect(offlineSelect),
  );
  drawerBody.appendChild(chainGrid);
  drawer.appendChild(drawerBody);

  card.append(header, grid, ollamaTools, drawer);

  let catalogModels = [];
  let activePullController = null;

  const persistCurrentProfile = async ({ saveSecret = false } = {}) => {
    const providerId = getFallbackProviderPref();
    if (!providerId || providerId === "off") return;
    const preset = getProviderPreset(providerId);
    const endpoint = endpointInput.value.trim() || preset?.defaultBaseUrl || "";
    const model = modelSearchInput.value.trim() || preset?.defaultModel || "";

    upsertProviderProfile(Services.prefs, {
      id: providerId,
      provider: providerId,
      endpoint,
      model,
    });

    const legacy = LEGACY_PREFS_BY_PROVIDER[providerId];
    try {
      if (legacy?.endpoint) Services.prefs.setStringPref(legacy.endpoint, endpoint);
      if (legacy?.model) Services.prefs.setStringPref(legacy.model, model);
    } catch {}

    if (saveSecret && !preset?.requiresOAuth) {
      const secretVal = secretInput.value.trim();
      await setSecret(providerId, secretVal, {
        prefs: Services.prefs,
        fallbackPref: legacy?.key,
      });
    }
    if (model) recordRecentModel({ provider: providerId, model }, Services.prefs);
  };

  const renderModelList = (filterText = "") => {
    const providerId = getFallbackProviderPref();
    const q = String(filterText || "").trim().toLowerCase();
    const favorites = getFavoriteModels(Services.prefs);
    const favSet = new Set(favorites.filter((f) => !f.provider || f.provider === providerId).map((f) => f.model));
    const recents = getRecentModels(Services.prefs).filter((r) => r.provider === providerId);

    const byId = new Map();
    for (const f of favorites) {
      if (f.provider === providerId) byId.set(f.model, { id: f.model, label: f.label || f.model, rank: 0 });
    }
    for (const r of recents) {
      if (!byId.has(r.model)) byId.set(r.model, { id: r.model, label: r.label || r.model, rank: 1 });
    }
    for (const m of catalogModels) {
      if (!byId.has(m.id)) byId.set(m.id, { id: m.id, label: m.label || m.id, rank: 2 });
    }

    const items = [...byId.values()]
      .filter((item) => !q || item.id.toLowerCase().includes(q) || item.label.toLowerCase().includes(q))
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
      .slice(0, 60);

    modelDropdown.replaceChildren();
    if (items.length === 0) {
      modelDropdown.hidden = true;
      modelSearchInput.setAttribute("aria-expanded", "false");
      return;
    }

    for (const item of items) {
      const row = h("div", { class: "zao-model-option" });
      row.setAttribute("role", "option");
      const isSelected = item.id === modelSearchInput.value.trim();
      row.setAttribute("aria-selected", String(isSelected));

      const main = h("span", {
        class: "zao-model-option-main",
        text: item.label !== item.id ? `${item.label} (${item.id})` : item.id,
      });
      main.addEventListener("mousedown", (e) => {
        e.preventDefault();
        modelSearchInput.value = item.id;
        modelDropdown.hidden = true;
        modelSearchInput.setAttribute("aria-expanded", "false");
        void persistCurrentProfile();
        syncPrefDomValue(dialog, LEGACY_PREFS_BY_PROVIDER[providerId]?.model || "", "string");
      });

      const isFav = favSet.has(item.id);
      const favBtn = h("button", { class: "zao-model-fav-btn", text: isFav ? "★" : "☆" });
      favBtn.type = "button";
      favBtn.setAttribute("aria-pressed", String(isFav));
      favBtn.setAttribute("aria-label", loc("Favorit umschalten", "Toggle favorite"));
      favBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFavoriteModel({ provider: providerId, model: item.id, label: item.label }, Services.prefs);
        renderModelList(modelSearchInput.value);
      });

      row.append(main, favBtn);
      modelDropdown.appendChild(row);
    }

    modelDropdown.hidden = false;
    modelSearchInput.setAttribute("aria-expanded", "true");
  };

  const refreshOllamaBadge = async () => {
    const providerId = getFallbackProviderPref();
    if (providerId !== "ollama") {
      ollamaBadge.hidden = true;
      ollamaTools.hidden = true;
      return;
    }
    ollamaBadge.hidden = false;
    ollamaTools.hidden = false;
    ollamaBadge.textContent = loc("Prüfe Ollama…", "Checking Ollama…");
    ollamaBadge.removeAttribute("data-tone");

    const host = endpointInput.value.trim() || CONFIG.AI_OLLAMA_HOST_DEFAULT;
    const model = modelSearchInput.value.trim() || CONFIG.AI_OLLAMA_MODEL_DEFAULT;
    const status = await checkOllamaReady(host, model);
    if (status.reachable && status.modelAvailable) {
      ollamaBadge.textContent = loc("Ollama bereit", "Ollama ready");
      ollamaBadge.dataset.tone = "ok";
      pullBtn.hidden = true;
    } else if (status.reachable && !status.modelAvailable) {
      ollamaBadge.textContent = loc("Modell fehlt", "Model not pulled");
      ollamaBadge.dataset.tone = "warn";
      pullBtn.hidden = false;
    } else if (status.status === 403 || status.errorType === "forbidden") {
      ollamaBadge.textContent = "HTTP 403 (OLLAMA_ORIGINS)";
      ollamaBadge.dataset.tone = "err";
      pullBtn.hidden = true;
    } else {
      ollamaBadge.textContent = loc("Ollama offline", "Ollama offline");
      ollamaBadge.dataset.tone = "err";
      pullBtn.hidden = true;
    }
  };

  const refreshProviderCard = () => {
    const providerId = getFallbackProviderPref();
    if (providerId === "off" || providerId === "none") {
      card.classList.add("zao-pref-hidden");
      return;
    }
    card.classList.remove("zao-pref-hidden");
    const preset = getProviderPreset(providerId);
    const settings = readProviderSettingsForName(Services.prefs, providerId);

    titleText.textContent = preset?.name || providerId;
    categoryBadge.textContent = preset
      ? `${preset.category === "local" ? loc("Lokal", "Local") : preset.category === "custom" ? "Custom" : "Cloud"} · ${preset.adapter}`
      : providerId;

    const showEndpoint = providerId !== "chatgpt" && providerId !== "gemini";
    endpointLabel.hidden = !showEndpoint;
    endpointRow.hidden = !showEndpoint;
    if (document.activeElement !== endpointInput) {
      endpointInput.value = settings.endpoint || preset?.defaultBaseUrl || "";
      endpointInput.placeholder = preset?.defaultBaseUrl || "https://api.example.com/v1";
    }

    const showSecret = !preset?.requiresOAuth && preset?.category !== "local";
    secretLabel.hidden = !showSecret;
    secretRow.hidden = !showSecret;
    if (showSecret && document.activeElement !== secretInput) {
      secretInput.value = getCachedSecret(providerId) || settings.apiKey || "";
    }
    const keyUrl = PROVIDER_KEY_URLS[providerId];
    if (keyUrl) {
      getKeyLink.href = keyUrl;
      getKeyLink.hidden = false;
    } else {
      getKeyLink.hidden = true;
    }

    if (document.activeElement !== modelSearchInput) {
      modelSearchInput.value = settings.model || preset?.defaultModel || "";
    }

    // Sync Fallback Chain & Task Profile selectors
    const chain = readFallbackChainIds(Services.prefs);
    const nonPrimary = chain.filter((id) => id !== providerId);
    secSelect.value = nonPrimary[0] || "";
    terSelect.value = nonPrimary[1] || "";
    fastSelect.value = getTaskProfile("fast", Services.prefs)?.provider === providerId ? "" : (getTaskProfile("fast", Services.prefs)?.provider || "");
    deepSelect.value = getTaskProfile("deep", Services.prefs)?.provider === providerId ? "" : (getTaskProfile("deep", Services.prefs)?.provider || "");
    const offlineProfile = getTaskProfile("offline", Services.prefs);
    offlineSelect.value = offlineProfile?.provider && offlineProfile.provider !== "ollama" ? offlineProfile.provider : "";

    void refreshOllamaBadge();
  };

  secretToggle.addEventListener("click", () => {
    const show = secretInput.type === "password";
    secretInput.type = show ? "text" : "password";
    secretToggle.textContent = show ? loc("Verbergen", "Hide") : loc("Anzeigen", "Show");
  });

  endpointInput.addEventListener("change", () => {
    void persistCurrentProfile();
    void refreshOllamaBadge();
  });
  secretInput.addEventListener("change", () => {
    void persistCurrentProfile({ saveSecret: true });
  });
  modelSearchInput.addEventListener("focus", () => renderModelList(modelSearchInput.value));
  modelSearchInput.addEventListener("input", () => renderModelList(modelSearchInput.value));
  modelSearchInput.addEventListener("change", () => {
    void persistCurrentProfile();
    void refreshOllamaBadge();
  });
  modelSearchInput.addEventListener("blur", () => {
    setTimeout(() => {
      modelDropdown.hidden = true;
      modelSearchInput.setAttribute("aria-expanded", "false");
    }, 140);
  });

  refreshModelsBtn.addEventListener("click", async () => {
    const providerId = getFallbackProviderPref();
    refreshModelsBtn.disabled = true;
    modelStatus.textContent = loc("Lade verfügbare Modelle…", "Loading available models…");
    modelStatus.removeAttribute("data-state");
    try {
      await persistCurrentProfile({ saveSecret: !getProviderPreset(providerId)?.requiresOAuth });
      const profile = readProviderSettingsForName(Services.prefs, providerId);
      const res = await listProviderModels(profile, { forceRefresh: true });
      if (res.ok) {
        catalogModels = res.models;
        modelStatus.textContent = loc(
          `${res.models.length} Modell(e) geladen.`,
          `Loaded ${res.models.length} model(s).`,
        );
        modelStatus.dataset.state = "ok";
        renderModelList("");
      } else {
        modelStatus.textContent = loc(
          `Modelle konnten nicht geladen werden: ${res.error || "Unbekannter Fehler"}`,
          `Could not load models: ${res.error || "Unknown error"}`,
        );
        modelStatus.dataset.state = "err";
      }
    } catch (e) {
      modelStatus.textContent = `${loc("Fehler", "Error")}: ${e?.message || e}`;
      modelStatus.dataset.state = "err";
    } finally {
      refreshModelsBtn.disabled = false;
    }
  });

  pullBtn.addEventListener("click", async () => {
    const host = endpointInput.value.trim() || CONFIG.AI_OLLAMA_HOST_DEFAULT;
    const model = modelSearchInput.value.trim() || CONFIG.AI_OLLAMA_MODEL_DEFAULT;
    activePullController = new AbortController();
    pullBtn.disabled = true;
    cancelPullBtn.hidden = false;
    progressTrack.hidden = false;
    progressBar.style.width = "4%";
    ollamaPullStatus.textContent = loc(`Lade ${model}…`, `Pulling ${model}…`);
    ollamaPullStatus.removeAttribute("data-state");
    try {
      const result = await pullOllamaModel(host, model, {
        signal: activePullController.signal,
        onProgress: ({ status, percent }) => {
          if (Number.isFinite(percent)) progressBar.style.width = `${Math.max(4, percent)}%`;
          ollamaPullStatus.textContent = Number.isFinite(percent) ? `${status} (${percent}%)` : (status || "…");
        },
      });
      if (result.ok) {
        progressBar.style.width = "100%";
        ollamaPullStatus.textContent = loc(`${model} erfolgreich geladen.`, `${model} pulled successfully.`);
        ollamaPullStatus.dataset.state = "ok";
        void refreshOllamaBadge();
      } else {
        ollamaPullStatus.textContent = result.error || loc("Pull abgebrochen.", "Pull cancelled.");
        ollamaPullStatus.dataset.state = "err";
      }
    } finally {
      activePullController = null;
      pullBtn.disabled = false;
      cancelPullBtn.hidden = true;
    }
  });

  cancelPullBtn.addEventListener("click", () => {
    activePullController?.abort();
  });

  const saveChain = () => {
    const primary = getFallbackProviderPref();
    const next = [primary, secSelect.value, terSelect.value].filter((v) => v && v !== "off");
    setFallbackChain(Services.prefs, next);
  };
  secSelect.addEventListener("change", saveChain);
  terSelect.addEventListener("change", saveChain);
  fastSelect.addEventListener("change", () => setTaskProfile("fast", fastSelect.value || null, Services.prefs));
  deepSelect.addEventListener("change", () => setTaskProfile("deep", deepSelect.value || null, Services.prefs));
  offlineSelect.addEventListener("change", () => setTaskProfile("offline", offlineSelect.value || null, Services.prefs));

  card._zaoRefreshProvider = refreshProviderCard;
  refreshProviderCard();
  return card;
};

// ─── Interactive "Sign in with ChatGPT" widget + manual OAuth callback fallback ───

const buildChatGPTSignInSection = (dialog) => {
  const container = h("div", { class: "zao-chatgpt-signin" });

  const signInBtn = h("button", { text: loc("Mit ChatGPT anmelden", "Sign in with ChatGPT"), class: "zao-backup-btn" });
  const signOutBtn = h("button", { text: loc("Abmelden", "Sign out"), class: "zao-backup-btn" });
  const loadModelsBtn = h("button", { text: loc("ChatGPT-Modelle laden", "Load ChatGPT models"), class: "zao-backup-btn" });

  const modelSelect = h("select");
  modelSelect.style.marginLeft = "6px";
  modelSelect.hidden = true;

  const status = h("span", { class: "zao-provider-test-status" });
  const consentNotice = h("div", { class: "zao-consent-notice" });
  consentNotice.hidden = true;

  // Collapsible manual callback URL fallback (starts closed!)
  const manualDetails = h("details", { class: "zao-oauth-manual-fallback" });
  manualDetails.appendChild(h("summary", { text: loc("Callback-URL manuell einfügen (Firewall-Fallback)", "Paste callback URL (manual OAuth fallback)") }));
  const callbackRow = h("div", { class: "zao-oauth-callback-row" });
  const callbackInput = h("input");
  callbackInput.type = "text";
  callbackInput.placeholder = "http://127.0.0.1:.../auth/callback?code=...&state=...";
  const callbackSubmit = h("button", { class: "zao-backup-btn", text: loc("Anmeldung abschließen", "Complete sign-in") });
  callbackSubmit.type = "button";
  callbackRow.append(callbackInput, callbackSubmit);
  manualDetails.appendChild(callbackRow);

  container.append(signInBtn, signOutBtn, loadModelsBtn, modelSelect, status, consentNotice, manualDetails);

  const enableConsentAndSync = () => {
    try {
      Services.prefs.setBoolPref(CONFIG.AI_PROVIDER_CONSENT_PREF, true);
    } catch {}
    syncPrefDomValue(dialog, CONFIG.AI_PROVIDER_CONSENT_PREF, "bool");
    consentNotice.textContent = loc(
      "Hinweis: Die Datenfreigabe für ChatGPT wurde automatisch aktiviert (oben jederzeit widerrufbar).",
      "Notice: Data-sending consent was enabled for ChatGPT (you can revoke it anytime above).",
    );
    consentNotice.hidden = false;
  };

  const refreshState = () => {
    const session = readChatGPTSession(Services.prefs);
    const connected = Boolean(session && (session.accessToken || session.refreshToken));
    signOutBtn.hidden = !connected;
    loadModelsBtn.hidden = !connected;
    if (connected) {
      const who = session.email || session.subject || loc("ChatGPT-Konto", "ChatGPT account");
      status.textContent = loc(`Angemeldet (${who})`, `Signed in (${who})`);
      status.dataset.state = "ok";
      signInBtn.textContent = loc("ChatGPT neu verbinden", "Reconnect ChatGPT");
    } else {
      status.textContent = loc(
        "Nicht angemeldet — klicke zum Autorisieren mit deinem ChatGPT-Abo.",
        "Not signed in — click to authorize with your ChatGPT subscription.",
      );
      status.removeAttribute("data-state");
      signInBtn.textContent = loc("Mit ChatGPT anmelden", "Sign in with ChatGPT");
      modelSelect.hidden = true;
    }
  };

  modelSelect.addEventListener("change", () => {
    if (modelSelect.value) {
      try {
        Services.prefs.setStringPref(CONFIG.AI_CHATGPT_MODEL_PREF, modelSelect.value);
        status.textContent = loc(`Ausgewähltes Modell: ${modelSelect.value}`, `Selected model: ${modelSelect.value}`);
        status.dataset.state = "ok";
      } catch {}
    }
  });

  loadModelsBtn.addEventListener("click", async () => {
    loadModelsBtn.disabled = true;
    status.textContent = loc("Lade verfügbare ChatGPT-Modelle…", "Loading available ChatGPT models…");
    try {
      const token = await ensureValidChatGPTToken(Services.prefs);
      const models = await fetchChatGPTModels(token);
      if (models.length === 0) {
        status.textContent = loc(
          "Keine Modelle von /v1/models erhalten; gib die Modell-ID manuell ein.",
          "No models returned by /v1/models; type model slug manually below.",
        );
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
        status.textContent = loc(`${models.length} Modell(e) geladen.`, `Loaded ${models.length} model(s).`);
        status.dataset.state = "ok";
      }
    } catch (e) {
      status.textContent = `${loc("Modelle laden fehlgeschlagen", "Failed to load models")}: ${e?.message || e}`;
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
      enableConsentAndSync();
      refreshState();
      if (session?.accessToken) loadModelsBtn.click();
    } catch (e) {
      status.textContent = `${loc("Anmeldung fehlgeschlagen", "Sign-in failed")}: ${e?.message || e}`;
      status.dataset.state = "err";
    } finally {
      signInBtn.disabled = false;
    }
  });

  callbackSubmit.addEventListener("click", async () => {
    const rawUrl = callbackInput.value.trim();
    if (!rawUrl) return;
    callbackSubmit.disabled = true;
    try {
      const session = await completeChatGPTSignInFromCallbackUrl(rawUrl, Services.prefs);
      callbackInput.value = "";
      manualDetails.open = false;
      enableConsentAndSync();
      refreshState();
      if (session?.accessToken) loadModelsBtn.click();
    } catch (e) {
      status.textContent = `${loc("Callback fehlgeschlagen", "Callback failed")}: ${e?.message || e}`;
      status.dataset.state = "err";
    } finally {
      callbackSubmit.disabled = false;
    }
  });

  signOutBtn.addEventListener("click", () => {
    clearChatGPTSession(Services.prefs);
    consentNotice.hidden = true;
    refreshState();
  });

  container._zaoRefreshState = refreshState;
  refreshState();
  return container;
};

// ─── Upgraded 2-Step Provider Connection Test ───────────────────────────────

const buildProviderTestSection = (stage) => {
  const isJev = stage === "jev";
  const container = h("div", { class: `zao-provider-test zao-${stage}-test` });
  const button = h("button", {
    text: isJev
      ? loc("Jev-Verbindung testen", "Test Jev connection")
      : loc("LLM-Verbindung testen", "Test LLM connection"),
    class: "zao-backup-btn",
  });
  const status = h("span", { class: "zao-provider-test-status" });
  status.setAttribute("role", "status");
  container.append(button, status);
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = loc("Teste Verbindung…", "Testing…");
    status.removeAttribute("data-state");
    try {
      const result = await (isJev ? testJevConnection() : testProviderConnection());
      status.dataset.state = result.ok ? "ok" : "err";
      if (result.ok) {
        if (isJev) {
          status.textContent = loc(
            `Verbunden in ${result.latencyMs} ms — ${result.reply}.`,
            `Connected in ${result.latencyMs} ms — ${result.reply}.`,
          );
        } else {
          const modelsPart = Number.isFinite(result.modelCount)
            ? loc(` · ${result.modelCount} Modelle`, ` · ${result.modelCount} models`)
            : "";
          const jsonPart = result.jsonValid ? " · JSON ✓" : "";
          status.textContent = loc(
            `Verbunden in ${result.latencyMs} ms${modelsPart}${jsonPart} — ${result.reasoning}.`,
            `Connected in ${result.latencyMs} ms${modelsPart}${jsonPart} — ${result.reasoning}.`,
          );
        }
      } else {
        status.textContent =
          result.userMessage ||
          (result.reason === "consent_required"
            ? loc("Bitte zuerst die Datenfreigabe unter AI Sorting aktivieren.", "Allow sending tab data in AI Sorting first.")
            : result.reason === "missing_required_config"
              ? (isJev
                  ? loc("Bitte zuerst den Jev API-Key eintragen.", "Enter your Jev API key first.")
                  : loc(`Einstellungen vervollständigen: ${(result.missingFields || []).join(", ")}.`, `Complete the provider settings: ${(result.missingFields || []).join(", ")}.`))
              : `${loc("Verbindung fehlgeschlagen", "Connection failed")}: ${result.error || result.reason}`);
      }
    } catch (error) {
      status.textContent = `${loc("Verbindung fehlgeschlagen", "Connection failed")}: ${error?.message || error}`;
      status.dataset.state = "err";
    } finally {
      button.disabled = false;
    }
  });
  return container;
};

// ─── Reset-to-Defaults (per-section & global; NEVER touches secrets/OAuth/rules/skip) ───

const resetTuningPrefs = (dialog, section = null) => {
  const entries = section
    ? RESETTABLE_TUNING_PREFS.filter((item) => item.section === section)
    : RESETTABLE_TUNING_PREFS;
  for (const entry of entries) {
    try {
      if (entry.type === "bool") {
        Services.prefs.setBoolPref(entry.pref, Boolean(entry.defaultValue));
      } else {
        Services.prefs.setStringPref(entry.pref, String(entry.defaultValue));
      }
    } catch {}
    syncPrefDomValue(dialog, entry.pref, entry.type);
  }
  updateConditionalFields(dialog);
};

const buildGlobalResetSection = (dialog) => {
  const card = h("section", { class: "zao-settings-card zao-global-reset-card" });
  card.dataset.zaoSection = "reset";

  const row = h("div", { class: "zao-global-reset-row" });
  const desc = h("span", {
    class: "zao-pref-description",
    text: loc(
      "Setzt alle Tuning-Einstellungen auf die empfohlenen Standardwerte zurück. API-Keys, ChatGPT-Login, Regeln und Skip-Domains bleiben unberührt.",
      "Resets all tuning settings to recommended defaults. API keys, ChatGPT sign-in, rules, and skip domains are preserved.",
    ),
  });
  desc.style.margin = "0";

  const triggerBtn = h("button", {
    class: "zao-backup-btn",
    text: loc("Alle Einstellungen auf Standard zurücksetzen", "Reset all settings to defaults"),
  });
  triggerBtn.type = "button";
  row.append(desc, triggerBtn);

  const confirmBox = h("div", { class: "zao-reset-confirm" });
  confirmBox.hidden = true;
  const confirmMsg = h("span", {
    text: loc(
      "Wirklich alle Tuning-Einstellungen zurücksetzen? (Keys, Login & Regeln bleiben erhalten)",
      "Reset all tuning settings to defaults? (Keys, sign-in & rules stay intact)",
    ),
  });
  const confirmYes = h("button", { class: "zao-backup-btn zao-backup-btn-primary", text: loc("Zurücksetzen", "Reset now") });
  confirmYes.type = "button";
  const confirmCancel = h("button", { class: "zao-backup-btn", text: loc("Abbrechen", "Cancel") });
  confirmCancel.type = "button";
  const resetStatus = h("span", { class: "zao-provider-test-status" });
  confirmBox.append(confirmMsg, confirmYes, confirmCancel);

  triggerBtn.addEventListener("click", () => {
    confirmBox.hidden = false;
    resetStatus.textContent = "";
  });
  confirmCancel.addEventListener("click", () => {
    confirmBox.hidden = true;
  });
  confirmYes.addEventListener("click", () => {
    resetTuningPrefs(dialog, null);
    confirmBox.hidden = true;
    resetStatus.textContent = loc("Standardwerte wiederhergestellt.", "Defaults restored.");
    resetStatus.dataset.state = "ok";
  });

  card.append(row, confirmBox, resetStatus);
  return card;
};

// ─── Debug Logs Card ────────────────────────────────────────────────────────

const buildDebugLogsSection = (dialog) => {
  const card = h("div", { class: "zao-debug-logs-card" });

  const header = h("div", { class: "zao-debug-logs-header" });
  const status = h("span");
  const toggleBtn = h("button", { class: "zao-backup-btn zao-debug-toggle-btn" });
  header.append(status, toggleBtn);

  const actions = h("div", { class: "zao-debug-logs-actions" });
  const refreshBtn = h("button", { text: loc("Aktualisieren", "Refresh"), class: "zao-backup-btn" });
  const copyBtn = h("button", { text: loc("Logs kopieren", "Copy logs"), class: "zao-backup-btn" });
  const clearBtn = h("button", { text: loc("Leeren", "Clear"), class: "zao-backup-btn" });
  actions.append(refreshBtn, copyBtn, clearBtn);

  const viewer = h("textarea", { class: "zao-debug-logs-viewer" });
  viewer.setAttribute("readonly", "true");
  viewer.setAttribute("spellcheck", "false");

  const refreshViewer = () => {
    const active = isDebugMode();
    toggleBtn.textContent = active
      ? loc("Debug-Modus deaktivieren", "Disable debug mode")
      : loc("Debug-Modus aktivieren", "Enable debug mode");
    toggleBtn.dataset.active = active ? "true" : "false";
    status.textContent = active
      ? loc(`Debug-Modus: Aktiviert (${getDebugEvents().length} Logs)`, `Debug mode: Enabled (${getDebugEvents().length} logs)`)
      : loc("Debug-Modus: Deaktiviert", "Debug mode: Disabled");
    viewer.value = formatDebugEventsAsText();
  };

  toggleBtn.addEventListener("click", () => {
    const current = isDebugMode();
    try {
      Services?.prefs?.setBoolPref?.(CONFIG.DEBUG_MODE_PREF, !current);
    } catch (e) {
      console.warn(`${LOG} could not toggle debug mode pref:`, e);
    }
    syncPrefDomValue(dialog, CONFIG.DEBUG_MODE_PREF, "bool");
    refreshViewer();
  });

  copyBtn.addEventListener("click", async () => {
    const idleLabel = loc("Logs kopieren", "Copy logs");
    try {
      if (typeof navigator?.clipboard?.writeText === "function") {
        await navigator.clipboard.writeText(viewer.value);
      }
      copyBtn.textContent = loc("Kopiert!", "Copied!");
      setTimeout(() => { copyBtn.textContent = idleLabel; }, 2000);
    } catch {
      copyBtn.textContent = loc("Fehler!", "Error!");
      setTimeout(() => { copyBtn.textContent = idleLabel; }, 2000);
    }
  });

  refreshBtn.addEventListener("click", refreshViewer);
  clearBtn.addEventListener("click", () => {
    clearDebugEvents();
    refreshViewer();
  });

  refreshViewer();
  card.append(header, actions, viewer);
  card._zaoRefreshLogs = refreshViewer;
  return card;
};

// ─── Dialog Injection & Lifecycle ───────────────────────────────────────────

const performInject = (dialog) => {
  if (dialog.querySelector(".zao-rules-editor")) return;

  const content = dialog.querySelector(".sineItemPreferenceDialogContent");
  if (!content) return;

  ensureHybridPreferences(Services.prefs);
  void hydrateSecrets({ prefs: Services.prefs }).then(() => {
    dialog.querySelector(".zao-unified-provider-card")?._zaoRefreshProvider?.();
  }).catch(() => {});

  let initial = readRulesPref({ keepIncomplete: true });
  if (!initial) {
    initial = JSON.parse(JSON.stringify(DEFAULT_RULES));
  }

  const rulesEditor = buildRulesEditor(initial);
  const skipEditor = buildSkipDomainsEditor();
  const backupSection = buildBackupRestoreSection();
  const chatGptSection = buildChatGPTSignInSection(dialog);
  const unifiedProviderCard = buildUnifiedProviderCard(dialog);
  const jevTest = buildProviderTestSection("jev");
  const llmTest = buildProviderTestSection("llm");

  const rulesCheckboxRow = findPrefRow(dialog, CONFIG.USE_DOMAIN_RULES_PREF) || findSeparatorContainer(dialog, "Group Rules");
  insertAfter(content, rulesEditor, rulesCheckboxRow);
  insertAfter(content, skipEditor, findSeparatorContainer(dialog, "Skip Domains"));
  insertAfter(content, backupSection, findSeparatorContainer(dialog, "Backup & Restore"));

  insertAfter(content, jevTest, findPrefRow(dialog, CONFIG.AI_JEV_MODEL_PREF));
  const fallbackRow = findPrefRow(dialog, CONFIG.AI_FALLBACK_PROVIDER_PREF);
  insertAfter(content, chatGptSection, fallbackRow);
  insertAfter(content, unifiedProviderCard, chatGptSection);

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
  organizeSettingsLayout(dialog, content, {
    onResetSection: (sectionId) => resetTuningPrefs(dialog, sectionId),
  });

  if (detectAdvancedTabGroups() && !content.querySelector(".zao-atg-banner")) {
    content.insertBefore(buildAtgBanner(), content.firstChild);
  }

  content.appendChild(buildGlobalResetSection(dialog));

  maskProviderKeys(dialog);
  setupNewGroupStrengthControl(dialog);
  setupEnginePrefObserver();
  updateConditionalFields(dialog);
  console.log(`${LOG} injected unified provider card + settings sections into Sine settings dialog`);
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
    watchedDialogs.add(dialog);
  }

  void injectStylesheet();

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
  for (const dialog of watchedDialogs) {
    try {
      dialog._zaoOpenWatcher?.disconnect?.();
      delete dialog._zaoOpenWatcher;
    } catch {}
  }
  watchedDialogs.clear();
  teardownEnginePrefObserver();
  teardownRulesPrefObserver();
  teardownSkipPrefObserver();
};
