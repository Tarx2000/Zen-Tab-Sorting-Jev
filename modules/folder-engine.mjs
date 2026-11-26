// Zen Tab Sorting — Built-in Zen Folder Engine (Option A, Q1–Q8).
//
// Clean, modular, Zia-compatible tab-group folder engine that recycles and
// improves the proven MIT-licensed core of `Advanced Tab Groups` (`folder-look`)
// without its 1.6MB Tabler pack, custom SVG uploader, Arc style, grain shader,
// favicon canvas sampler, or laggy `max-height: 4000px` hacks.
//
// Portions adapted from Advanced Tab Groups (MIT, Copyright (c) 2025 12th-devs,
// including folder-look by imthi).

import { LOG, HTML_NS, isZenColorName, isValidHex } from "./config.mjs";
import { NORMAL_GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";
import { applyGroupColor, moveTabsToTop } from "./groups.mjs";
import { captureNewGroupAppearance } from "./group-appearance.mjs";
import { saveGroupState } from "./group-state.mjs";
import { openColorPopover } from "./color-picker.mjs";
import { prefersReducedMotion, SETTLE_EASE } from "./sort-motion.mjs";
import { showToast } from "./ui-toast.mjs";
import { getLocale } from "./i18n.mjs";
import {
  isPlainTabGroup,
  getDomParentGroup,
  getGroupWorkspaceId,
  ensureGroupContainer,
  nestGroupUnder,
  unnestGroup,
  syncFolderRenameToWindows,
  syncFolderColorToWindows,
  syncFolderEmojiToWindows,
  syncFolderRemovalToWindows,
} from "./folder-sync.mjs";

// ─── Preference & Attribute Constants ────────────────────────────────────────

export const FOLDER_ENGINE_ENABLED_PREF = "extensions.zen-tab-sorting.folder-engine-enabled";
export const FOLDER_TAB_COUNT_PREF = "extensions.zen-tab-sorting.folder-tab-count";
export const FOLDER_GROUP_SHORTCUT_PREF = "extensions.zen-tab-sorting.folder-group-shortcut";
export const NATIVE_TAB_GROUPS_PREF = "browser.tabs.groups.enabled";

export const DEFAULT_FOLDER_SHORTCUT = "Ctrl+Shift+G";
export const DEFAULT_MAC_FOLDER_SHORTCUT = "Cmd+Shift+G";

export const ATTR_FOLDER_LOOK = "atg-folder-look";
export const ATTR_FOLDER_ACTIVE = "atg-folder-active";
export const ATTR_TAB_COUNT = "data-zao-tab-count";
export const ATTR_FOLDER_EMOJI = "data-zao-folder-emoji";
export const ATTR_COLLAPSING = "data-zao-collapsing";

const FOLDER_EMOJIS_KEY = "zen-tab-sorting-folder-emojis-v1";
const FOLDER_COLORS_KEY = "zen-tab-sorting-folder-colors-v1";
const CONTEXT_MENU_ID = "zao-folder-context-menu";
const LIBRARY_STYLE_ID = "zao-folder-engine-library-styles";
const COLLAPSED_GROUP_SELECTOR = "tab-group[collapsed]:not([split-view-group])";

const WINDOW_ENGINE_STATE = new WeakMap();
const ACTIVE_TOGGLE_ANIMS = new WeakMap();

// ─── Localization (uses i18n.mjs getLocale) ──────────────────────────────────

const STRINGS = {
  en: {
    atgConflictToast:
      "Advanced Tab Groups detected alongside Zen Tab Sorting's built-in Folder Engine. Please disable or remove Advanced Tab Groups in Sine to prevent conflicts.",
    ctxRename: "Rename",
    ctxChangeColor: "Change Color",
    ctxChooseEmoji: "Choose Emoji",
    ctxRemoveEmoji: "Remove Emoji",
    ctxCreateSubfolder: "Create Subfolder",
    ctxUnnestFolder: "Move Out of Parent Folder",
    ctxDissolveFolder: "Dissolve Folder",
    ctxCloseAllTabs: "Close All Tabs in Folder",
    newSubfolderName: "New Subfolder",
    newFolderName: "New Folder",
    emojiFallbackTitle: "Choose emoji",
    emojiFallbackPlaceholder: "Type or paste emoji…",
    emojiClear: "Clear",
  },
  de: {
    atgConflictToast:
      "Advanced Tab Groups wurde zusätzlich zur integrierten Ordner-Engine von Zen Tab Sorting erkannt. Bitte deaktiviere oder entferne Advanced Tab Groups in Sine, um Konflikte zu vermeiden.",
    ctxRename: "Umbenennen",
    ctxChangeColor: "Farbe ändern",
    ctxChooseEmoji: "Emoji wählen",
    ctxRemoveEmoji: "Emoji entfernen",
    ctxCreateSubfolder: "Unterordner erstellen",
    ctxUnnestFolder: "Aus übergeordnetem Ordner lösen",
    ctxDissolveFolder: "Ordner auflösen",
    ctxCloseAllTabs: "Alle Tabs im Ordner schließen",
    newSubfolderName: "Neuer Unterordner",
    newFolderName: "Neuer Ordner",
    emojiFallbackTitle: "Emoji wählen",
    emojiFallbackPlaceholder: "Emoji eingeben oder einfügen …",
    emojiClear: "Entfernen",
  },
};

const txt = (key, win = globalThis.window) => {
  const locale = getLocale(win);
  return STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? key;
};

// ─── Pure Helpers (exported & unit-tested) ───────────────────────────────────

const isMacPlatform = (win = globalThis.window) => {
  try {
    const plat = win?.navigator?.platform || globalThis.navigator?.platform || "";
    if (/mac/i.test(plat)) return true;
    const os = globalThis.Services?.appinfo?.OS || "";
    return os === "Darwin";
  } catch {
    return false;
  }
};

export const isFolderEngineEnabled = (prefs = globalThis.Services?.prefs) => {
  try {
    return prefs?.getBoolPref?.(FOLDER_ENGINE_ENABLED_PREF, true) ?? true;
  } catch {
    return true;
  }
};

export const isFolderTabCountEnabled = (prefs = globalThis.Services?.prefs) => {
  try {
    return prefs?.getBoolPref?.(FOLDER_TAB_COUNT_PREF, true) ?? true;
  } catch {
    return true;
  }
};

export const getFolderGroupShortcut = (
  prefs = globalThis.Services?.prefs,
  win = globalThis.window,
) => {
  const fallback = isMacPlatform(win) ? DEFAULT_MAC_FOLDER_SHORTCUT : DEFAULT_FOLDER_SHORTCUT;
  try {
    const raw = prefs?.getStringPref?.(FOLDER_GROUP_SHORTCUT_PREF, "") ?? "";
    const trimmed = String(raw).trim();
    return trimmed || fallback;
  } catch {
    return fallback;
  }
};

/**
 * Q2: Detect whether legacy `Advanced Tab Groups` (or its `folder-look` script)
 * is active in this window/global scope. Sets `win._zaoAtgConflictDetected`.
 * Our built-in Folder Engine always remains primary when enabled — never
 * silently coexists or steps back.
 */
export const detectAtgConflict = (win = globalThis.window) => {
  const sources = [];
  if (globalThis.advancedTabGroups) sources.push("globalThis.advancedTabGroups");
  if (win && win !== globalThis && win.advancedTabGroups) sources.push("window.advancedTabGroups");
  if (win?.atgFolderLook) sources.push("window.atgFolderLook");
  if (win?.document?.getElementById?.("advanced-tab-groups-context-menu")) {
    sources.push("#advanced-tab-groups-context-menu");
  }
  const conflict = sources.length > 0;
  if (win && typeof win === "object") {
    try { win._zaoAtgConflictDetected = conflict; } catch {}
  }
  return { conflict, sources };
};

/**
 * Wrap an emoji string into a safe base64 SVG data URL matching Zen's
 * `ZenEmojiPicker` `emojiAsSVG` format (with XML entity escaping).
 */
export const emojiToSvgDataUrl = (emoji) => {
  const raw = String(emoji ?? "").trim();
  if (!raw) return "";
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="28" font-size="28" x="0">${escaped}</text></svg>`;
  if (typeof Buffer !== "undefined") {
    return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  }
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
};

/**
 * Q7: Count direct non-placeholder, non-pinned, non-essential, non-copy tabs
 * owned directly by `groupEl` (excludes tabs inside nested subfolders or
 * split-view groups).
 */
export const countDirectFolderTabs = (groupEl) => {
  if (!groupEl?.querySelectorAll) return 0;
  let count = 0;
  for (const tab of groupEl.querySelectorAll("tab")) {
    if (tab.isConnected === false || isSidebarCopy(tab)) continue;
    if (typeof tab.closest === "function" && tab.closest("tab-group") !== groupEl) continue;
    if (tab.pinned) continue;
    if (tab.hasAttribute?.("zen-empty-tab")) continue;
    if (tab.hasAttribute?.("zen-glance-tab")) continue;
    if (tab.hasAttribute?.("zen-essential")) continue;
    if (tab.hasAttribute?.("cloned")) continue;
    count++;
  }
  return count;
};

/**
 * Parse a shortcut string such as `"Ctrl+Shift+G"`, `"Cmd+Shift+G"`, or
 * `"Alt+G"` into a normalized descriptor.
 */
export const parseFolderShortcut = (str) => {
  const spec = {
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    accel: false,
    key: null,
    keyLabel: "",
  };
  const parts = String(str ?? "")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") spec.ctrl = true;
    else if (lower === "cmd" || lower === "command" || lower === "meta" || lower === "super") spec.meta = true;
    else if (lower === "accel") spec.accel = true;
    else if (lower === "alt" || lower === "option") spec.alt = true;
    else if (lower === "shift") spec.shift = true;
    else if (spec.key === null) {
      spec.key = lower === "space" ? " " : lower;
      spec.keyLabel = part;
    }
  }
  return spec;
};

/**
 * Match a DOM KeyboardEvent against a parsed shortcut spec.
 * - `"Ctrl"` acts as cross-platform Accel (Ctrl on Win/Linux, Cmd or Ctrl on macOS)
 *   unless paired with explicit `"Cmd"`.
 * - `"Cmd"` / `"Meta"` requires `metaKey && !ctrlKey`.
 */
export const matchesFolderShortcut = (event, spec) => {
  if (!event || !spec?.key) return false;
  if (Boolean(event.altKey) !== Boolean(spec.alt)) return false;
  if (Boolean(event.shiftKey) !== Boolean(spec.shift)) return false;

  const wantsAccel = Boolean(spec.ctrl || spec.accel);
  const wantsMeta = Boolean(spec.meta);

  if (spec.accel && !spec.ctrl && !spec.meta) {
    if (!(event.ctrlKey || event.metaKey)) return false;
  } else if (wantsAccel && wantsMeta) {
    if (!(event.ctrlKey && event.metaKey)) return false;
  } else if (wantsAccel) {
    if (!(event.ctrlKey || event.metaKey)) return false;
  } else if (wantsMeta) {
    if (!event.metaKey || event.ctrlKey) return false;
  } else if (event.ctrlKey || event.metaKey) {
    return false;
  }

  const pressed = typeof event.key === "string" ? event.key.toLowerCase() : "";
  return Boolean(pressed) && pressed === spec.key.toLowerCase();
};

// ─── SessionStore persistence for custom folder emojis & user colors ─────────

const getSessionStore = () => {
  try {
    if (globalThis.SessionStore) return globalThis.SessionStore;
    if (typeof ChromeUtils !== "undefined") {
      return ChromeUtils.importESModule(
        "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
      ).SessionStore;
    }
  } catch {}
  return null;
};

const readWindowMap = (win, key) => {
  try {
    const ss = getSessionStore();
    const getter = ss?.getCustomWindowValue || ss?.getWindowValue;
    if (!getter) return {};
    const raw = getter.call(ss, win, key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const writeWindowMap = (win, key, map) => {
  try {
    const ss = getSessionStore();
    const setter = ss?.setCustomWindowValue || ss?.setWindowValue;
    if (!setter) return;
    setter.call(ss, win, key, JSON.stringify(map || {}));
  } catch (e) {
    console.warn(`${LOG} folder-engine failed to persist ${key}:`, e);
  }
};

// ─── Q4 GPU-Smooth Collapse / Expand Animation ───────────────────────────────

const resolveFolderEasing = (win, group) => {
  try {
    const ziaSpring = win?.getComputedStyle?.(group)?.getPropertyValue?.("--zia-spring")?.trim();
    if (ziaSpring) return ziaSpring;
  } catch {}
  return SETTLE_EASE;
};

const cancelActiveToggleAnimation = (group) => {
  const active = ACTIVE_TOGGLE_ANIMS.get(group);
  if (!active) return;
  ACTIVE_TOGGLE_ANIMS.delete(group);
  active.cancel();
};

/**
 * Q4: GPU-smooth collapse/expand transition using one-shot container height
 * measurement + WAAPI `transform: translate3d(0, -6px, 0)` + `opacity` stagger
 * on non-active child tabs. Keeps `[atg-folder-active]` tabs rock-steady and
 * never uses `max-height: 4000px`.
 */
export const animateFolderToggle = (win, group, collapsed) => {
  if (!group?.isConnected || win?.closed) return;
  cancelActiveToggleAnimation(group);

  if (prefersReducedMotion(win)) {
    group.removeAttribute?.(ATTR_COLLAPSING);
    return;
  }

  const container = group.querySelector?.(":scope > .tab-group-container");
  if (!container || typeof container.animate !== "function") {
    group.removeAttribute?.(ATTR_COLLAPSING);
    return;
  }

  const childItems = Array.from(container.children || []).filter((child) => {
    const tag = (child.localName || child.tagName || "").toLowerCase();
    if (tag !== "tab" && tag !== "tab-group") return false;
    if (child.hasAttribute?.("zen-empty-tab")) return false;
    // Keep active tabs (and nested groups containing one) completely steady!
    if (
      child.selected ||
      child.hasAttribute?.("selected") ||
      child.hasAttribute?.(ATTR_FOLDER_ACTIVE) ||
      (tag === "tab-group" && child.querySelector?.(`tab[selected], tab[${ATTR_FOLDER_ACTIVE}]`))
    ) {
      return false;
    }
    return true;
  });

  if (childItems.length === 0) {
    group.removeAttribute?.(ATTR_COLLAPSING);
    return;
  }

  const easing = resolveFolderEasing(win, group);
  const duration = collapsed ? 210 : 250;
  const anims = [];
  let finished = false;
  let safetyTimer = null;
  const setTimer = typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
  const clearTimer = typeof win.clearTimeout === "function" ? win.clearTimeout.bind(win) : clearTimeout;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (safetyTimer != null) {
      clearTimer(safetyTimer);
      safetyTimer = null;
    }
    for (const a of anims) {
      try { a.cancel(); } catch {}
    }
    anims.length = 0;
    container.style.removeProperty("overflow");
    container.style.removeProperty("height");
    group.removeAttribute?.(ATTR_COLLAPSING);
    if (ACTIVE_TOGGLE_ANIMS.get(group)?.cancel === cleanup) {
      ACTIVE_TOGGLE_ANIMS.delete(group);
    }
  };

  ACTIVE_TOGGLE_ANIMS.set(group, { cancel: cleanup });

  try {
    if (collapsed) {
      // Hold non-active items visible during the short collapse animation, then release.
      group.setAttribute(ATTR_COLLAPSING, "true");
      const fullHeight = Math.max(0, Math.round(container.scrollHeight || 0));
      const activeHeight = Array.from(container.children || []).reduce((sum, child) => {
        if (childItems.includes(child)) return sum;
        return sum + Math.round(child.getBoundingClientRect?.().height || 0);
      }, 0);

      if (fullHeight > activeHeight) {
        container.style.overflow = "hidden";
        const cAnim = container.animate(
          [{ height: `${fullHeight}px` }, { height: `${activeHeight}px` }],
          { duration, easing, fill: "forwards" },
        );
        anims.push(cAnim);
      }

      const maxAnimated = Math.min(childItems.length, 8);
      for (let i = 0; i < maxAnimated; i++) {
        const item = childItems[i];
        if (typeof item.animate !== "function") continue;
        const a = item.animate(
          [
            { opacity: 1, transform: "translate3d(0, 0, 0)" },
            { opacity: 0, transform: "translate3d(0, -6px, 0)" },
          ],
          { duration: Math.max(140, duration - 30), easing, fill: "forwards" },
        );
        anims.push(a);
      }
    } else {
      group.removeAttribute?.(ATTR_COLLAPSING);
      const targetHeight = Math.max(0, Math.round(container.scrollHeight || 0));
      const activeHeight = Array.from(container.children || []).reduce((sum, child) => {
        if (childItems.includes(child)) return sum;
        return sum + Math.round(child.getBoundingClientRect?.().height || 0);
      }, 0);

      if (targetHeight > activeHeight) {
        container.style.overflow = "hidden";
        const cAnim = container.animate(
          [{ height: `${activeHeight}px` }, { height: `${targetHeight}px` }],
          { duration, easing },
        );
        anims.push(cAnim);
      }

      const maxAnimated = Math.min(childItems.length, 8);
      for (let i = 0; i < maxAnimated; i++) {
        const item = childItems[i];
        if (typeof item.animate !== "function") continue;
        const delay = Math.min(i * 14, 98);
        const a = item.animate(
          [
            { opacity: 0, transform: "translate3d(0, -6px, 0)" },
            { opacity: 1, transform: "translate3d(0, 0, 0)" },
          ],
          { duration: Math.max(160, duration - delay * 0.3), delay, easing, fill: "backwards" },
        );
        anims.push(a);
      }
    }

    if (anims.length === 0) {
      cleanup();
      return;
    }

    safetyTimer = setTimer(cleanup, duration + 160);
    Promise.allSettled(anims.map((a) => a.finished)).then(cleanup);
  } catch {
    cleanup();
  }
};

// ─── Inline Folder Rename ────────────────────────────────────────────────────

export const startInlineRename = (win, group, { selectAll = true } = {}) => {
  const doc = win?.document;
  if (!doc || !group?.isConnected || !isPlainTabGroup(group)) return;

  // Finish/clear any existing rename input in this window.
  const existing = doc.querySelector?.(".zao-folder-rename-input");
  if (existing && typeof existing._zaoCancel === "function") {
    existing._zaoCancel();
  }

  const labelEl = group.querySelector?.(":scope > .tab-group-label-container > .tab-group-label");
  if (!labelEl) return;

  const originalLabel = (group.label || group.getAttribute?.("label") || "").replace(/\u200b/g, "");
  const input = typeof doc.createElementNS === "function"
    ? doc.createElementNS(HTML_NS, "input")
    : doc.createElement("input");
  input.type = "text";
  input.className = "zao-folder-rename-input";
  input.value = originalLabel;
  input.setAttribute("autocomplete", "off");
  input.spellcheck = false;

  doc.documentElement?.setAttribute?.("data-zao-renaming-folder", "true");
  labelEl.style.display = "none";
  labelEl.after(input);

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    doc.documentElement?.removeAttribute?.("data-zao-renaming-folder");
    try { input.remove(); } catch {}
    labelEl.style.display = "";

    if (commit) {
      const next = input.value.trim();
      if (next && next !== originalLabel) {
        try { group.label = next; } catch { group.setAttribute?.("label", next); }
        saveGroupState(win);
        if (group.id) syncFolderRenameToWindows(win, group.id, next);
      }
    }
  };

  input._zaoCancel = () => finish(false);

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));

  try { input.focus(); } catch {}
  if (selectAll && input.value) {
    try { input.select(); } catch {}
  } else {
    try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  }
};

// ─── Core Folder Engine Lifecycle ────────────────────────────────────────────

const resolveLibraryCssUrl = () => {
  try {
    return new URL("../styles/folder-library.css", import.meta.url).href;
  } catch {
    return "chrome://sine/content/zen-tab-sorting/styles/folder-library.css";
  }
};

const isSelectedLikeTab = (tab) =>
  Boolean(
    tab?.selected ||
    (tab?.group?.hasAttribute?.("split-view-group") && tab.group.querySelector?.("tab[selected]")),
  );

const getGroupableSelectedTabs = (win) => {
  const gBrowser = win?.gBrowser;
  if (!gBrowser) return [];
  let raw = [];
  try {
    if (typeof gBrowser.getSelectedTabs === "function") {
      try { raw = gBrowser.getSelectedTabs({ sorted: false }) || []; }
      catch { raw = gBrowser.selectedTabs || []; }
    } else {
      raw = gBrowser.selectedTabs || [];
    }
    if (!raw.length && gBrowser.selectedTab) raw = [gBrowser.selectedTab];
  } catch {
    raw = [];
  }
  const seen = new Set();
  const out = [];
  for (const tab of raw) {
    if (!tab || seen.has(tab)) continue;
    seen.add(tab);
    const isTab = typeof gBrowser.isTab === "function" ? gBrowser.isTab(tab) : tab.localName === "tab";
    if (!isTab) continue;
    if (tab.pinned) continue;
    if (tab.hasAttribute?.("zen-empty-tab") || tab.hasAttribute?.("zen-essential") || tab.hasAttribute?.("cloned")) {
      continue;
    }
    if (tab.group?.hasAttribute?.("split-view-group") || tab.splitView) continue;
    out.push(tab);
  }
  out.sort((a, b) => (a._tPos ?? 0) - (b._tPos ?? 0));
  return out;
};

export const setupFolderEngine = (win = globalThis.window) => {
  if (!win?.document || WINDOW_ENGINE_STATE.has(win)) return;

  const doc = win.document;
  const state = {
    running: false,
    disposed: false,
    tabObserver: null,
    browserObserver: null,
    libraryObserver: null,
    libraryRoot: null,
    rafId: null,
    libraryRaf: null,
    conflictTimer: null,
    conflictWarned: false,
    listeners: [],
    contextMenu: null,
    activeContextGroup: null,
    prefObserver: null,
    savedEmojis: {},
    savedColors: {},
  };
  WINDOW_ENGINE_STATE.set(win, state);

  const setTimer = typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
  const clearTimer = typeof win.clearTimeout === "function" ? win.clearTimeout.bind(win) : clearTimeout;

  const listen = (target, type, handler, capture = false) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, capture);
    state.listeners.push([target, type, handler, capture]);
  };

  const getIconTemplate = () => win.customElements?.get?.("zen-folder")?.rawIcon ?? null;

  // ── Q2 ATG Conflict Check ──
  const checkAtgConflict = () => {
    if (state.disposed || win.closed) return;
    const { conflict, sources } = detectAtgConflict(win);
    if (conflict && !state.conflictWarned) {
      state.conflictWarned = true;
      console.warn(
        `${LOG} folder-engine conflict: Advanced Tab Groups detected (${sources.join(", ")}). ` +
        `Built-in Folder Engine stays primary; please disable Advanced Tab Groups in Sine.`,
      );
      showToast(txt("atgConflictToast", win), {
        type: "warning",
        duration: 9500,
        targetWindow: win,
      });
    }
  };

  // ── Folder visual state & emoji/color helpers ──
  const syncFolderSvgIcon = (group) => {
    const svg = group?.querySelector?.(":scope > .tab-group-label-container > .tab-group-folder-icon > svg");
    const image = svg?.querySelector?.(".icon image");
    if (!image) return;
    const emoji = group.getAttribute?.(ATTR_FOLDER_EMOJI) || state.savedEmojis[group.id] || "";
    const href = emoji ? emojiToSvgDataUrl(emoji) : "";
    if ((image.getAttribute("href") || "") !== href) {
      if (href) image.setAttribute("href", href);
      else image.removeAttribute("href");
    }
  };

  const updateGroupIconState = (group) => {
    if (!isPlainTabGroup(group)) return;
    const svg = group.querySelector?.(":scope > .tab-group-label-container > .tab-group-folder-icon > svg");
    if (!svg) return;
    const collapsed = group.hasAttribute?.("collapsed");
    svg.setAttribute("state", collapsed ? "close" : "open");
    const hasActive =
      collapsed && Boolean(group.querySelector?.(`tab[selected], tab[${ATTR_FOLDER_ACTIVE}]`));
    svg.setAttribute("active", hasActive ? "true" : "false");
  };

  const updateGroupStateWithAncestors = (el) => {
    let group = isPlainTabGroup(el) ? el : el?.closest?.(NORMAL_GROUP_SELECTOR) || null;
    while (group && isPlainTabGroup(group)) {
      updateGroupIconState(group);
      group = getDomParentGroup(group);
    }
  };

  const markSelectedTabsInGroup = (group) => {
    for (const tab of group.querySelectorAll?.("tab") || []) {
      if (isSelectedLikeTab(tab)) tab.setAttribute(ATTR_FOLDER_ACTIVE, "true");
    }
  };

  const updateGroupTabCount = (group) => {
    if (!isPlainTabGroup(group)) return;
    const count = countDirectFolderTabs(group);
    const str = String(count);
    if (group.getAttribute?.(ATTR_TAB_COUNT) !== str) {
      group.setAttribute?.(ATTR_TAB_COUNT, str);
    }
    const labelContainer = group.querySelector?.(":scope > .tab-group-label-container");
    if (!labelContainer) return;
    let badge = labelContainer.querySelector?.(":scope > .zao-folder-tab-count");
    if (!badge) {
      badge = typeof doc.createElementNS === "function"
        ? doc.createElementNS(HTML_NS, "span")
        : doc.createElement("span");
      badge.className = "zao-folder-tab-count";
      badge.setAttribute("aria-hidden", "true");
      labelContainer.appendChild(badge);
    }
    if (badge.textContent !== str) badge.textContent = str;
  };

  const decorateGroup = (group) => {
    if (!isPlainTabGroup(group) || !group.isConnected) return;
    const labelContainer = group.querySelector?.(":scope > .tab-group-label-container");
    if (!labelContainer) return;

    if (group.hasAttribute?.("collapsed")) markSelectedTabsInGroup(group);

    if (!labelContainer.querySelector?.(":scope > .tab-group-folder-icon")) {
      const template = getIconTemplate();
      if (template) {
        const holder = typeof doc.createElementNS === "function"
          ? doc.createElementNS(HTML_NS, "div")
          : doc.createElement("div");
        holder.className = "tab-group-folder-icon";
        holder.appendChild(template.cloneNode(true));
        labelContainer.prepend(holder);
      }
    }

    group.setAttribute(ATTR_FOLDER_LOOK, "true");

    // Reapply persisted emoji/color if present for this group ID.
    if (group.id) {
      const savedEmoji = state.savedEmojis[group.id];
      if (savedEmoji && group.getAttribute(ATTR_FOLDER_EMOJI) !== savedEmoji) {
        group.setAttribute(ATTR_FOLDER_EMOJI, savedEmoji);
      }
      const savedColor = state.savedColors[group.id];
      if (savedColor && !group._zaoSavedColorApplied) {
        group._zaoSavedColorApplied = true;
        applyGroupColor(group, savedColor);
      }
    }

    syncFolderSvgIcon(group);
    updateGroupTabCount(group);
    updateGroupIconState(group);
  };

  const scheduleRefreshAll = () => {
    if (state.disposed || !state.running || state.rafId !== null) return;
    const run = () => {
      state.rafId = null;
      if (state.disposed || !state.running || win.closed) return;
      const container = win.gBrowser?.tabContainer;
      if (!container) return;
      for (const group of container.querySelectorAll?.(NORMAL_GROUP_SELECTOR) || []) {
        decorateGroup(group);
      }
    };
    if (typeof win.requestAnimationFrame === "function") {
      state.rafId = win.requestAnimationFrame(run);
    } else {
      state.rafId = setTimer(run, 0);
    }
  };

  const onGroupCollapsedChanged = (group) => {
    const collapsed = group.hasAttribute?.("collapsed");
    if (collapsed) {
      markSelectedTabsInGroup(group);
    } else {
      for (const tab of group.querySelectorAll?.(`tab[${ATTR_FOLDER_ACTIVE}]`) || []) {
        if (!tab.closest?.(COLLAPSED_GROUP_SELECTOR)) {
          tab.removeAttribute(ATTR_FOLDER_ACTIVE);
        }
      }
    }
    updateGroupStateWithAncestors(group);
    animateFolderToggle(win, group, collapsed);
  };

  // ── Emoji & Color setters ──
  const setFolderEmoji = (group, emoji, { sync = true } = {}) => {
    if (!isPlainTabGroup(group)) return;
    const cleaned = String(emoji ?? "").trim();
    if (cleaned) {
      group.setAttribute(ATTR_FOLDER_EMOJI, cleaned);
      if (group.id) {
        state.savedEmojis[group.id] = cleaned;
        writeWindowMap(win, FOLDER_EMOJIS_KEY, state.savedEmojis);
      }
    } else {
      group.removeAttribute(ATTR_FOLDER_EMOJI);
      if (group.id && Object.hasOwn(state.savedEmojis, group.id)) {
        delete state.savedEmojis[group.id];
        writeWindowMap(win, FOLDER_EMOJIS_KEY, state.savedEmojis);
      }
    }
    syncFolderSvgIcon(group);
    if (sync && group.id) syncFolderEmojiToWindows(win, group.id, cleaned || null);
    try { doc.querySelector?.("zen-library")?.update?.(true); } catch {}
  };

  const setFolderColor = (group, color, { sync = true } = {}) => {
    if (!isPlainTabGroup(group)) return;
    const valid = color && (isZenColorName(color) || isValidHex(color)) ? color : null;
    applyGroupColor(group, valid);
    if (group.id) {
      if (valid) state.savedColors[group.id] = valid;
      else delete state.savedColors[group.id];
      writeWindowMap(win, FOLDER_COLORS_KEY, state.savedColors);
    }
    if (sync && group.id) syncFolderColorToWindows(win, group.id, valid);
    try { doc.querySelector?.("zen-library")?.update?.(true); } catch {}
  };

  const removePersistedFolderMeta = (groupId) => {
    if (!groupId) return;
    if (Object.hasOwn(state.savedEmojis, groupId)) {
      delete state.savedEmojis[groupId];
      writeWindowMap(win, FOLDER_EMOJIS_KEY, state.savedEmojis);
    }
    if (Object.hasOwn(state.savedColors, groupId)) {
      delete state.savedColors[groupId];
      writeWindowMap(win, FOLDER_COLORS_KEY, state.savedColors);
    }
  };

  // ── Native Zen Emoji Picker (with lightweight inline fallback) ──
  const openFolderEmojiPicker = (group) => {
    const anchor =
      group.querySelector?.(":scope > .tab-group-label-container > .tab-group-folder-icon") ||
      group.querySelector?.(":scope > .tab-group-label-container") ||
      group;

    const picker = win.gZenEmojiPicker;
    if (picker && typeof picker.open === "function") {
      try {
        const result = picker.open(anchor, {
          onlySvgIcons: false,
          onSelect: (value) => {
            const picked = typeof value === "string" ? value.trim() : "";
            setFolderEmoji(group, picked || null);
          },
        });
        Promise.resolve(result)
          .then((value) => {
            if (typeof value === "string") setFolderEmoji(group, value.trim() || null);
          })
          .catch(() => {});
        return;
      } catch (e) {
        console.warn(`${LOG} gZenEmojiPicker.open failed, using fallback:`, e);
      }
    }

    // Minimal fallback popover if ZenEmojiPicker is unavailable
    doc.querySelector?.(".zao-emoji-fallback-popover")?.remove?.();
    const pop = typeof doc.createElementNS === "function"
      ? doc.createElementNS(HTML_NS, "div")
      : doc.createElement("div");
    pop.className = "zao-move-folder-popover zao-emoji-fallback-popover";
    pop.style.width = "220px";

    const input = typeof doc.createElementNS === "function"
      ? doc.createElementNS(HTML_NS, "input")
      : doc.createElement("input");
    input.type = "text";
    input.className = "zao-mf-search";
    input.placeholder = txt("emojiFallbackPlaceholder", win);
    input.value = group.getAttribute?.(ATTR_FOLDER_EMOJI) || "";

    const clearBtn = typeof doc.createElementNS === "function"
      ? doc.createElementNS(HTML_NS, "button")
      : doc.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "zao-mf-item";
    clearBtn.textContent = txt("emojiClear", win);

    const close = () => {
      doc.removeEventListener("mousedown", onOutside, true);
      pop.remove();
    };
    const onOutside = (e) => { if (!pop.contains(e.target)) close(); };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        setFolderEmoji(group, input.value.trim() || null);
        close();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setFolderEmoji(group, null);
      close();
    });

    pop.append(input, clearBtn);
    (doc.body || doc.documentElement).appendChild(pop);
    const rect = anchor.getBoundingClientRect?.() || { left: 120, bottom: 120 };
    pop.style.left = `${Math.max(10, Math.round(rect.left))}px`;
    pop.style.top = `${Math.max(10, Math.round((rect.bottom || rect.top || 100) + 6))}px`;
    setTimer(() => {
      doc.addEventListener("mousedown", onOutside, true);
      input.focus?.();
    }, 0);
  };

  // ── Folder Color Picker (uses modules/color-picker.mjs) ──
  const openFolderColorPicker = (group) => {
    const labelContainer = group.querySelector?.(":scope > .tab-group-label-container") || group;
    const currentColor =
      state.savedColors[group.id] ||
      group.style?.getPropertyValue?.("--tab-group-color")?.trim() ||
      group.color ||
      undefined;

    // Tiny invisible anchor so updateSwatchAppearance never mutates the folder header.
    const anchor = typeof doc.createElementNS === "function"
      ? doc.createElementNS(HTML_NS, "span")
      : doc.createElement("span");
    anchor.style.cssText =
      "position:absolute;left:28px;top:100%;width:1px;height:1px;opacity:0;pointer-events:none;";
    labelContainer.appendChild(anchor);

    const proxyRule = currentColor ? { color: currentColor } : {};
    openColorPopover(proxyRule, anchor, () => {
      setFolderColor(group, proxyRule.color || null);
    });

    // Clean up anchor once the popover closes.
    const pop = doc.querySelector?.(".zao-color-popover");
    if (pop && typeof pop._zaoClose === "function") {
      const origClose = pop._zaoClose;
      pop._zaoClose = () => {
        origClose();
        anchor.remove();
      };
    } else {
      setTimer(() => anchor.remove(), 10000);
    }
  };

  // ── Subfolder creation, dissolve, close all ──
  const createSubfolderUnder = (parentGroup) => {
    if (!isPlainTabGroup(parentGroup)) return null;
    try {
      const sub = doc.createXULElement("tab-group");
      sub.id = `zao-sub-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const name = txt("newSubfolderName", win);
      try { sub.label = name; } catch { sub.setAttribute("label", name); }
      const wsId = getGroupWorkspaceId(parentGroup, win);
      if (wsId) sub.setAttribute("zen-workspace-id", wsId);
      ensureGroupContainer(sub, doc);

      // Expand parent so the newly created subfolder is immediately visible for renaming.
      if (parentGroup.hasAttribute?.("collapsed")) {
        try { parentGroup.collapsed = false; } catch { parentGroup.removeAttribute("collapsed"); }
      }

      if (!nestGroupUnder(sub, parentGroup, { win, save: true, sync: true })) {
        sub.remove();
        return null;
      }
      captureNewGroupAppearance(sub);
      decorateGroup(sub);
      setTimer(() => startInlineRename(win, sub, { selectAll: true }), 0);
      return sub;
    } catch (e) {
      console.error(`${LOG} folder-engine createSubfolderUnder error:`, e);
      return null;
    }
  };

  const dissolveFolder = (group) => {
    if (!isPlainTabGroup(group)) return;
    const wsId = getGroupWorkspaceId(group, win);
    const directTabs = Array.from(group.querySelectorAll?.("tab") || []).filter(
      (tab) => tab.closest?.("tab-group") === group && !tab.hasAttribute?.("zen-empty-tab"),
    );
    // Unnest any child subfolders first so they aren't destroyed.
    for (const childGroup of Array.from(group.querySelectorAll?.(":scope > .tab-group-container > tab-group") || [])) {
      if (isPlainTabGroup(childGroup)) unnestGroup(childGroup, { win, save: false, sync: true });
    }
    if (directTabs.length > 0 && wsId) {
      moveTabsToTop(directTabs, wsId);
    }
    const id = group.id;
    setTimer(() => {
      if (win.closed) return;
      if (group.isConnected && !group.querySelector?.("tab")) {
        try { group.remove(); } catch {}
      }
      removePersistedFolderMeta(id);
      if (id) syncFolderRemovalToWindows(win, id);
      saveGroupState(win);
    }, 40);
  };

  const closeAllTabsInFolder = (group) => {
    if (!isPlainTabGroup(group)) return;
    const id = group.id;
    try {
      if (typeof win.gBrowser?.removeTabGroup === "function") {
        win.gBrowser.removeTabGroup(group);
      } else {
        for (const tab of Array.from(group.querySelectorAll?.("tab") || [])) {
          win.gBrowser?.removeTab?.(tab);
        }
        if (group.isConnected) group.remove();
      }
      removePersistedFolderMeta(id);
      if (id) syncFolderRemovalToWindows(win, id);
      saveGroupState(win);
    } catch (e) {
      console.error(`${LOG} folder-engine closeAllTabsInFolder error:`, e);
    }
  };

  // ── Q7 Folder Right-Click Context Menu ──
  const ensureContextMenu = () => {
    if (state.contextMenu?.isConnected) return state.contextMenu;
    doc.getElementById?.(CONTEXT_MENU_ID)?.remove?.();

    const popup = doc.createXULElement("menupopup");
    popup.id = CONTEXT_MENU_ID;

    const addItem = (id, labelKey, onCommand) => {
      const item = doc.createXULElement("menuitem");
      item.id = id;
      item.setAttribute("label", txt(labelKey, win));
      item.addEventListener("command", () => {
        const g = state.activeContextGroup;
        if (g?.isConnected) onCommand(g);
      });
      popup.appendChild(item);
      return item;
    };

    const renameItem = addItem("zao-folder-ctx-rename", "ctxRename", (g) => startInlineRename(win, g));
    const colorItem = addItem("zao-folder-ctx-color", "ctxChangeColor", (g) => openFolderColorPicker(g));
    const emojiItem = addItem("zao-folder-ctx-emoji", "ctxChooseEmoji", (g) => openFolderEmojiPicker(g));
    const removeEmojiItem = addItem("zao-folder-ctx-remove-emoji", "ctxRemoveEmoji", (g) => setFolderEmoji(g, null));
    const subfolderItem = addItem("zao-folder-ctx-subfolder", "ctxCreateSubfolder", (g) => createSubfolderUnder(g));
    const unnestItem = addItem("zao-folder-ctx-unnest", "ctxUnnestFolder", (g) => unnestGroup(g, { win }));

    popup.appendChild(doc.createXULElement("menuseparator"));
    const dissolveItem = addItem("zao-folder-ctx-dissolve", "ctxDissolveFolder", (g) => dissolveFolder(g));
    const closeAllItem = addItem("zao-folder-ctx-close-all", "ctxCloseAllTabs", (g) => closeAllTabsInFolder(g));

    popup.addEventListener("popupshowing", () => {
      const g = state.activeContextGroup;
      renameItem.setAttribute("label", txt("ctxRename", win));
      colorItem.setAttribute("label", txt("ctxChangeColor", win));
      emojiItem.setAttribute("label", txt("ctxChooseEmoji", win));
      removeEmojiItem.setAttribute("label", txt("ctxRemoveEmoji", win));
      subfolderItem.setAttribute("label", txt("ctxCreateSubfolder", win));
      unnestItem.setAttribute("label", txt("ctxUnnestFolder", win));
      dissolveItem.setAttribute("label", txt("ctxDissolveFolder", win));
      closeAllItem.setAttribute("label", txt("ctxCloseAllTabs", win));

      removeEmojiItem.hidden = !g?.getAttribute?.(ATTR_FOLDER_EMOJI);
      unnestItem.hidden = !getDomParentGroup(g);
    });

    popup.addEventListener("popuphidden", () => {
      setTimer(() => { state.activeContextGroup = null; }, 100);
    });

    const popupset = doc.getElementById?.("mainPopupSet") || doc.body || doc.documentElement;
    popupset.appendChild(popup);
    state.contextMenu = popup;
    return popup;
  };

  // ── Q7 Keyboard Shortcut: Group Selected Tabs & Focus Inline Rename ──
  const onWindowKeydown = (e) => {
    if (!state.running || e.defaultPrevented) return;
    const target = e.target;
    const tag = target?.tagName?.toLowerCase?.();
    if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
    if (target?.closest?.(".zao-folder-rename-input, #urlbar-input, .urlbar-input, #zen-search-input")) return;
    if (doc.documentElement?.hasAttribute?.("data-zao-renaming-folder")) return;

    const shortcutStr = getFolderGroupShortcut(globalThis.Services?.prefs, win);
    const spec = parseFolderShortcut(shortcutStr);
    if (!matchesFolderShortcut(e, spec)) return;

    const tabs = getGroupableSelectedTabs(win);
    // Keep Ctrl/Cmd+Shift+G free for Find Previous when fewer than 2 tabs are selected.
    if (tabs.length < 2) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      const newGroup = win.gBrowser?.addTabGroup?.(tabs, {
        label: txt("newFolderName", win),
        insertBefore: tabs[0],
      });
      if (newGroup) {
        captureNewGroupAppearance(newGroup);
        decorateGroup(newGroup);
        saveGroupState(win);
        setTimer(() => startInlineRename(win, newGroup, { selectAll: true }), 0);
      }
    } catch (err) {
      console.error(`${LOG} folder-engine shortcut grouping failed:`, err);
    }
  };

  // ── Zen Library Shadow-DOM integration ──
  const updateLibraryGroupState = (wrapper) => {
    const svg = wrapper.querySelector?.(":scope > .library-workspace-item.atg-tab-group > .tab-group-folder-icon > svg");
    if (!svg) return;
    const collapsed = wrapper.classList.contains("collapsed");
    svg.setAttribute("state", collapsed ? "close" : "open");
    const header = wrapper.querySelector?.(":scope > .library-workspace-item.atg-tab-group");
    const hasActive =
      collapsed &&
      (header?.classList.contains("selected") || Boolean(wrapper.querySelector?.(`.library-workspace-item.${ATTR_FOLDER_ACTIVE}`)));
    svg.setAttribute("active", hasActive ? "true" : "false");
  };

  const decorateLibrary = (root) => {
    const template = getIconTemplate();
    for (const wrapper of root.querySelectorAll?.(".library-workspace-tab-group") || []) {
      const header = wrapper.querySelector?.(":scope > .library-workspace-item.atg-tab-group");
      if (!header) continue;
      if (!header.querySelector?.(":scope > .tab-group-folder-icon") && template) {
        const holder = typeof doc.createElementNS === "function"
          ? doc.createElementNS(HTML_NS, "span")
          : doc.createElement("span");
        holder.className = "tab-group-folder-icon folder-icon";
        holder.appendChild(template.cloneNode(true));
        header.prepend(holder);
      }
      wrapper.setAttribute(ATTR_FOLDER_LOOK, "true");
      for (const row of wrapper.querySelectorAll?.(".library-workspace-item:not(.atg-tab-group)") || []) {
        row.classList.toggle(ATTR_FOLDER_ACTIVE, Boolean(row._libraryDropItem?.hasAttribute?.(ATTR_FOLDER_ACTIVE)));
      }
      for (const nested of wrapper.querySelectorAll?.(".library-workspace-tab-group") || []) {
        const nestedHeader = nested.querySelector?.(":scope > .library-workspace-item.atg-tab-group");
        nestedHeader?.classList.toggle(
          ATTR_FOLDER_ACTIVE,
          Boolean(nested.querySelector?.(`.library-workspace-item.${ATTR_FOLDER_ACTIVE}:not(.atg-tab-group)`)),
        );
      }
      updateLibraryGroupState(wrapper);
    }
  };

  const attachLibrary = () => {
    if (!state.running) return;
    const root = doc.querySelector?.("zen-library")?.shadowRoot ?? null;
    if (root === state.libraryRoot) return;
    state.libraryObserver?.disconnect();
    state.libraryObserver = null;
    state.libraryRoot = root;
    if (!root) return;

    if (!root.getElementById?.(LIBRARY_STYLE_ID)) {
      const link = doc.createElement("link");
      link.id = LIBRARY_STYLE_ID;
      link.rel = "stylesheet";
      link.href = resolveLibraryCssUrl();
      root.appendChild(link);
    }

    const scheduleLib = () => {
      if (state.libraryRaf !== null || !state.running) return;
      const run = () => {
        state.libraryRaf = null;
        if (state.libraryRoot && state.running) decorateLibrary(state.libraryRoot);
      };
      if (typeof win.requestAnimationFrame === "function") {
        state.libraryRaf = win.requestAnimationFrame(run);
      } else {
        state.libraryRaf = setTimer(run, 0);
      }
    };

    state.libraryObserver = new win.MutationObserver(scheduleLib);
    state.libraryObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    scheduleLib();
  };

  // ── Start / Stop Engine ──
  const syncRootAttributes = () => {
    doc.documentElement?.toggleAttribute?.("data-zao-folder-engine", state.running);
    doc.documentElement?.toggleAttribute?.(
      "data-zao-folder-tab-count",
      state.running && isFolderTabCountEnabled(),
    );
  };

  const startEngine = () => {
    if (state.running || state.disposed || win.closed) return;
    state.running = true;

    // Enable native Firefox/Zen tab groups so folders always work.
    try {
      globalThis.Services?.prefs?.setBoolPref?.(NATIVE_TAB_GROUPS_PREF, true);
    } catch {}

    state.savedEmojis = readWindowMap(win, FOLDER_EMOJIS_KEY);
    state.savedColors = readWindowMap(win, FOLDER_COLORS_KEY);
    syncRootAttributes();

    // Check immediately and once after load in case ATG initializes asynchronously.
    checkAtgConflict();
    state.conflictTimer = setTimer(checkAtgConflict, 1500);

    const container = win.gBrowser?.tabContainer;
    if (!container) return;

    // Targeted MutationObserver ONLY on tabContainer for `collapsed` attribute
    // toggles and added/removed tab-groups (never observes document.body!).
    state.tabObserver = new win.MutationObserver((mutations) => {
      let needsRefresh = false;
      for (const m of mutations) {
        if (m.type === "attributes" && m.attributeName === "collapsed" && isPlainTabGroup(m.target)) {
          onGroupCollapsedChanged(m.target);
        } else if (m.type === "childList") {
          for (const node of [...(m.addedNodes || []), ...(m.removedNodes || [])]) {
            if (isPlainTabGroup(node) || node?.localName === "tab") {
              needsRefresh = true;
              break;
            }
          }
        }
      }
      if (needsRefresh) scheduleRefreshAll();
    });
    state.tabObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["collapsed"],
    });

    // Active tab tracking inside collapsed folders
    listen(container, "TabSelect", (event) => {
      const tab = event.target;
      if (tab?.closest?.(COLLAPSED_GROUP_SELECTOR)) {
        const tabs = tab.group?.hasAttribute?.("split-view-group")
          ? Array.from(tab.group.querySelectorAll("tab"))
          : [tab];
        for (const t of tabs) t.setAttribute(ATTR_FOLDER_ACTIVE, "true");
      }
      for (const g of container.querySelectorAll?.(`tab-group[${ATTR_FOLDER_LOOK}]`) || []) {
        updateGroupIconState(g);
      }
    });

    listen(container, "TabBrowserDiscarded", (event) => {
      event.target?.removeAttribute?.(ATTR_FOLDER_ACTIVE);
      updateGroupStateWithAncestors(event.target);
    });

    // Cheap targeted tab-count & state refreshes
    const refreshTargeted = (event) => {
      const t = event?.target;
      const g = isPlainTabGroup(t) ? t : t?.closest?.(NORMAL_GROUP_SELECTOR);
      if (g) {
        decorateGroup(g);
      } else {
        scheduleRefreshAll();
      }
    };

    for (const evt of ["TabOpen", "TabClose", "TabMove", "TabGrouped", "TabUngrouped", "TabGroupCreate"]) {
      listen(container, evt, refreshTargeted);
    }
    listen(win, "TabGroupCreate", refreshTargeted);
    listen(win, "TabGroupRemoved", (event) => {
      const g = event?.target;
      if (isPlainTabGroup(g) && g.id) removePersistedFolderMeta(g.id);
      scheduleRefreshAll();
    });

    // Double-click folder header -> inline rename
    listen(container, "dblclick", (event) => {
      const header = event.target?.closest?.(".tab-group-label-container");
      if (!header) return;
      const group = header.closest?.(NORMAL_GROUP_SELECTOR);
      if (!isPlainTabGroup(group)) return;
      event.preventDefault();
      event.stopPropagation();
      startInlineRename(win, group, { selectAll: true });
    }, true);

    // Right-click folder header -> built-in Folder Engine context menu
    listen(container, "contextmenu", (event) => {
      const header = event.target?.closest?.(".tab-group-label-container");
      if (!header) return;
      const group = header.closest?.(NORMAL_GROUP_SELECTOR);
      if (!isPlainTabGroup(group)) return;
      event.preventDefault();
      event.stopPropagation();
      state.activeContextGroup = group;
      const popup = ensureContextMenu();
      try {
        popup.openPopupAtScreen(event.screenX, event.screenY, true);
      } catch {
        popup.openPopup?.(header, "after_start", 0, 0, true, false);
      }
    }, true);

    // Configurable group-selected shortcut
    listen(win, "keydown", onWindowKeydown, true);

    // Zen Library shadow-DOM integration
    const browser = doc.getElementById?.("browser");
    if (browser) {
      state.browserObserver = new win.MutationObserver(attachLibrary);
      state.browserObserver.observe(browser, { childList: true });
      attachLibrary();
    }

    // Ensure zen-folder custom element is defined before first icon clone
    if (getIconTemplate()) {
      scheduleRefreshAll();
    } else if (typeof win.customElements?.whenDefined === "function") {
      win.customElements.whenDefined("zen-folder").then(() => {
        if (!state.disposed && state.running) scheduleRefreshAll();
      }).catch(() => {});
    } else {
      scheduleRefreshAll();
    }

    console.log(`${LOG} folder-engine initialized`);
  };

  const stopEngine = () => {
    if (!state.running) return;
    state.running = false;
    syncRootAttributes();

    if (state.conflictTimer != null) {
      clearTimer(state.conflictTimer);
      state.conflictTimer = null;
    }
    if (state.rafId !== null) {
      if (typeof win.cancelAnimationFrame === "function") {
        try { win.cancelAnimationFrame(state.rafId); } catch {}
      } else {
        clearTimer(state.rafId);
      }
      state.rafId = null;
    }
    if (state.libraryRaf !== null) {
      if (typeof win.cancelAnimationFrame === "function") {
        try { win.cancelAnimationFrame(state.libraryRaf); } catch {}
      } else {
        clearTimer(state.libraryRaf);
      }
      state.libraryRaf = null;
    }

    state.tabObserver?.disconnect();
    state.browserObserver?.disconnect();
    state.libraryObserver?.disconnect();
    state.tabObserver = null;
    state.browserObserver = null;
    state.libraryObserver = null;
    state.libraryRoot = null;

    for (const [target, type, handler, capture] of state.listeners.splice(0)) {
      try { target.removeEventListener(type, handler, capture); } catch {}
    }

    try { state.contextMenu?.remove?.(); } catch {}
    state.contextMenu = null;
    state.activeContextGroup = null;

    // Strip only our injected elements and attributes (never touch native zen-folder icons).
    const shadow = doc.querySelector?.("zen-library")?.shadowRoot;
    try { shadow?.getElementById?.(LIBRARY_STYLE_ID)?.remove?.(); } catch {}

    const roots = [win.gBrowser?.tabContainer, shadow].filter(Boolean);
    for (const root of roots) {
      for (const el of root.querySelectorAll?.(
        `[${ATTR_FOLDER_LOOK}] > :is(.tab-group-label-container, .library-workspace-item.atg-tab-group) > :is(.tab-group-folder-icon, .zao-folder-tab-count)`,
      ) || []) {
        el.remove();
      }
      for (const el of root.querySelectorAll?.(`[${ATTR_FOLDER_LOOK}]`) || []) {
        cancelActiveToggleAnimation(el);
        el.removeAttribute(ATTR_FOLDER_LOOK);
        el.removeAttribute(ATTR_TAB_COUNT);
        el.removeAttribute(ATTR_COLLAPSING);
      }
      for (const el of root.querySelectorAll?.(`[${ATTR_FOLDER_ACTIVE}]`) || []) {
        el.removeAttribute(ATTR_FOLDER_ACTIVE);
      }
      for (const el of root.querySelectorAll?.(`.${ATTR_FOLDER_ACTIVE}`) || []) {
        el.classList.remove(ATTR_FOLDER_ACTIVE);
      }
    }
  };

  state.stopEngine = stopEngine;

  // Expose lightweight bridge on window for folder-sync & move-to-folder
  win._zaoFolderEngine = {
    refreshGroup: (group) => decorateGroup(group),
    applySyncedColor: (group, color) => setFolderColor(group, color, { sync: false }),
    applySyncedEmoji: (group, emoji) => setFolderEmoji(group, emoji, { sync: false }),
    removePersistedFolderMeta,
    startInlineRename: (group, opts) => startInlineRename(win, group, opts),
  };

  // Live pref observers
  const prefObserver = {
    observe(_subject, topic, data) {
      if (topic !== "nsPref:changed" || state.disposed || win.closed) return;
      if (data === FOLDER_ENGINE_ENABLED_PREF) {
        if (isFolderEngineEnabled()) startEngine();
        else stopEngine();
      } else if (data === FOLDER_TAB_COUNT_PREF) {
        syncRootAttributes();
      }
    },
  };
  try {
    globalThis.Services?.prefs?.addObserver?.(FOLDER_ENGINE_ENABLED_PREF, prefObserver);
    globalThis.Services?.prefs?.addObserver?.(FOLDER_TAB_COUNT_PREF, prefObserver);
    state.prefObserver = prefObserver;
  } catch {}

  if (isFolderEngineEnabled()) {
    startEngine();
  }
};

export const teardownFolderEngine = (win = globalThis.window) => {
  const state = WINDOW_ENGINE_STATE.get(win);
  if (!state) return;
  state.disposed = true;
  WINDOW_ENGINE_STATE.delete(win);

  if (state.prefObserver) {
    try {
      globalThis.Services?.prefs?.removeObserver?.(FOLDER_ENGINE_ENABLED_PREF, state.prefObserver);
      globalThis.Services?.prefs?.removeObserver?.(FOLDER_TAB_COUNT_PREF, state.prefObserver);
    } catch {}
    state.prefObserver = null;
  }

  if (state.running && typeof state.stopEngine === "function") {
    try { state.stopEngine(); } catch {}
  }

  try { win.document?.documentElement?.removeAttribute?.("data-zao-folder-engine"); } catch {}
  try { win.document?.documentElement?.removeAttribute?.("data-zao-folder-tab-count"); } catch {}
  try { delete win._zaoFolderEngine; } catch {}
};
