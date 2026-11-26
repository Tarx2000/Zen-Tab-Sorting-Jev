import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG } from "../modules/config.mjs";
import { saveGroupState, setupGroupState, teardownGroupState } from "../modules/group-state.mjs";
import {
  applyGroupColor,
  consolidateDuplicateGroups,
  directGroupTabs,
  dissolveEmptyGroups,
  dissolveStaleGroups,
  findExistingGroup,
  getWorkspaceExistingGroups,
  isManagedGroup,
  markManagedGroup,
  moveUngroupedToTop,
  resolveWorkspaceElement,
} from "../modules/groups.mjs";
import { clearSnippetCache, fetchPageSnippets, getEligibleTabs, sanitizeUrlPath } from "../modules/tabs.mjs";
import { abortSortSession, isSortRunning, updateSortButtonState, withSortSession } from "../modules/sort-session.mjs";
import { groupHeader, isSidebarCopy } from "../modules/sidebar-elements.mjs";
import { createSafeLogEvent, redactSecretString } from "../modules/safe-log.mjs";
import { clearDebugEvents, flushDebugJournal, getDebugEvents, recordDebugEvent } from "../modules/debug-journal.mjs";
import { getLocale, SUPPORTED_LOCALES, t } from "../modules/i18n.mjs";
import { validateSecurity } from "../scripts/validate-security.mjs";
import { parseProfilesIni, resolveZenBinary, scenarioPrefs } from "../scripts/zen-e2e-profile.mjs";
import { summarizeFrameDeltas } from "../scripts/e2e-folder-motion.mjs";

// ─── Minimal DOM helper for chrome-privileged module tests ───────────────────

const createClassList = () => {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const next = force === undefined ? !set.has(name) : Boolean(force);
      if (next) set.add(name);
      else set.delete(name);
      return next;
    },
  };
};

const createStyle = () => {
  const map = new Map();
  return {
    setProperty: (k, v) => map.set(k, String(v)),
    getPropertyValue: (k) => map.get(k) || "",
    removeProperty: (k) => {
      const prev = map.get(k) || "";
      map.delete(k);
      return prev;
    },
  };
};

const matchesSingleSelector = (el, sel) => {
  const trimmed = sel.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;
  if (trimmed.includes(":has(")) return false;
  if (trimmed.includes(":not(")) {
    const notStart = trimmed.indexOf(":not(");
    const notEnd = trimmed.indexOf(")", notStart + 5);
    const negated = trimmed.slice(notStart + 5, notEnd);
    const remaining = trimmed.slice(0, notStart) + trimmed.slice(notEnd + 1);
    return (!remaining || matchesSingleSelector(el, remaining)) && !matchesSingleSelector(el, negated);
  }
  const attrMatches = [...trimmed.matchAll(/\[([^\]=^$*]+)(?:(\^?)=["']?([^"'\]]*)["']?)?\]/g)];
  const stripped = trimmed.replace(/\[[^\]]+\]/g, "");
  const parts = stripped.split(/(?=[.#])/).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("#")) {
      if (el.id !== part.slice(1)) return false;
    } else if (part.startsWith(".")) {
      if (!el.classList.contains(part.slice(1))) return false;
    } else {
      if (el.localName !== part.toLowerCase()) return false;
    }
  }
  for (const [, name, op, val] of attrMatches) {
    if (!el.hasAttribute(name)) return false;
    if (val !== undefined) {
      const actual = el.getAttribute(name) || "";
      if (op === "^") {
        if (!actual.startsWith(val)) return false;
      } else if (actual !== val) return false;
    }
  }
  return true;
};

const matchesSelector = (el, selector) =>
  String(selector || "")
    .split(",")
    .some((part) => matchesSingleSelector(el, part));

const createElement = (tag, attrs = {}) => {
  const attributes = new Map();
  const children = [];
  const listeners = new Map();
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    localName: tag.toLowerCase(),
    id: "",
    isConnected: true,
    parentElement: null,
    get parentNode() { return this.parentElement; },
    children,
    classList: createClassList(),
    style: createStyle(),
    dataset: {},
    pinned: false,
    _collapsed: false,
    get collapsed() { return this._collapsed; },
    set collapsed(v) {
      this._collapsed = Boolean(v);
      if (this._collapsed) attributes.set("collapsed", "");
      else attributes.delete("collapsed");
    },
    get firstChild() { return children[0] || null; },
    get nextSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 ? this.parentElement.children[idx + 1] || null : null;
    },
    get tabs() { return this.querySelectorAll("tab"); },
    getAttribute(name) {
      if (name === "id" && this.id) return this.id;
      return attributes.has(name) ? attributes.get(name) : null;
    },
    setAttribute(name, value) {
      const str = String(value);
      if (name === "id") this.id = str;
      attributes.set(name, str);
    },
    removeAttribute(name) {
      if (name === "id") this.id = "";
      attributes.delete(name);
    },
    hasAttribute(name) {
      if (name === "id" && this.id) return true;
      return attributes.has(name);
    },
    appendChild(child) {
      if (child.parentElement) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx >= 0) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = this;
      child.isConnected = this.isConnected;
      children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentElement) {
        const prev = child.parentElement.children.indexOf(child);
        if (prev >= 0) child.parentElement.children.splice(prev, 1);
      }
      child.parentElement = this;
      child.isConnected = this.isConnected;
      if (!ref) {
        children.push(child);
      } else {
        const idx = children.indexOf(ref);
        if (idx >= 0) children.splice(idx, 0, child);
        else children.push(child);
      }
      return child;
    },
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      }
      this.isConnected = false;
    },
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    },
    matches(sel) { return matchesSelector(this, sel); },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.nodeType === 1 && cur.matches(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.matches?.(sel)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event) {
      for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
    },
  };
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "id") el.id = v;
    else if (k === "class") v.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    else if (k === "pinned") el.pinned = Boolean(v);
    else if (k === "url") el.linkedBrowser = { currentURI: { spec: v } };
    else el.setAttribute(k, v);
  }
  return el;
};

const createMockPrefs = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    prefHasUserValue: (k) => map.has(k),
    getBoolPref: (k, def = false) => (map.has(k) ? Boolean(map.get(k)) : def),
    setBoolPref: (k, v) => map.set(k, Boolean(v)),
    getStringPref: (k, def = "") => (map.has(k) ? String(map.get(k)) : def),
    setStringPref: (k, v) => map.set(k, String(v)),
    clearUserPref: (k) => map.delete(k),
    _map: map,
  };
};

// ─── 1. group-state.mjs ──────────────────────────────────────────────────────

test("group-state: pinned restore, same-container index restore, setter-throw non-deadlock, filtered observer, and O(N) save skip", async () => {
  const savedRecords = [
    { id: "grp-pinned", workspaceId: "ws-1", parentId: null, index: 0, collapsed: true, pinned: true },
    { id: "grp-second", workspaceId: "ws-1", parentId: null, index: 0, collapsed: false, pinned: false },
    { id: "grp-first", workspaceId: "ws-1", parentId: null, index: 1, collapsed: true, pinned: false },
  ];

  const ws1 = createElement("zen-workspace", { id: "ws-1" });
  const pinnedTabsContainer = createElement("div", { class: "zen-workspace-pinned-tabs-section" });
  const tabsContainer = createElement("div", { class: "zen-workspace-tabs-section" });
  ws1.appendChild(pinnedTabsContainer);
  ws1.appendChild(tabsContainer);
  ws1.pinnedTabsContainer = pinnedTabsContainer;
  ws1.tabsContainer = tabsContainer;

  const grpPinned = createElement("tab-group", { id: "grp-pinned", label: "Pinned", "zen-workspace-id": "ws-1" });
  grpPinned.appendChild(createElement("tab", { label: "P1", "zen-workspace-id": "ws-1" }));
  const grpFirst = createElement("tab-group", { id: "grp-first", label: "First", "zen-workspace-id": "ws-1" });
  grpFirst.appendChild(createElement("tab", { label: "F1", "zen-workspace-id": "ws-1" }));
  const grpSecond = createElement("tab-group", { id: "grp-second", label: "Second", "zen-workspace-id": "ws-1" });
  grpSecond.appendChild(createElement("tab", { label: "S1", "zen-workspace-id": "ws-1" }));

  // Deliberately place grpPinned in regular container and swap grpFirst/grpSecond order.
  tabsContainer.appendChild(grpFirst);
  tabsContainer.appendChild(grpSecond);
  tabsContainer.appendChild(grpPinned);

  // Force setter-throw on grpFirst.collapsed to prove restore never deadlocks.
  Object.defineProperty(grpFirst, "collapsed", {
    get: () => false,
    set: () => { throw new Error("Simulated native collapsed setter failure"); },
    configurable: true,
  });

  let setWindowCalls = 0;
  let storedJson = JSON.stringify(savedRecords);
  const store = {
    promiseAllWindowsRestored: Promise.resolve(),
    getCustomWindowValue: () => storedJson,
    setCustomWindowValue: (_win, _key, val) => {
      setWindowCalls += 1;
      storedJson = val;
    },
  };

  let observerCallback = null;
  class FakeMutationObserver {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  }

  const prevChromeUtils = globalThis.ChromeUtils;
  globalThis.ChromeUtils = { importESModule: () => ({ SessionStore: store }) };

  const listeners = new Map();
  let scheduledTimers = 0;
  const win = {
    document: { getElementById: (id) => [grpPinned, grpFirst, grpSecond].find((g) => g.id === id) || null },
    MutationObserver: FakeMutationObserver,
    gZenStartup: { promiseInitialized: Promise.resolve() },
    gZenWorkspaces: {
      promiseInitialized: Promise.resolve(),
      getWorkspaces: () => [{ uuid: "ws-1" }],
      workspaceElement: (id) => (id === "ws-1" ? ws1 : null),
    },
    gBrowser: {
      tabContainer: { _invalidateCachedTabs: () => {} },
      zenHandleTabMove: (_target, fn) => fn(),
    },
    setTimeout: (fn, ms) => {
      scheduledTimers += 1;
      return setTimeout(fn, Math.min(ms, 5));
    },
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: (ev, fn) => listeners.set(ev, fn),
    removeEventListener: (ev) => listeners.delete(ev),
  };

  try {
    setupGroupState(win);
    await win._zaoGroupState.ready;

    assert.equal(win._zaoGroupState.restoring, false, "Restore must complete despite setter throw");
    assert.equal(grpPinned.parentElement, pinnedTabsContainer, "Pinned group restored to pinnedTabsContainer");
    assert.equal(grpPinned.collapsed, true, "Pinned group collapsed state restored");
    assert.equal(tabsContainer.children[0], grpSecond, "Same-container index 0 restored");
    assert.equal(tabsContainer.children[1], grpFirst, "Same-container index 1 restored");

    // O(N) save skip: saving unchanged state must not call SessionStore setter again.
    const callsAfterRestore = setWindowCalls;
    assert.equal(saveGroupState(win), true);
    assert.equal(setWindowCalls, callsAfterRestore, "Unchanged state skips SessionStore write");

    // Filtered observer: sidebar copy / irrelevant mutations must NOT schedule a save timer.
    const timersBefore = scheduledTimers;
    const copyEl = createElement("tab-group", { "drag-image": "true" });
    observerCallback([{ type: "attributes", target: copyEl }]);
    observerCallback([{ type: "attributes", target: createElement("tab") }]);
    assert.equal(scheduledTimers, timersBefore, "Irrelevant and sidebar-copy mutations ignored");

    // Relevant group mutation DOES schedule a save timer.
    observerCallback([{ type: "attributes", target: grpSecond }]);
    assert.equal(scheduledTimers, timersBefore + 1, "Relevant group mutation schedules save");
  } finally {
    teardownGroupState(win);
    globalThis.ChromeUtils = prevChromeUtils;
  }
});

// ─── 2. groups.mjs ───────────────────────────────────────────────────────────

test("groups: Split View exclusion, directGroupTabs, applyGroupColor, resolveWorkspaceElement, data-zao-managed, dissolveStaleGroups, idempotent moveUngroupedToTop", () => {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevGBrowser = globalThis.gBrowser;
  const prevServices = globalThis.Services;

  const docRoot = createElement("window");
  const ws1 = createElement("zen-workspace", { id: "ws-1" });
  const ws2 = createElement("zen-workspace", { id: "ws-2" });
  const ws1Tabs = createElement("div", { class: "tabs" });
  const ws2Tabs = createElement("div", { class: "tabs" });
  ws1.appendChild(ws1Tabs);
  ws2.appendChild(ws2Tabs);
  ws1.tabsContainer = ws1Tabs;
  ws2.tabsContainer = ws2Tabs;
  docRoot.appendChild(ws1);
  docRoot.appendChild(ws2);

  // Normal group with nested child group, placeholder, glance, pinned, and regular tabs
  const devGroup = createElement("tab-group", { label: "Dev", "zen-workspace-id": "ws-1" });
  const t1 = createElement("tab", { label: "GitHub", "zen-workspace-id": "ws-1", url: "https://github.com/a" });
  const tEmpty = createElement("tab", { label: "Empty", "zen-workspace-id": "ws-1", "zen-empty-tab": "true" });
  const tGlance = createElement("tab", { label: "Glance", "zen-workspace-id": "ws-1", "zen-glance-tab": "true" });
  const tPinned = createElement("tab", { label: "Pinned", "zen-workspace-id": "ws-1", pinned: true });
  const nestedGroup = createElement("tab-group", { label: "Nested", "zen-workspace-id": "ws-1" });
  const tNested = createElement("tab", { label: "Inner", "zen-workspace-id": "ws-1", url: "https://docs.rs/a" });
  nestedGroup.appendChild(tNested);
  devGroup.appendChild(t1);
  devGroup.appendChild(tEmpty);
  devGroup.appendChild(tGlance);
  devGroup.appendChild(tPinned);
  devGroup.appendChild(nestedGroup);
  ws1Tabs.appendChild(devGroup);

  // Split View group — must be excluded from normal group queries
  const splitGroup = createElement("tab-group", { label: "Split", "split-view-group": "true", "zen-workspace-id": "ws-1" });
  splitGroup.appendChild(createElement("tab", { label: "SplitA", "zen-workspace-id": "ws-1", url: "https://example.com/a" }));
  ws1Tabs.appendChild(splitGroup);

  // Managed empty group vs user-created empty folder
  const managedEmpty = markManagedGroup(createElement("tab-group", { label: "AI Empty", "zen-workspace-id": "ws-1" }));
  const userEmpty = createElement("tab-group", { label: "User Folder", "zen-workspace-id": "ws-1" });
  ws1Tabs.appendChild(managedEmpty);
  ws1Tabs.appendChild(userEmpty);

  // Stale group with two tabs + ungrouped tabs below groups
  const staleGroup = createElement("tab-group", { label: "Stale", "zen-workspace-id": "ws-1" });
  const staleTab1 = createElement("tab", { label: "S1", "zen-workspace-id": "ws-1", url: "https://a.test" });
  const staleTab2 = createElement("tab", { label: "S2", "zen-workspace-id": "ws-1", url: "https://b.test" });
  staleGroup.appendChild(staleTab1);
  staleGroup.appendChild(staleTab2);
  ws1Tabs.appendChild(staleGroup);

  const loose1 = createElement("tab", { label: "Loose1", "zen-workspace-id": "ws-1" });
  const loose2 = createElement("tab", { label: "Loose2", "zen-workspace-id": "ws-1" });
  ws1Tabs.appendChild(loose1);
  ws1Tabs.appendChild(loose2);

  globalThis.document = {
    querySelector: (sel) => docRoot.querySelector(sel),
    querySelectorAll: (sel) => docRoot.querySelectorAll(sel),
  };
  globalThis.window = {
    gZenWorkspaces: {
      activeWorkspace: "ws-1",
      activeWorkspaceElement: ws1,
      workspaceElement: (id) => (id === "ws-1" ? ws1 : id === "ws-2" ? ws2 : null),
    },
  };
  globalThis.gBrowser = {
    ungroupTab: (tab) => ws1Tabs.appendChild(tab),
    zenHandleTabMove: (_t, fn) => fn(),
    moveTabToExistingGroup: (tab, group) => group.appendChild(tab),
  };
  globalThis.Services = { prefs: createMockPrefs() };

  try {
    // resolveWorkspaceElement across active and inactive Spaces
    assert.equal(resolveWorkspaceElement("ws-1"), ws1);
    assert.equal(resolveWorkspaceElement("ws-2"), ws2);

    // directGroupTabs excludes nested group tabs, placeholders, glance, pinned
    assert.deepEqual(directGroupTabs(devGroup, "ws-1"), [t1]);

    // Split View exclusion
    const existing = getWorkspaceExistingGroups("ws-1");
    assert.ok(existing.some((g) => g.name === "Dev"));
    assert.ok(!existing.some((g) => g.name === "Split"), "Split View group must be excluded");
    assert.equal(findExistingGroup("Split", "ws-1"), null);
    assert.equal(findExistingGroup("dev", "ws-1"), devGroup);

    // applyGroupColor: hex light-dark mix + null clear
    applyGroupColor(devGroup, "#336699");
    assert.equal(devGroup.style.getPropertyValue("--tab-group-color"), "#336699");
    assert.match(devGroup.style.getPropertyValue("--tab-group-color-invert"), /^light-dark\(color-mix\(/);
    assert.match(devGroup.style.getPropertyValue("--tab-group-color-pale"), /^light-dark\(color-mix\(/);
    applyGroupColor(devGroup, null);
    assert.equal(devGroup.style.getPropertyValue("--tab-group-color"), "");
    assert.equal(devGroup.style.getPropertyValue("--tab-group-color-invert"), "");

    // data-zao-managed & dissolveEmptyGroups
    assert.equal(isManagedGroup(managedEmpty), true);
    assert.equal(isManagedGroup(userEmpty), false);
    assert.equal(dissolveEmptyGroups("ws-1"), 1);
    assert.equal(managedEmpty.isConnected, false, "Managed empty group dissolved");
    assert.equal(userEmpty.isConnected, true, "User empty folder protected");

    // cursor-ordered dissolveStaleGroups
    const dissolved = dissolveStaleGroups("ws-1", [{ name: "Dev" }, { name: "Nested" }]);
    assert.equal(dissolved.dissolved, 1);
    assert.equal(dissolved.ungrouped, 2);
    assert.equal(staleGroup.isConnected, false);
    assert.equal(userEmpty.isConnected, true, "User empty folder protected from dissolveStaleGroups");
    assert.equal(ws1Tabs.children[0], staleTab1, "Cursor preserves first ungrouped tab at top");
    assert.equal(ws1Tabs.children[1], staleTab2, "Cursor preserves second ungrouped tab in order");

    // idempotent moveUngroupedToTop
    const movedFirst = moveUngroupedToTop("ws-1");
    assert.equal(movedFirst, 2, "Moves the two loose tabs to top below already-top tabs");
    const origInsertBefore = ws1Tabs.insertBefore.bind(ws1Tabs);
    let insertCalls = 0;
    ws1Tabs.insertBefore = (...args) => { insertCalls += 1; return origInsertBefore(...args); };
    const movedSecond = moveUngroupedToTop("ws-1");
    assert.equal(movedSecond, 0, "Second moveUngroupedToTop is a true DOM no-op");
    assert.equal(insertCalls, 0, "Zero insertBefore calls on idempotent run");

    // consolidateDuplicateGroups ignores Split View and merges normal duplicates
    const dupDev = createElement("tab-group", { label: "dev", "zen-workspace-id": "ws-1" });
    const dupTab = createElement("tab", { label: "Dup", "zen-workspace-id": "ws-1" });
    dupDev.appendChild(dupTab);
    ws1Tabs.appendChild(dupDev);
    const merged = consolidateDuplicateGroups("ws-1");
    assert.equal(merged.mergedLabels, 1);
    assert.equal(merged.tabsMoved, 1);
    assert.equal(dupTab.parentElement, devGroup);
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.gBrowser = prevGBrowser;
    globalThis.Services = prevServices;
  }
});

// ─── 3. tabs.mjs ─────────────────────────────────────────────────────────────

test("tabs: Split View exclusion in getEligibleTabs, sanitizeUrlPath, file://, fetchPageSnippets abort & private-window bypass", async () => {
  const prevWindow = globalThis.window;
  const prevGBrowser = globalThis.gBrowser;
  const prevPrivate = globalThis.PrivateBrowsingUtils;

  const ws = createElement("zen-workspace", { id: "ws-1" });
  const normalTab = createElement("tab", { label: "Normal", "zen-workspace-id": "ws-1", url: "https://www.github.com/org/repo" });
  const splitWrapper = createElement("tab-split-view-wrapper");
  const splitWrapperTab = createElement("tab", { label: "SplitW", "zen-workspace-id": "ws-1", url: "https://a.test" });
  splitWrapper.appendChild(splitWrapperTab);
  const splitGroup = createElement("tab-group", { "split-view-group": "true" });
  const splitGroupTab = createElement("tab", { label: "SplitG", "zen-workspace-id": "ws-1", url: "https://b.test" });
  splitGroup.appendChild(splitGroupTab);
  const glanceTab = createElement("tab", { label: "Glance", "zen-workspace-id": "ws-1", "zen-glance-tab": "true" });
  const otherWsTab = createElement("tab", { label: "Other", "zen-workspace-id": "ws-2" });
  ws.appendChild(normalTab);
  ws.appendChild(splitWrapper);
  ws.appendChild(splitGroup);
  ws.appendChild(glanceTab);
  ws.appendChild(otherWsTab);

  globalThis.window = { gZenWorkspaces: { activeWorkspace: "ws-1" } };
  globalThis.gBrowser = { tabs: [normalTab, splitWrapperTab, splitGroupTab, glanceTab, otherWsTab] };

  try {
    const { workspaceId, tabs } = getEligibleTabs();
    assert.equal(workspaceId, "ws-1");
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].title, "Normal");
    assert.equal(tabs[0].hostname, "github.com");

    // sanitizeUrlPath & file://
    assert.equal(sanitizeUrlPath("https://www.example.com/a/b/c/d?token=secret#frag"), "example.com/a/b/c");
    assert.equal(sanitizeUrlPath("https://cdn.example.com/org/team/deep/nested/report.pdf?sig=1"), "cdn.example.com/org/team/report.pdf");
    assert.equal(sanitizeUrlPath("file:///Users/alice/Private/Budget%202026.pdf"), "file/Budget 2026.pdf");
    assert.equal(sanitizeUrlPath("about:preferences"), "");
    assert.equal(sanitizeUrlPath("javascript:alert(1)"), "");

    // fetchPageSnippets abort & private-window cache bypass
    clearSnippetCache();
    let fetchCount = 0;
    const mockFetch = async (_url, { signal }) => {
      fetchCount += 1;
      if (signal?.aborted) throw new Error("Aborted");
      return {
        ok: true,
        headers: new Map([["content-type", "text/html; charset=utf-8"]]),
        text: async () => `<html><head><meta name="description" content="Hello snippet"></head><body><h1>Main Topic</h1></body></html>`,
      };
    };

    const abortedController = new AbortController();
    abortedController.abort();
    const abortedRes = await fetchPageSnippets([{ url: "https://example.test/page" }], {
      signal: abortedController.signal,
      fetchImpl: mockFetch,
    });
    assert.deepEqual(abortedRes, [""]);
    assert.equal(fetchCount, 0, "Pre-aborted signal makes zero fetches");

    // Private window bypasses cache read & write
    const privateWin = { __private: true };
    const normalWin = { __private: false };
    globalThis.PrivateBrowsingUtils = { isWindowPrivate: (w) => Boolean(w?.__private) };

    const priv1 = await fetchPageSnippets([{ url: "https://example.test/priv" }], { fetchImpl: mockFetch, win: privateWin });
    const priv2 = await fetchPageSnippets([{ url: "https://example.test/priv" }], { fetchImpl: mockFetch, win: privateWin });
    assert.match(priv1[0], /Hello snippet/);
    assert.match(priv2[0], /Hello snippet/);
    assert.equal(fetchCount, 2, "Private window never reads or populates shared snippet cache");

    // Normal window caches after first fetch
    await fetchPageSnippets([{ url: "https://example.test/priv" }], { fetchImpl: mockFetch, win: normalWin });
    await fetchPageSnippets([{ url: "https://example.test/priv" }], { fetchImpl: mockFetch, win: normalWin });
    assert.equal(fetchCount, 3, "Non-private window caches snippet across repeated calls");
  } finally {
    clearSnippetCache();
    globalThis.window = prevWindow;
    globalThis.gBrowser = prevGBrowser;
    globalThis.PrivateBrowsingUtils = prevPrivate;
  }
});

// ─── 4. sort-session.mjs ─────────────────────────────────────────────────────

test("sort-session: ready abort race, closed-window guard, failed-run done suppression, and click-to-abort", async () => {
  const wandButton = createElement("toolbarbutton", { id: "tab-wand-button", class: "zao-organize-button" });
  const otherButton = createElement("toolbarbutton", { id: "zao-sort-workspaces", class: "zao-organize-button" });
  const docListeners = new Map();
  const winListeners = new Map();

  const makeWin = () => ({
    closed: false,
    gZenWorkspaces: { activeWorkspace: "ws-1" },
    document: {
      querySelectorAll: () => [wandButton, otherButton],
      addEventListener: (type, fn) => docListeners.set(type, fn),
      removeEventListener: (type) => docListeners.delete(type),
    },
    addEventListener: (type, fn) => winListeners.set(type, fn),
    removeEventListener: (type) => winListeners.delete(type),
    setTimeout,
    clearTimeout,
  });

  // 4a. Abort race while waiting on never-resolving _zaoGroupState.ready
  const winAbort = makeWin();
  winAbort._zaoGroupState = { ready: new Promise(() => {}) };
  let runInvoked = false;
  const pending = withSortSession("workspace", async () => { runInvoked = true; return { ok: true }; }, winAbort);
  assert.equal(isSortRunning(winAbort), true);
  assert.equal(wandButton.disabled, false, "Wand stays clickable to allow abort");
  assert.equal(wandButton.getAttribute("data-zao-cancellable"), "true");
  assert.equal(otherButton.disabled, true, "Competing buttons disabled while busy");

  // Click-to-abort via capture listener
  let prevented = false;
  docListeners.get("click")({
    type: "click",
    button: 0,
    target: wandButton,
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => {},
  });
  const abortOutcome = await pending;
  assert.equal(prevented, true);
  assert.deepEqual(abortOutcome, { aborted: true });
  assert.equal(runInvoked, false);
  assert.equal(wandButton.hasAttribute("data-zao-done"), false, "Aborted run suppresses done badge");
  assert.equal(abortSortSession(winAbort), false, "No active session after abort");

  // 4b. Failed run suppresses data-zao-done; successful run sets it
  const winFail = makeWin();
  await withSortSession("workspace", async () => ({ failed: true }), winFail);
  assert.equal(wandButton.hasAttribute("data-zao-done"), false, "Failed run must not show done badge");

  const winOk = makeWin();
  await withSortSession("workspace", async () => ({ ok: true }), winOk);
  assert.equal(wandButton.getAttribute("data-zao-done"), "true");
  clearTimeout(winOk._zaoDoneTimer);

  // 4c. Closed-window guard in finally
  const winClosed = makeWin();
  await withSortSession("workspace", async () => {
    winClosed.closed = true;
    winClosed.document = null;
    return { ok: true };
  }, winClosed);
  assert.equal(isSortRunning(winClosed), false);
  updateSortButtonState(wandButton, winClosed);
  assert.equal(wandButton.getAttribute("aria-busy"), "false");
});

// ─── 5. sidebar-elements.mjs ─────────────────────────────────────────────────

test("sidebar-elements: Text-node safety and groupHeader resolution", () => {
  const lib = createElement("zen-library", { id: "zen-library" });
  const group = createElement("tab-group", { label: "Copy" });
  lib.appendChild(group);
  const textInsideCopy = { nodeType: 3, parentElement: group };
  const textDetached = { nodeType: 3, parentElement: null };
  const normalGroup = createElement("tab-group", { label: "Live" });
  const textInsideLive = { nodeType: 3, parentElement: normalGroup };

  assert.equal(isSidebarCopy(null), false);
  assert.equal(isSidebarCopy(textDetached), false);
  assert.equal(isSidebarCopy(textInsideCopy), true);
  assert.equal(isSidebarCopy(textInsideLive), false);

  const header = createElement("div", { class: "tab-group-label-container" });
  normalGroup.appendChild(header);
  normalGroup.labelContainerElement = header;
  assert.equal(groupHeader(normalGroup), header);
});

// ─── 6. safe-log.mjs ─────────────────────────────────────────────────────────

test("safe-log: cycles, Error serialization, expanded secret redaction, and max_tokens allowlist", () => {
  const cyclic = { name: "root", max_tokens: 2048, prompt_tokens: 150, total_tokens: 500, access_token: "secret-abc" };
  cyclic.self = cyclic;

  const cause = new Error("Upstream sk-abcdefghijklmnopqrstuvwxyz123456 failed");
  const err = new Error("Bearer my-top-secret-token and https://x.test?api_key=leak123", { cause });

  const safe = createSafeLogEvent({ cyclic, err });
  assert.equal(safe.cyclic.self, "[circular]");
  assert.equal(safe.cyclic.max_tokens, 2048);
  assert.equal(safe.cyclic.prompt_tokens, 150);
  assert.equal(safe.cyclic.total_tokens, 500);
  assert.equal(safe.cyclic.access_token, "[redacted]");
  assert.equal(safe.err.name, "Error");
  assert.ok(!safe.err.message.includes("my-top-secret-token"));
  assert.ok(!safe.err.message.includes("leak123"));
  assert.match(safe.err.cause.message, /sk-\[redacted\]/);

  const multi = redactSecretString(
    "keys: AIzaSyABCDEFGHIJKLMNOPQRSTUV gsk_1234567890abcdefghij xai-1234567890abcdefghij pplx-1234567890abcdefghij ghp_1234567890abcdefghij github_pat_1234567890abcdefghij eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345",
  );
  for (const leak of ["AIzaSyABC", "gsk_12345", "xai-12345", "pplx-12345", "ghp_12345", "github_pat_12345", "eyJhbGciOi"]) {
    assert.ok(!multi.includes(leak), `Must redact ${leak}`);
  }
});

// ─── 7. debug-journal.mjs ────────────────────────────────────────────────────

test("debug-journal: 4KB event cap, 64KB total cap, and corrupt-JSON self-heal", () => {
  const prevServices = globalThis.Services;
  const prefs = createMockPrefs({
    [CONFIG.DEBUG_MODE_PREF]: true,
    [CONFIG.DEBUG_LOGS_PREF]: "{broken-json",
  });
  globalThis.Services = { prefs };

  try {
    // Corrupt JSON self-heals to [] and rewrites pref to "[]"
    assert.deepEqual(getDebugEvents(), []);
    assert.equal(prefs.getStringPref(CONFIG.DEBUG_LOGS_PREF), "[]");

    // 4KB single-event cap
    const huge = {};
    for (let i = 0; i < 30; i++) huge[`k${i}`] = "x".repeat(300);
    recordDebugEvent("ERROR-TEST", "Oversized payload", huge);
    const afterHuge = getDebugEvents();
    assert.equal(afterHuge.length, 1);
    assert.equal(afterHuge[0].data.truncated, true);
    assert.ok(afterHuge[0].data.originalBytes > 4096);

    // 64KB total JSON cap across many ~3KB events
    clearDebugEvents();
    const medium = { a: "a".repeat(800), b: "b".repeat(800), c: "c".repeat(800), d: "d".repeat(800) };
    for (let i = 0; i < 30; i++) {
      recordDebugEvent("STEP", `Event ${i}`, medium);
    }
    flushDebugJournal();
    const raw = prefs.getStringPref(CONFIG.DEBUG_LOGS_PREF);
    assert.ok(raw.length <= 65536, `Persisted journal (${raw.length}B) must stay <= 64KB`);
    assert.ok(getDebugEvents().length < 30, "Oldest events evicted to stay within 64KB cap");
  } finally {
    clearDebugEvents();
    globalThis.Services = prevServices;
  }
});

// ─── 8. i18n.mjs ─────────────────────────────────────────────────────────────

test("i18n: DE/EN locale detection, interpolation, and fallback", () => {
  const prevServices = globalThis.Services;
  try {
    assert.deepEqual(SUPPORTED_LOCALES, ["de", "en"]);

    globalThis.Services = { locale: { appLocaleAsBCP47: "de-DE" } };
    assert.equal(getLocale(), "de");
    assert.equal(t("toast.undoDone", { count: 3 }), "3 Element(e) wiederhergestellt.");

    globalThis.Services = { locale: { appLocaleAsBCP47: "en-US" } };
    assert.equal(getLocale(), "en");
    assert.equal(t("toast.undoDone", { count: 3 }), "Restored 3 item(s).");

    // Fallback to document lang when Services.locale is absent
    globalThis.Services = {};
    const deWin = { document: { documentElement: { getAttribute: () => "de-AT" } } };
    assert.equal(getLocale(deWin), "de");

    // Unknown key returns key string cleanly
    assert.equal(t("unknown.key.xyz", null, deWin), "unknown.key.xyz");
  } finally {
    globalThis.Services = prevServices;
  }
});

// ─── 9. Security validator & E2E helper regressions ──────────────────────────

test("validate-security: catches nested-paren log bypass, recordDebugEvent leaks, and expanded secret patterns", () => {
  const dir = mkdtempSync(join(tmpdir(), "zao-sec-test-"));
  try {
    writeFileSync(
      join(dir, "leak.mjs"),
      [
        `console.log(helper(1, 2), apiKey);`,
        `recordDebugEvent("DEBUG", "msg", { headers });`,
        `const a = "gsk_1234567890abcdefghijklmnop";`,
        `const b = "xai-1234567890abcdefghijklmnop";`,
        `const c = "pplx-1234567890abcdefghijklmnop";`,
        `const d = "ghp_1234567890abcdefghijklmnop";`,
        `const e = "github_pat_1234567890abcdefghijklmnop";`,
        `const f = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234567890";`,
      ].join("\n"),
      "utf8",
    );
    const res = validateSecurity(dir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("API key inside a logging call")));
    assert.ok(res.errors.some((e) => e.includes("headers inside a logging call")));
    for (const marker of ["gsk_", "xai-", "pplx-", "ghp_", "github_pat_", "JWT"]) {
      assert.ok(res.errors.some((e) => e.includes(marker)), `Expected validator to flag ${marker}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zen-e2e helpers: cross-platform binary/profile discovery, jev-hybrid prefs, and frame timing summary", () => {
  assert.equal(
    resolveZenBinary("", { platform: "linux", env: {}, exists: (p) => p === "/usr/bin/zen-browser" }),
    "/usr/bin/zen-browser",
  );
  assert.equal(
    resolveZenBinary("", { platform: "win32", env: { ZEN_BINARY: "C:\\Zen\\zen.exe" }, exists: () => false }),
    "C:\\Zen\\zen.exe",
  );

  const parsed = parseProfilesIni(
    "[Profile0]\nIsRelative=1\nPath=Profiles/abc.default\n[Profile1]\nIsRelative=0\nPath=/custom/zen-profile\n",
    "/base/zen",
  );
  assert.equal(parsed.length, 2);
  assert.ok(parsed[0].endsWith("Profiles/abc.default"));
  assert.equal(parsed[1], "/custom/zen-profile");

  const jevPrefs = Object.fromEntries(scenarioPrefs({ scenario: "jev-hybrid", providerPort: 9999, marionettePort: 2828 }));
  assert.equal(jevPrefs["extensions.zen-auto-organize.ai-engine"], "jev");
  assert.equal(jevPrefs["extensions.zen-auto-organize.ai-fallback-provider"], "custom");
  assert.equal(jevPrefs["extensions.zen-auto-organize.ai-sort-mode"], "rules-first");

  const timing = summarizeFrameDeltas([16.5, 16.7, 30.0, 55.0]);
  assert.equal(timing.frameCount, 4);
  assert.equal(timing.droppedFrames, 2);
  assert.equal(timing.jankFrames, 1);
  assert.equal(timing.maxFrameMs, 55);
});
