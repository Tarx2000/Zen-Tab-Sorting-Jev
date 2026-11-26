import test from "node:test";
import assert from "node:assert/strict";

import {
  captureUndoSnapshot,
  isWorkspaceContainerCompatible,
  moveWorkspaceUnit,
  restoreUndoSnapshot,
  snapshotWorkspaceUnits,
  workspaceUnitIsAtTarget,
} from "../modules/workspace-browser.mjs";
import {
  consolidateNewGroups,
  normalizeNameForDedupe,
} from "../modules/new-group-consolidation.mjs";

// ─── Minimal DOM helper for workspace-browser tests ──────────────────────────

const matchesPart = (el, sel) => {
  const s = sel.trim();
  if (!s) return false;
  if (s.startsWith("#")) return el.id === s.slice(1);
  if (s.startsWith(".")) return el.classList.has(s.slice(1));
  return el.localName === s.toLowerCase();
};

const createNode = (tag, attrs = {}) => {
  const map = new Map();
  const children = [];
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    localName: tag.toLowerCase(),
    id: "",
    isConnected: true,
    parentElement: null,
    get parentNode() { return this.parentElement; },
    children,
    classList: new Set(),
    pinned: false,
    isZenFolder: tag.toLowerCase() === "zen-folder",
    _collapsed: false,
    get collapsed() { return this._collapsed; },
    set collapsed(v) { this._collapsed = Boolean(v); },
    get tabs() { return this.querySelectorAll("tab"); },
    get nextSibling() {
      if (!this.parentElement) return null;
      const i = this.parentElement.children.indexOf(this);
      return i >= 0 ? this.parentElement.children[i + 1] || null : null;
    },
    getAttribute(k) { return k === "id" && this.id ? this.id : (map.has(k) ? map.get(k) : null); },
    setAttribute(k, v) { if (k === "id") this.id = String(v); map.set(k, String(v)); },
    removeAttribute(k) { if (k === "id") this.id = ""; map.delete(k); },
    hasAttribute(k) { return (k === "id" && Boolean(this.id)) || map.has(k); },
    appendChild(child) {
      if (child.parentElement) {
        const i = child.parentElement.children.indexOf(child);
        if (i >= 0) child.parentElement.children.splice(i, 1);
      }
      child.parentElement = this;
      child.isConnected = true;
      children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentElement) {
        const i = child.parentElement.children.indexOf(child);
        if (i >= 0) child.parentElement.children.splice(i, 1);
      }
      child.parentElement = this;
      child.isConnected = true;
      if (!ref) children.push(child);
      else {
        const i = children.indexOf(ref);
        if (i >= 0) children.splice(i, 0, child);
        else children.push(child);
      }
      return child;
    },
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    },
    matches(selector) {
      return String(selector || "").split(",").some((part) => matchesPart(this, part));
    },
    closest(selector) {
      let cur = this;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.matches(selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    dispatchEvent() {},
  };

  for (const [k, v] of Object.entries(attrs)) {
    if (k === "id") node.id = v;
    else if (k === "class") v.split(/\s+/).filter(Boolean).forEach((c) => node.classList.add(c));
    else if (k === "pinned") node.pinned = Boolean(v);
    else if (k === "collapsed") node.collapsed = Boolean(v);
    else if (k === "url") node.linkedBrowser = { currentURI: { spec: v } };
    else node.setAttribute(k, v);
  }
  return node;
};

const createWorkspaceFixture = () => {
  const wsA = createNode("zen-workspace", { id: "ws-a" });
  wsA.pinnedTabsContainer = createNode("div");
  wsA.tabsContainer = createNode("div");
  wsA.appendChild(wsA.pinnedTabsContainer);
  wsA.appendChild(wsA.tabsContainer);
  wsA.checkPinsExistence = () => {};

  const wsB = createNode("zen-workspace", { id: "ws-b" });
  wsB.pinnedTabsContainer = createNode("div");
  wsB.tabsContainer = createNode("div");
  wsB.appendChild(wsB.pinnedTabsContainer);
  wsB.appendChild(wsB.tabsContainer);
  wsB.checkPinsExistence = () => {};

  const spaces = [
    { uuid: "ws-a", name: "Work", containerTabId: 2 },
    { uuid: "ws-b", name: "Personal", containerTabId: 0 },
  ];
  const byId = new Map([["ws-a", wsA], ["ws-b", wsB]]);

  const win = {
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    gZenWorkspaces: {
      allStoredTabs: [],
      lastSelectedWorkspaceTabs: {},
      getWorkspaces: () => spaces,
      workspaceElement: (id) => byId.get(id) || null,
      moveTabToWorkspace: (tab, targetId) => {
        tab.setAttribute("zen-workspace-id", targetId);
        const dest = byId.get(targetId);
        (tab.pinned ? dest.pinnedTabsContainer : dest.tabsContainer).appendChild(tab);
      },
      updateTabsContainers: () => {},
    },
    gZenFolders: {
      changeFolderToSpace: (folder, targetId) => {
        folder.setAttribute("zen-workspace-id", targetId);
        for (const tab of folder.querySelectorAll("tab")) {
          tab.setAttribute("zen-workspace-id", targetId);
        }
      },
    },
    gBrowser: {
      tabs: [],
      tabContainer: { _invalidateCachedTabs: () => {} },
      zenHandleTabMove: (_node, fn) => fn(),
      TabStateFlusher: { flush: async () => {} },
    },
  };
  return { win, wsA, wsB };
};

// ─── 1. workspace-browser.mjs ────────────────────────────────────────────────

test("workspace-browser: nested split-view liveTabs, placeholder filtering, Glance skipped, pinned from source container", () => {
  const { win, wsA } = createWorkspaceFixture();

  // Group containing a nested tab-split-view-wrapper whose tabs are NOT in allStoredTabs
  // PLUS a zen-empty-tab placeholder (which must be filtered before liveTabs/workspace checks).
  const groupWithSplit = createNode("tab-group", { label: "Research", "zen-workspace-id": "ws-a", collapsed: true });
  const splitWrapper = createNode("tab-split-view-wrapper", { "zen-workspace-id": "ws-a" });
  const splitTab1 = createNode("tab", { label: "Split 1", "zen-workspace-id": "ws-a", url: "https://docs.rs/a", usercontextid: "2" });
  const splitTab2 = createNode("tab", { label: "Split 2", "zen-workspace-id": "ws-a", url: "https://docs.rs/b", usercontextid: "2" });
  splitWrapper.appendChild(splitTab1);
  splitWrapper.appendChild(splitTab2);
  const placeholder = createNode("tab", { label: "Empty", "zen-empty-tab": "true" }); // no zen-workspace-id!
  groupWithSplit.appendChild(splitWrapper);
  groupWithSplit.appendChild(placeholder);
  wsA.tabsContainer.appendChild(groupWithSplit);

  // Glance tab — must appear in skipped with skipReason: "glance"
  const glanceTab = createNode("tab", {
    label: "Quick Glance",
    "zen-workspace-id": "ws-a",
    "zen-glance-tab": "true",
    url: "https://news.ycombinator.com",
  });
  wsA.tabsContainer.appendChild(glanceTab);

  // Pinned container node without .pinned=true, and regular container node with stray .pinned=true
  const pinnedGroup = createNode("tab-group", { label: "PinnedGroup", "zen-workspace-id": "ws-a", pinned: false });
  const pinnedTab = createNode("tab", { label: "PinnedTab", "zen-workspace-id": "ws-a", url: "https://mail.example.com" });
  pinnedGroup.appendChild(pinnedTab);
  wsA.pinnedTabsContainer.appendChild(pinnedGroup);

  const regularStrayPin = createNode("tab", { label: "RegularTab", "zen-workspace-id": "ws-a", pinned: true, url: "https://github.com/a" });
  wsA.tabsContainer.appendChild(regularStrayPin);

  // Intentionally omit splitTab1 & splitTab2 from allStoredTabs to test nested split wrapper expansion.
  win.gZenWorkspaces.allStoredTabs = [glanceTab, pinnedTab, regularStrayPin];

  const snapshot = snapshotWorkspaceUnits(win, []);

  const splitUnit = snapshot.units.find((u) => u.name === "Research");
  assert.ok(splitUnit, "Group with nested split-view wrapper & placeholder must be captured");
  assert.equal(splitUnit.tabs.length, 2, "Placeholder filtered out and split tabs included via liveTabs");
  assert.equal(splitUnit._groups[0].collapsed, true);

  const glanceSkipped = snapshot.skipped.find((u) => u.name === "Quick Glance");
  assert.ok(glanceSkipped, "Glance tab must be recorded in skipped");
  assert.equal(glanceSkipped.skipReason, "glance");

  const pinnedUnit = snapshot.units.find((u) => u.name === "PinnedGroup");
  assert.equal(pinnedUnit.pinned, true, "pinned derived from pinnedTabsContainer containment");

  const regularUnit = snapshot.units.find((u) => u.name === "RegularTab");
  assert.equal(regularUnit.pinned, false, "Regular container overrides stray node.pinned");
});

test("workspace-browser: collapsed snapshot/restore, rollback on mid-move error, and captureUndoSnapshot/restoreUndoSnapshot", () => {
  const { win, wsA, wsB } = createWorkspaceFixture();

  const folder = createNode("zen-folder", { label: "Collapsed Folder", "zen-workspace-id": "ws-a", collapsed: true });
  const fTab = createNode("tab", { label: "Doc", "zen-workspace-id": "ws-a", url: "https://docs.example.com" });
  folder.appendChild(fTab);
  const anchorTab = createNode("tab", { label: "Anchor", "zen-workspace-id": "ws-a", url: "https://anchor.example.com" });
  wsA.tabsContainer.appendChild(folder);
  wsA.tabsContainer.appendChild(anchorTab);
  win.gZenWorkspaces.allStoredTabs = [fTab, anchorTab];

  // 1. Rollback test: simulate partial mutation then throw
  const snap1 = snapshotWorkspaceUnits(win, []);
  const folderUnit1 = snap1.units.find((u) => u.name === "Collapsed Folder");
  const origChangeFolder = win.gZenFolders.changeFolderToSpace;
  let shouldThrow = true;
  win.gZenFolders.changeFolderToSpace = (node, targetId, opts) => {
    if (shouldThrow && targetId === "ws-b") {
      node.setAttribute("zen-workspace-id", targetId);
      fTab.setAttribute("zen-workspace-id", targetId);
      node.collapsed = false;
      throw new Error("Simulated folder transfer failure");
    }
    return origChangeFolder(node, targetId, opts);
  };

  assert.throws(() => moveWorkspaceUnit(win, folderUnit1, "ws-b"), /Simulated folder transfer failure/);
  assert.equal(folder.parentElement, wsA.tabsContainer, "Rollback restores DOM parent");
  assert.equal(folder.nextSibling, anchorTab, "Rollback restores exact sibling position");
  assert.equal(folder.getAttribute("zen-workspace-id"), "ws-a", "Rollback restores folder workspace ID");
  assert.equal(fTab.getAttribute("zen-workspace-id"), "ws-a", "Rollback restores tab workspace ID");
  assert.equal(folder.collapsed, true, "Rollback restores collapsed state");

  // 2. Successful move preserves collapsed even if native move expands it
  shouldThrow = false;
  win.gZenFolders.changeFolderToSpace = (node, targetId, opts) => {
    node.collapsed = false; // Simulate native Zen auto-expanding on move
    return origChangeFolder(node, targetId, opts);
  };

  const snap2 = snapshotWorkspaceUnits(win, []);
  const folderUnit2 = snap2.units.find((u) => u.name === "Collapsed Folder");
  const tabUnit2 = snap2.units.find((u) => u.name === "Anchor");
  const undoSnapshot = captureUndoSnapshot(win, [
    { unit: folderUnit2, toWorkspaceId: "ws-b" },
    { unit: tabUnit2, toWorkspaceId: "ws-b" },
  ]);

  moveWorkspaceUnit(win, folderUnit2, "ws-b");
  moveWorkspaceUnit(win, tabUnit2, "ws-b");
  assert.equal(workspaceUnitIsAtTarget(win, folderUnit2, "ws-b"), true);
  assert.equal(folder.collapsed, true, "Collapsed state restored after move");

  // 3. 1-click Undo restores both units in reverse order back to ws-a with original order & collapse
  const restored = restoreUndoSnapshot(win, undoSnapshot);
  assert.equal(restored.restored, 2);
  assert.equal(restored.failed, 0);
  assert.equal(folder.parentElement, wsA.tabsContainer);
  assert.equal(anchorTab.parentElement, wsA.tabsContainer);
  assert.equal(wsA.tabsContainer.children[0], folder, "Original sibling order restored");
  assert.equal(wsA.tabsContainer.children[1], anchorTab);
  assert.equal(folder.collapsed, true, "Original collapsed state restored on undo");
  assert.equal(folder.getAttribute("zen-workspace-id"), "ws-a");
  assert.equal(anchorTab.getAttribute("zen-workspace-id"), "ws-a");
});

test("workspace-browser: isWorkspaceContainerCompatible enforces container-bound Spaces", () => {
  const workUnit = { workspaceId: "ws-work", userContextIds: [2] };
  const mixedUnit = { workspaceId: "ws-work", userContextIds: [2, 3] };

  assert.equal(isWorkspaceContainerCompatible(workUnit, { id: "ws-work", containerTabId: 99 }), true, "Origin Space always allowed");
  assert.equal(isWorkspaceContainerCompatible(workUnit, { id: "ws-open", containerTabId: 0 }), true, "Unpinned Space accepts any container");
  assert.equal(isWorkspaceContainerCompatible(workUnit, { id: "ws-work2", containerTabId: 2 }), true, "Matching container allowed");
  assert.equal(isWorkspaceContainerCompatible(workUnit, { id: "ws-bank", containerTabId: 5 }), false, "Mismatched container blocked");
  assert.equal(isWorkspaceContainerCompatible(mixedUnit, { id: "ws-work2", containerTabId: 2 }), false, "Mixed-container unit blocked");
  assert.equal(
    isWorkspaceContainerCompatible(workUnit, { id: "ws-bank", containerTabId: 5 }, { respectContainers: false }),
    true,
    "Disabled flag bypasses check",
  );
});

test("workspace-browser: split-view moves cleanly without dedicated gZenViewSplitter workspace method and calls optional sync if present", () => {
  const { win, wsA, wsB } = createWorkspaceFixture();
  // Real Zen exposes gZenViewSplitter without a dedicated workspace-change method.
  win.gZenViewSplitter = {};

  const splitGroup = createNode("tab-group", {
    label: "Dev Split",
    "split-view-group": "true",
    "zen-workspace-id": "ws-a",
  });
  const s1 = createNode("tab", { label: "Split A", "zen-workspace-id": "ws-a", url: "https://github.com/a" });
  const s2 = createNode("tab", { label: "Split B", "zen-workspace-id": "ws-a", url: "https://github.com/b" });
  splitGroup.appendChild(s1);
  splitGroup.appendChild(s2);
  wsA.tabsContainer.appendChild(splitGroup);
  win.gZenWorkspaces.allStoredTabs = [s1, s2];

  const snap1 = snapshotWorkspaceUnits(win, []);
  const splitUnit = snap1.units.find((u) => u.kind === "split-view");
  assert.ok(splitUnit, "Split view unit must be snapshotted");

  assert.doesNotThrow(() => moveWorkspaceUnit(win, splitUnit, "ws-b"));
  assert.equal(workspaceUnitIsAtTarget(win, splitUnit, "ws-b"), true);
  assert.equal(splitGroup.parentElement, wsB.tabsContainer);
  assert.equal(splitGroup.getAttribute("zen-workspace-id"), "ws-b");
  assert.equal(s1.getAttribute("zen-workspace-id"), "ws-b");
  assert.equal(s2.getAttribute("zen-workspace-id"), "ws-b");

  // When an optional gZenViewSplitter workspace sync method exists, invoke it safely.
  const synced = [];
  win.gZenViewSplitter = {
    moveSplitViewToWorkspace: (node, targetId) => synced.push({ node, targetId }),
  };
  const snap2 = snapshotWorkspaceUnits(win, []);
  const splitUnitBack = snap2.units.find((u) => u.kind === "split-view");
  moveWorkspaceUnit(win, splitUnitBack, "ws-a");
  assert.equal(synced.length, 1);
  assert.equal(synced[0].node, splitGroup);
  assert.equal(synced[0].targetId, "ws-a");
  assert.equal(splitGroup.parentElement, wsA.tabsContainer);
});

// ─── 2. new-group-consolidation.mjs ──────────────────────────────────────────

test("new-group-consolidation: German umlauts Bücher vs Bächer, CJK/empty-norm guard, non-mutating clone, duplicate-key preservation", async () => {
  // German umlauts must stay distinct
  assert.notEqual(normalizeNameForDedupe("Bücher"), normalizeNameForDedupe("Bächer"));
  const umlautGroups = [
    { name: "Bücher", tabs: [{ title: "Roman" }] },
    { name: "Bächer", tabs: [{ title: "Fluss" }] },
  ];
  const umlautOut = await consolidateNewGroups(umlautGroups, null);
  assert.equal(umlautOut.length, 2, "Bücher and Bächer must never collapse");

  // CJK names preserve Unicode letters; symbol/emoji-only empty norms must never collapse into one bucket
  const intlInput = [
    { name: "開発", tabs: [{ id: 1 }] },
    { name: "買い物", tabs: [{ id: 2 }] },
    { name: "🚀", tabs: [{ id: 3 }] },
    { name: "🔥", tabs: [{ id: 4 }] },
  ];
  const intlOut = await consolidateNewGroups(intlInput, null);
  assert.equal(intlOut.length, 4, "Distinct CJK and emoji-only names must not merge");

  // Non-mutating clone guarantee
  const original = [
    { name: "Dev Tools", tabs: [{ id: 1 }] },
    { name: "Dev", tabs: [{ id: 2 }] },
  ];
  const snapshotBefore = JSON.stringify(original);
  const consolidated = await consolidateNewGroups(original, null);
  assert.equal(JSON.stringify(original), snapshotBefore, "Input array and group.tabs must never be mutated");
  assert.equal(consolidated.length, 1);
  assert.equal(consolidated[0].tabs.length, 2);

  // applyMergePlan duplicate-key preservation (case-colliding source groups both preserved)
  const caseDupInput = [
    { name: "Dev", tabs: [{ id: 1 }] },
    { name: "dev", tabs: [{ id: 2 }] },
    { name: "Docs", tabs: [{ id: 3 }] },
  ];
  const merged = await consolidateNewGroups(
    caseDupInput,
    async () => ({ Dev: "Engineering", Docs: "Documentation" }),
  );
  const eng = merged.find((g) => g.name === "Engineering");
  assert.ok(eng);
  assert.deepEqual(eng.tabs.map((t) => t.id), [1, 2], "Both case-colliding groups preserved in merge plan");
});
