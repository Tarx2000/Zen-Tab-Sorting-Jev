// Zen Tab Sorting — browser-context UI: tidy button, command, workspace hooks,
// dynamic localized tooltip, click-to-abort, and right-click Quick-Model/Provider Switcher.

import { recordDebugEvent } from "./debug-journal.mjs";
import { CONFIG, LOG, h } from "./config.mjs";
import { domCache } from "./tabs.mjs";
import { handleOrganizeClick } from "./click-handler.mjs";
import { abortSortSession, updateSortButtonState } from "./sort-session.mjs";
import { getProviderPreset } from "./provider-registry.mjs";
import { readFallbackProviderSettings, upsertProviderProfile } from "./provider-settings.mjs";
import { getFavoriteModels, getRecentModels, recordRecentModel } from "./provider-models.mjs";
import { readReasoningPreference } from "./reasoning.mjs";
import { getAISortMode } from "./rules.mjs";
import { getLocale, t } from "./i18n.mjs";

const LIBRARY_CARD = ".zen-library-space[data-uuid]";
const BUTTONS = `.zao-organize-button, [id^="${CONFIG.BUTTON_ID}"]`;
const QUICK_SWITCHER_ID = "zao-wand-quick-switcher";

const isGerman = () => getLocale() === "de";
const loc = (de, en) => (isGerman() ? de : en);

const isOrganizeButton = (node) =>
  Boolean(
    node?.classList?.contains?.("zao-organize-button") ||
    node?.hasAttribute?.("data-zao-library-organize") ||
    node?.id === CONFIG.BUTTON_ID ||
    /^tab-wand-button(?:-copy|-ws-.+)?$/.test(node?.id || ""),
  );

const libraryCard = (node) => node?.closest?.(LIBRARY_CARD);

const workspaceIdForElement = (el) => {
  const ws = el?.closest?.("zen-workspace");
  return ws?.id || ws?.getAttribute?.("id") || ws?.dataset?.uuid || "";
};

const describeActiveProviderModel = () => {
  try {
    const prefs = globalThis.Services?.prefs;
    const settings = readFallbackProviderSettings(prefs);
    if (!settings || settings.provider === "off" || settings.provider === "none") {
      return loc("Nur Jev (Fallback aus)", "Jev only (Fallback off)");
    }
    const preset = getProviderPreset(settings.provider);
    const providerName = preset?.name || settings.provider;
    const model = String(settings.model || "").trim();
    return model ? `${providerName} · ${model}` : providerName;
  } catch {
    return "";
  }
};

const computeWandTooltip = (button) => {
  if (button?.getAttribute?.("aria-busy") === "true") {
    return t("ui.wandCancelTooltip");
  }
  const active = describeActiveProviderModel();
  const base = libraryCard(button)
    ? loc("Tabs in diesem Space automatisch sortieren", "Auto-sort tabs in this Space")
    : t("ui.wandTooltip");
  return active ? `${base} (${active})` : base;
};

export const refreshWandTooltips = () => {
  if (typeof document === "undefined") return;
  for (const button of document.querySelectorAll(".zao-organize-button")) {
    const tip = computeWandTooltip(button);
    button.setAttribute("tooltiptext", tip);
    button.setAttribute("aria-label", tip);
  }
};

const syncWorkspaceScopedButtonIds = () => {
  if (typeof document === "undefined") return;
  const activeWsId = window.gZenWorkspaces?.activeWorkspace || "";
  const sidebarButtons = [...document.querySelectorAll(".zao-organize-button")].filter(
    (btn) => !btn.hasAttribute("data-zao-library-organize"),
  );
  let assignedPrimary = false;
  for (let i = 0; i < sidebarButtons.length; i++) {
    const btn = sidebarButtons[i];
    const wsId = workspaceIdForElement(btn);
    if (wsId) btn.setAttribute("data-zao-workspace-id", wsId);
    const isActive = !assignedPrimary && ((activeWsId && wsId === activeWsId) || (!activeWsId && i === 0));
    if (isActive) {
      btn.id = CONFIG.BUTTON_ID;
      assignedPrimary = true;
    } else {
      const suffix = wsId ? wsId.replace(/[^a-zA-Z0-9_-]/g, "") : `idx-${i}`;
      btn.id = `${CONFIG.BUTTON_ID}-ws-${suffix}`;
    }
  }
  if (!assignedPrimary && sidebarButtons.length > 0) {
    sidebarButtons[0].id = CONFIG.BUTTON_ID;
  }
};

let isReconcilingLibrary = false;
let libraryReconcileRaf = null;

// Library strips clone sidebar markup, including our icon, but not listeners.
// Replace those copies with one persistent header action.
export const reconcileLibraryButtons = () => {
  if (isReconcilingLibrary) return;
  isReconcilingLibrary = true;
  try {
    for (const copy of document.querySelectorAll("zen-library [data-zao-in-flight]")) {
      copy.removeAttribute("data-zao-in-flight");
    }
    for (const card of document.querySelectorAll(LIBRARY_CARD)) {
      const header = card.querySelector(".zen-library-space-header");
      if (!header) continue;
      const buttons = [...card.querySelectorAll(BUTTONS)].filter(isOrganizeButton);
      let button = buttons.find((node) => node.hasAttribute("data-zao-library-organize"));
      if (!button) {
        button = window.MozXULElement.parseXULToFragment(buttonXul()).firstChild;
        button.id = `${CONFIG.BUTTON_ID}-library-${card.dataset.uuid}`;
        button.setAttribute("data-zao-library-organize", "true");
      }
      for (const duplicate of buttons) if (duplicate !== button) duplicate.remove();
      if (button.parentElement !== header) header.insertBefore(button, header.querySelector("toolbarbutton"));
      button.classList.add("zao-organize-button");
      button.removeAttribute("command");
      const tip = computeWandTooltip(button);
      button.setAttribute("tooltiptext", tip);
      button.setAttribute("aria-label", tip);
      updateSortButtonState(button, window);
    }
  } finally {
    isReconcilingLibrary = false;
  }
};

const scheduleLibraryReconcile = () => {
  if (isReconcilingLibrary || libraryReconcileRaf != null) return;
  libraryReconcileRaf = window.requestAnimationFrame(() => {
    libraryReconcileRaf = null;
    if (!window.closed) reconcileLibraryButtons();
  });
};

// ─── Right-Click Quick-Model / Provider Switcher Popover ────────────────────

const closeQuickSwitcher = () => {
  const existing = document.getElementById(QUICK_SWITCHER_ID);
  if (existing) existing.remove();
  if (window._zaoQuickSwitcherDismiss) {
    window.removeEventListener("mousedown", window._zaoQuickSwitcherDismiss, true);
    window.removeEventListener("keydown", window._zaoQuickSwitcherDismiss, true);
    window.removeEventListener("blur", window._zaoQuickSwitcherDismiss);
    delete window._zaoQuickSwitcherDismiss;
  }
};

const applyModelSwitch = (provider, model) => {
  const prefs = globalThis.Services?.prefs;
  if (!prefs) return;
  try {
    if (provider) prefs.setStringPref(CONFIG.AI_FALLBACK_PROVIDER_PREF, provider);
    const modelPrefMap = {
      chatgpt: CONFIG.AI_CHATGPT_MODEL_PREF,
      primalabs: CONFIG.AI_PRIMALABS_MODEL_PREF,
      openai: CONFIG.AI_OPENAI_MODEL_PREF,
      gemini: CONFIG.AI_GEMINI_MODEL_PREF,
      ollama: CONFIG.AI_OLLAMA_MODEL_PREF,
      custom: CONFIG.AI_CUSTOM_MODEL_PREF,
    };
    if (model && modelPrefMap[provider]) {
      prefs.setStringPref(modelPrefMap[provider], model);
    }
    if (provider && model) {
      const current = readFallbackProviderSettings(prefs);
      upsertProviderProfile(prefs, { ...current, id: provider, provider, model });
      recordRecentModel({ provider, model }, prefs);
    }
  } catch (e) {
    console.warn(`${LOG} quick switcher model change failed:`, e);
  }
  refreshWandTooltips();
};

const openAISettings = () => {
  try {
    if (typeof window.openPreferences === "function") {
      window.openPreferences("paneSineMods");
      return;
    }
    if (typeof window.openTrustedLinkIn === "function") {
      window.openTrustedLinkIn("about:preferences#sineMods", "tab");
      return;
    }
    if (window.gBrowser?.addTrustedTab) {
      window.gBrowser.selectedTab = window.gBrowser.addTrustedTab("about:preferences#sineMods");
    }
  } catch (e) {
    console.warn(`${LOG} could not open AI settings:`, e);
  }
};

const showQuickSwitcher = (anchorEvent, button) => {
  closeQuickSwitcher();
  const prefs = globalThis.Services?.prefs;
  const activeSettings = readFallbackProviderSettings(prefs);
  const activeLabel = describeActiveProviderModel();
  const currentReasoning = readReasoningPreference(prefs);
  const currentSortMode = getAISortMode();

  const popover = h("div", { class: "zao-quick-switcher" });
  popover.id = QUICK_SWITCHER_ID;
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", loc("KI-Schnellwechsel", "AI Quick Switcher"));
  Object.assign(popover.style, {
    position: "fixed",
    zIndex: "2147483647",
    minWidth: "240px",
    maxWidth: "320px",
    padding: "8px",
    borderRadius: "10px",
    background: "var(--arrowpanel-background, var(--toolbar-bgcolor, Menu))",
    color: "var(--arrowpanel-color, var(--toolbar-color, MenuText))",
    border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.28)",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    fontSize: "12px",
  });

  const makeHeader = (text) => {
    const el = h("div", { class: "zao-qs-heading", text });
    Object.assign(el.style, {
      fontSize: "11px",
      fontWeight: "600",
      opacity: "0.7",
      padding: "2px 6px",
    });
    return el;
  };

  const makeBtn = (text, { active = false, onClick } = {}) => {
    const btn = h("button", { class: "zao-qs-item", text });
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    Object.assign(btn.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      width: "100%",
      textAlign: "left",
      padding: "5px 8px",
      border: "none",
      borderRadius: "6px",
      background: active ? "color-mix(in srgb, var(--zen-primary-color, AccentColor) 22%, transparent)" : "transparent",
      color: "inherit",
      cursor: "pointer",
      fontSize: "12px",
      fontWeight: active ? "600" : "400",
    });
    btn.addEventListener("mouseenter", () => {
      if (!active) btn.style.background = "color-mix(in srgb, currentColor 10%, transparent)";
    });
    btn.addEventListener("mouseleave", () => {
      if (!active) btn.style.background = "transparent";
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick?.();
      closeQuickSwitcher();
    });
    return btn;
  };

  const makeDivider = () => {
    const hr = h("div");
    Object.assign(hr.style, {
      height: "1px",
      background: "color-mix(in srgb, currentColor 14%, transparent)",
      margin: "2px 0",
    });
    return hr;
  };

  // Active Provider · Model header
  const activeBox = h("div", { text: activeLabel || "Zen Tab Sorting" });
  Object.assign(activeBox.style, {
    fontWeight: "650",
    padding: "4px 6px",
    fontSize: "12px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  popover.appendChild(activeBox);

  // Favorites & Recent models
  const favorites = getFavoriteModels(prefs);
  const recents = getRecentModels(prefs);
  const seen = new Set();
  const quickModels = [];
  for (const item of [...favorites.map((f) => ({ ...f, fav: true })), ...recents]) {
    const key = `${item.provider}\0${item.model}`;
    if (!item.model || seen.has(key)) continue;
    seen.add(key);
    quickModels.push(item);
    if (quickModels.length >= 6) break;
  }

  if (quickModels.length > 0) {
    popover.appendChild(makeDivider());
    popover.appendChild(makeHeader(loc("Favoriten & Zuletzt verwendet", "Favorites & Recent")));
    for (const item of quickModels) {
      const preset = getProviderPreset(item.provider);
      const prefix = item.fav ? "★ " : "";
      const isCurrent = item.provider === activeSettings?.provider && item.model === activeSettings?.model;
      const label = `${prefix}${preset?.name || item.provider} · ${item.model}`;
      popover.appendChild(makeBtn(label, {
        active: isCurrent,
        onClick: () => applyModelSwitch(item.provider, item.model),
      }));
    }
  }

  // Reasoning toggle (Fast / Medium / High)
  popover.appendChild(makeDivider());
  popover.appendChild(makeHeader(loc("Reasoning-Stufe", "Reasoning effort")));
  const reasoningRow = h("div");
  Object.assign(reasoningRow.style, { display: "flex", gap: "4px", padding: "0 4px" });
  for (const [value, label] of [
    ["fast", loc("Schnell", "Fast")],
    ["medium", loc("Mittel", "Medium")],
    ["high", loc("Hoch", "High")],
  ]) {
    const chip = makeBtn(label, {
      active: currentReasoning === value,
      onClick: () => {
        try { prefs?.setStringPref?.(CONFIG.AI_REASONING_EFFORT_PREF, value); } catch {}
      },
    });
    chip.style.justifyContent = "center";
    chip.style.flex = "1";
    reasoningRow.appendChild(chip);
  }
  popover.appendChild(reasoningRow);

  // Sort Mode toggle
  popover.appendChild(makeDivider());
  popover.appendChild(makeHeader(loc("Sortiermodus", "Sort mode")));
  const modeRow = h("div");
  Object.assign(modeRow.style, { display: "flex", gap: "4px", padding: "0 4px" });
  for (const [value, label] of [
    ["rules-first", loc("Ungruppierte", "Ungrouped")],
    ["full-ai", loc("Alle Tabs", "All tabs")],
  ]) {
    const chip = makeBtn(label, {
      active: currentSortMode === value,
      onClick: () => {
        try { prefs?.setStringPref?.(CONFIG.AI_SORT_MODE_PREF, value); } catch {}
      },
    });
    chip.style.justifyContent = "center";
    chip.style.flex = "1";
    modeRow.appendChild(chip);
  }
  popover.appendChild(modeRow);

  // AI Settings…
  popover.appendChild(makeDivider());
  popover.appendChild(makeBtn(loc("KI-Einstellungen…", "AI Settings…"), {
    onClick: openAISettings,
  }));

  (document.body || document.documentElement).appendChild(popover);

  // Clamp coordinates inside viewport
  const rect = button?.getBoundingClientRect?.();
  const baseX = Number.isFinite(anchorEvent?.clientX) && anchorEvent.clientX > 0 ? anchorEvent.clientX : (rect?.right || 16);
  const baseY = Number.isFinite(anchorEvent?.clientY) && anchorEvent.clientY > 0 ? anchorEvent.clientY : (rect?.bottom || 16);
  const popRect = popover.getBoundingClientRect();
  const maxX = Math.max(8, (window.innerWidth || 800) - popRect.width - 12);
  const maxY = Math.max(8, (window.innerHeight || 600) - popRect.height - 12);
  popover.style.left = `${Math.min(Math.max(8, baseX), maxX)}px`;
  popover.style.top = `${Math.min(Math.max(8, baseY), maxY)}px`;

  window._zaoQuickSwitcherDismiss = (ev) => {
    if (ev.type === "keydown" && ev.key !== "Escape") return;
    if (ev.type === "mousedown" && popover.contains(ev.target)) return;
    closeQuickSwitcher();
  };
  window.addEventListener("mousedown", window._zaoQuickSwitcherDismiss, true);
  window.addEventListener("keydown", window._zaoQuickSwitcherDismiss, true);
  window.addEventListener("blur", window._zaoQuickSwitcherDismiss);
};

const onWandContextMenu = (event) => {
  const button = event.target?.closest?.(BUTTONS);
  if (!isOrganizeButton(button)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  showQuickSwitcher(event, button);
};

const dispatchOrganize = (event) => {
  const button = event.target?.closest?.(BUTTONS);
  if (!isOrganizeButton(button) || (event.type === "click" && event.button !== 0)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeQuickSwitcher();

  const card = libraryCard(button);
  // Clicking the wand while aria-busy="true" aborts the active sort session!
  if (!card && (button.getAttribute("aria-busy") === "true" || window._zaoSortSession)) {
    abortSortSession(window);
    refreshWandTooltips();
    return;
  }
  if (button.disabled || window._zaoSortSession) return;
  recordDebugEvent("BUTTON-CLICK", card ? "Library-Space sortieren" : "Aktiven Space sortieren");
  void handleOrganizeClick(card ? { workspaceId: card.dataset.uuid, fromLibrary: true } : {})
    .catch((error) => console.error(`${LOG} organize command failed:`, error))
    .finally(() => refreshWandTooltips());
};

// Both shapes share one fixed footprint; session state drives the soft change.
const WAND_ICON_SVG = `
  <svg class="zao-wand-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="1.75"
       stroke-linecap="round" stroke-linejoin="round">
    <path class="zao-wand-shaft" d="M3.5 20.5 17.5 6.5"/>
    <path class="zao-wand-collar" d="m13.5 7.5 3 3"/>
    <path class="zao-sparkle-1" d="M6 3Q6 6 3 6Q6 6 6 9Q6 6 9 6Q6 6 6 3Z"/>
    <path class="zao-sparkle-2" d="M18.5 14Q18.5 16.5 16 16.5Q18.5 16.5 18.5 19Q18.5 16.5 21 16.5Q18.5 16.5 18.5 14Z"/>
  </svg>
  <svg class="zao-loading-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
    <circle class="zao-loading-track" cx="12" cy="12" r="8.5"/>
    <circle class="zao-loading-arc" cx="12" cy="12" r="8.5"/>
  </svg>
  <svg class="zao-done-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 12.5 9.5 17 19 7.5"/>
  </svg>
`;

const buttonXul = () => `
  <toolbarbutton
    class="toolbarbutton-1 chromeclass-toolbar-additional zao-organize-button"
    command="${CONFIG.COMMAND_ID}"
    tooltiptext="Auto Sort Tabs">
    <hbox class="toolbarbutton-box zao-organize-icon" align="center">
      ${WAND_ICON_SVG}
    </hbox>
  </toolbarbutton>
`;

export const ensureOrganizeButton = (target) => {
  if (!target || libraryCard(target)) return null;
  const scope = target.matches?.(".zen-workspace-close-unpinned-tabs-button") ? target.parentElement : target;
  const existing = scope?.querySelector?.(`.zao-organize-button:not([data-zao-library-organize]), #${CONFIG.BUTTON_ID}`);
  if (existing) return existing;

  try {
    const nativeClearButton = target.matches?.(".zen-workspace-close-unpinned-tabs-button")
      ? target
      : target.querySelector?.(".zen-workspace-close-unpinned-tabs-button");

    const buttonFragment = window.MozXULElement.parseXULToFragment(buttonXul());
    const button = buttonFragment.firstChild;
    const tip = computeWandTooltip(button);
    button.setAttribute("tooltiptext", tip);
    button.setAttribute("aria-label", tip);
    updateSortButtonState(button, window);

    if (nativeClearButton && nativeClearButton.parentNode) {
      nativeClearButton.parentNode.insertBefore(button, nativeClearButton);
      return button;
    }
    if (target.classList?.contains("pinned-tabs-container-separator")) {
      target.appendChild(button);
      return button;
    }
    target.appendChild(button);
    return button;
  } catch (e) {
    console.error(`${LOG} ensureOrganizeButton error:`, e);
  }
  return null;
};

export const addButtonToAllSeparators = () => {
  try {
    // 1. Every native Clear button in the sidebar (places wand button directly to its left)
    const clearButtons = document.querySelectorAll(".zen-workspace-close-unpinned-tabs-button");
    for (const clearBtn of clearButtons) {
      if (libraryCard(clearBtn)) continue;
      if (!clearBtn.parentElement?.querySelector(`.zao-organize-button:not([data-zao-library-organize]), #${CONFIG.BUTTON_ID}`)) {
        ensureOrganizeButton(clearBtn);
      }
    }

    // 2. All separators across all workspaces
    const separators = domCache.getSeparators();
    if (separators && separators.length > 0) {
      separators.forEach(ensureOrganizeButton);
    }

    // 3. Active workspace pinned container
    const activePinned = window.gZenWorkspaces?.pinnedTabsContainer;
    if (activePinned) {
      const sep = activePinned.querySelector(".pinned-tabs-container-separator");
      if (sep) ensureOrganizeButton(sep);
    }

    // 4. Fallback if no button exists anywhere in the window
    if (!document.querySelector(`.zao-organize-button:not([data-zao-library-organize]), #${CONFIG.BUTTON_ID}`)) {
      const periphery = document.querySelector("#tabbrowser-arrowscrollbox-periphery");
      if (periphery) ensureOrganizeButton(periphery);
    }

    syncWorkspaceScopedButtonIds();
    reconcileLibraryButtons();
    for (const button of document.querySelectorAll(".zao-organize-button")) {
      updateSortButtonState(button, window);
    }
    refreshWandTooltips();
  } catch (e) {
    console.error(`${LOG} addButtonToAllSeparators error:`, e);
  }
};

const TOOLTIP_PREFS = [
  CONFIG.AI_FALLBACK_PROVIDER_PREF,
  CONFIG.AI_CHATGPT_MODEL_PREF,
  CONFIG.AI_PRIMALABS_MODEL_PREF,
  CONFIG.AI_OPENAI_MODEL_PREF,
  CONFIG.AI_GEMINI_MODEL_PREF,
  CONFIG.AI_OLLAMA_MODEL_PREF,
  CONFIG.AI_CUSTOM_MODEL_PREF,
  CONFIG.AI_PROVIDER_PROFILES_PREF,
];

export const setupCommand = () => {
  if (typeof window !== "undefined" && !window._zaoGlobalClickListener) {
    window._zaoGlobalClickListener = dispatchOrganize;
    window.addEventListener("click", window._zaoGlobalClickListener, true);
    window.addEventListener("command", window._zaoGlobalClickListener, true);
  }
  if (typeof window !== "undefined" && !window._zaoWandContextListener) {
    window._zaoWandContextListener = onWandContextMenu;
    window.addEventListener("contextmenu", window._zaoWandContextListener, true);
  }
  if (typeof window !== "undefined" && !window._zaoTooltipPrefObserver && globalThis.Services?.prefs) {
    window._zaoTooltipPrefObserver = {
      observe(_sub, topic) {
        if (topic === "nsPref:changed" && !window.closed) refreshWandTooltips();
      },
    };
    for (const pref of TOOLTIP_PREFS) {
      try { Services.prefs.addObserver(pref, window._zaoTooltipPrefObserver); } catch {}
    }
  }

  const library = document.querySelector("zen-library");
  if (library && !window._zaoLibraryButtonObserver) {
    window._zaoLibraryButtonObserver = new window.MutationObserver(scheduleLibraryReconcile);
    window._zaoLibraryButtonObserver.observe(library, { childList: true, subtree: true });
    reconcileLibraryButtons();
  }

  const zenCommands = domCache.getCommandSet();
  if (!zenCommands) return;

  if (!zenCommands.querySelector(`#${CONFIG.COMMAND_ID}`)) {
    try {
      const cmd = window.MozXULElement.parseXULToFragment(
        `<command id="${CONFIG.COMMAND_ID}"/>`,
      ).firstChild;
      zenCommands.appendChild(cmd);
    } catch (e) {
      console.error(`${LOG} command create error:`, e);
    }
  }

  if (!zenCommands._zaoCommandListener) {
    const listener = (event) => {
      if (event.target.id === CONFIG.COMMAND_ID) handleOrganizeClick();
    };
    zenCommands.addEventListener("command", listener);
    zenCommands._zaoCommandListener = listener;
  }
};

export const teardownOrganizeUI = () => {
  closeQuickSwitcher();
  if (libraryReconcileRaf != null) {
    window.cancelAnimationFrame?.(libraryReconcileRaf);
    libraryReconcileRaf = null;
  }
  window._zaoLibraryButtonObserver?.disconnect();
  delete window._zaoLibraryButtonObserver;
  if (window._zaoWorkspaceChangeListener) {
    window.removeEventListener("ZenWorkspaceChange", window._zaoWorkspaceChangeListener);
    delete window._zaoWorkspaceChangeListener;
  }
  if (window._zaoGlobalClickListener) {
    window.removeEventListener("click", window._zaoGlobalClickListener, true);
    window.removeEventListener("command", window._zaoGlobalClickListener, true);
    delete window._zaoGlobalClickListener;
  }
  if (window._zaoWandContextListener) {
    window.removeEventListener("contextmenu", window._zaoWandContextListener, true);
    delete window._zaoWandContextListener;
  }
  if (window._zaoTooltipPrefObserver && globalThis.Services?.prefs) {
    for (const pref of TOOLTIP_PREFS) {
      try { Services.prefs.removeObserver(pref, window._zaoTooltipPrefObserver); } catch {}
    }
    delete window._zaoTooltipPrefObserver;
  }
};

// Re-inject the tidy button on workspace changes (the separator element changes per workspace).
export const setupWorkspaceHooks = () => {
  if (typeof window.gZenWorkspaces === "undefined") return;
  if (window.gZenWorkspaces._zaoHooksInstalled) return;
  window.gZenWorkspaces._zaoHooksInstalled = true;

  const originalOnTabBrowserInserted = window.gZenWorkspaces.onTabBrowserInserted;
  const originalUpdateTabsContainers = window.gZenWorkspaces.updateTabsContainers;

  window.gZenWorkspaces.onTabBrowserInserted = function (event) {
    if (typeof originalOnTabBrowserInserted === "function") {
      try {
        originalOnTabBrowserInserted.call(window.gZenWorkspaces, event);
      } catch (e) {
        console.error(`${LOG} hook onTabBrowserInserted error:`, e);
      }
    }
    domCache.invalidate();
    addButtonToAllSeparators();
  };

  window.gZenWorkspaces.updateTabsContainers = function (...args) {
    if (typeof originalUpdateTabsContainers === "function") {
      try {
        originalUpdateTabsContainers.apply(window.gZenWorkspaces, args);
      } catch (e) {
        console.error(`${LOG} hook updateTabsContainers error:`, e);
      }
    }
    domCache.invalidate();
    addButtonToAllSeparators();
  };

  window._zaoWorkspaceChangeListener = () => {
    domCache.invalidate();
    addButtonToAllSeparators();
  };
  window.addEventListener("ZenWorkspaceChange", window._zaoWorkspaceChangeListener);
};
