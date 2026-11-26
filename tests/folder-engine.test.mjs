import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MULTI_TOPIC_PLATFORMS,
  isMultiTopicHost,
  suggestRulePattern,
  suggestRuleForTabs,
  saveRuleSuggestionToFolder,
  filterAndRankFolders,
} from "../modules/move-to-folder.mjs";
import { findGroupForTab } from "../modules/pass1.mjs";
import {
  wouldCreateParentCycle,
  nestGroupUnder,
  unnestGroup,
  updateGroupVisibility,
} from "../modules/folder-sync.mjs";
import {
  createFallbackFolderSvg,
  detectAtgConflict,
  countDirectFolderTabs,
  parseFolderShortcut,
  matchesFolderShortcut,
  emojiToSvgDataUrl,
} from "../modules/folder-engine.mjs";
import { CONFIG } from "../modules/config.mjs";

// ─── Minimal DOM / Services test helpers ─────────────────────────────────────

const createMockElement = (tag, { id = "", attrs = {}, props = {} } = {}) => {
  const attrMap = new Map(Object.entries(attrs));
  const children = [];
  const el = {
    nodeType: 1,
    localName: tag.toLowerCase(),
    tagName: tag.toLowerCase(),
    id,
    isConnected: true,
    parentElement: null,
    children,
    classList: {
      _set: new Set(),
      contains(c) { return this._set.has(c); },
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
    },
    getAttribute(name) { return attrMap.has(name) ? attrMap.get(name) : null; },
    setAttribute(name, value) { attrMap.set(name, String(value)); },
    removeAttribute(name) { attrMap.delete(name); },
    hasAttribute(name) { return attrMap.has(name); },
    appendChild(child) {
      if (child.parentElement) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx !== -1) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = el;
      children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentElement) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx !== -1) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = el;
      const refIdx = ref ? children.indexOf(ref) : -1;
      if (refIdx === -1) children.push(child);
      else children.splice(refIdx, 0, child);
      return child;
    },
    prepend(child) {
      return el.insertBefore(child, children[0] || null);
    },
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parentElement;
      }
      return false;
    },
    closest(selector) {
      const parts = selector.split(",").map((s) => s.trim());
      let cur = el;
      while (cur) {
        for (const part of parts) {
          if (part === "tab-group" && cur.localName === "tab-group") return cur;
          if (part === "zen-workspace" && cur.localName === "zen-workspace") return cur;
          if (part === ".zen-workspace-normal-tabs-section" && cur.className === "zen-workspace-normal-tabs-section") return cur;
          if (part === "tab-group:not([split-view-group])" && cur.localName === "tab-group" && !cur.hasAttribute("split-view-group")) return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (selector === "tab" && c.localName === "tab") results.push(c);
          else if (selector === "tab-group:not([split-view-group])" && c.localName === "tab-group" && !c.hasAttribute("split-view-group")) results.push(c);
          walk(c);
        }
      };
      walk(el);
      return results;
    },
    querySelector(selector) {
      if (selector === ":scope > .tab-group-container") {
        return children.find((c) => c.className === "tab-group-container") || null;
      }
      if (selector === ":scope > .zen-tab-group-start") {
        return children.find((c) => c.className === "zen-tab-group-start") || null;
      }
      return el.querySelectorAll(selector)[0] || null;
    },
    ...props,
  };
  return el;
};

// ─── Q8: Smart Domain vs. URL Path Rule Suggestion ───────────────────────────

test("Q8: standard sites suggest normalized domain patterns", () => {
  assert.deepEqual(suggestRulePattern("https://www.Figma.com/file/abc123/Design-System"), {
    kind: "domain",
    pattern: "figma.com",
    host: "figma.com",
    isMultiTopic: false,
  });

  assert.deepEqual(suggestRulePattern("https://linear.app/team/ENG/issue/ZEN-42"), {
    kind: "domain",
    pattern: "linear.app",
    host: "linear.app",
    isMultiTopic: false,
  });

  assert.equal(suggestRulePattern("about:preferences"), null);
  assert.equal(suggestRulePattern("chrome://browser/content/browser.xhtml"), null);
  assert.equal(suggestRulePattern(""), null);
});

test("Q8: multi-topic platforms suggest specific URL path patterns", () => {
  assert.ok(MULTI_TOPIC_PLATFORMS.includes("github.com"));
  assert.equal(isMultiTopicHost("www.github.com"), "github.com");
  assert.equal(isMultiTopicHost("en.wikipedia.org"), "wikipedia.org");
  assert.equal(isMultiTopicHost("old.reddit.com"), "reddit.com");
  assert.equal(isMultiTopicHost("figma.com"), null);

  const cases = [
    ["https://github.com/LoopRook/Zen-Tab-Sorting/pull/12", "urlPattern", "github.com/LoopRook/Zen-Tab-Sorting*"],
    ["https://github.com/LoopRook", "urlPattern", "github.com/LoopRook*"],
    ["https://github.com/settings/tokens", "urlPattern", "github.com/settings*"],
    ["https://docs.google.com/document/d/1aBcDeFgHiJ/edit", "urlPattern", "docs.google.com/document/d/1aBcDeFgHiJ*"],
    ["https://www.youtube.com/@fireship/videos", "urlPattern", "youtube.com/@fireship*"],
    ["https://www.youtube.com/channel/UC12345/featured", "urlPattern", "youtube.com/channel/UC12345*"],
    ["https://www.reddit.com/r/rust/comments/abc/title/", "urlPattern", "reddit.com/r/rust*"],
    ["https://www.notion.so/myworkspace/Roadmap-1234", "urlPattern", "notion.so/myworkspace*"],
    ["https://medium.com/@authorname/some-article-123", "urlPattern", "medium.com/@authorname*"],
    ["https://stratechery.substack.com/p/ai-and-browsers", "domain", "stratechery.substack.com"],
    ["https://substack.com/@writer/note/c-123", "urlPattern", "substack.com/@writer*"],
    ["https://en.wikipedia.org/wiki/Firefox", "urlPattern", "en.wikipedia.org/wiki/Firefox*"],
  ];

  for (const [url, expectedKind, expectedPattern] of cases) {
    const res = suggestRulePattern(url);
    assert.ok(res, `expected suggestion for ${url}`);
    assert.equal(res.kind, expectedKind, `kind mismatch for ${url}`);
    assert.equal(res.pattern, expectedPattern, `pattern mismatch for ${url}`);
    assert.equal(res.isMultiTopic, true);

    // Every suggested pattern MUST match the originating tab under pass1.mjs!
    const rule = expectedKind === "urlPattern"
      ? { name: "Target", domains: [], urlPatterns: [res.pattern] }
      : { name: "Target", domains: [res.pattern] };
    const matched = findGroupForTab({ url, hostname: res.host, title: "" }, [rule]);
    assert.equal(matched, "Target", `pass1 failed to match suggested rule "${res.pattern}" for ${url}`);
  }
});

test("Q8: suggestRuleForTabs deduplicates across multi-selected tabs & saves cleanly to rules pref", () => {
  const { primary, all } = suggestRuleForTabs([
    { url: "https://github.com/LoopRook/Zen-Tab-Sorting/issues/1" },
    { url: "https://github.com/LoopRook/Zen-Tab-Sorting/pull/2" },
    { url: "https://figma.com/file/xyz" },
    { url: "about:blank" },
  ]);

  assert.equal(primary.pattern, "github.com/LoopRook/Zen-Tab-Sorting*");
  assert.equal(all.length, 2);
  assert.equal(all[1].kind, "domain");
  assert.equal(all[1].pattern, "figma.com");

  // Mock Services.prefs to verify persistence into rules.mjs
  const store = new Map();
  const prevServices = globalThis.Services;
  globalThis.Services = {
    prefs: {
      getStringPref: (k, d = "") => (store.has(k) ? store.get(k) : d),
      setStringPref: (k, v) => store.set(k, String(v)),
    },
  };
  try {
    const { rule, addedCount } = saveRuleSuggestionToFolder("Zen Dev", all, { color: "blue" });
    assert.equal(addedCount, 2);
    assert.equal(rule.name, "Zen Dev");
    assert.equal(rule.color, "blue");
    assert.deepEqual(rule.domains, ["figma.com"]);
    assert.deepEqual(rule.urlPatterns, ["github.com/LoopRook/Zen-Tab-Sorting*"]);

    const persisted = JSON.parse(store.get(CONFIG.RULES_PREF));
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0].urlPatterns, ["github.com/LoopRook/Zen-Tab-Sorting*"]);

    // Saving again is idempotent (0 new additions)
    const second = saveRuleSuggestionToFolder("Zen Dev", all);
    assert.equal(second.addedCount, 0);
  } finally {
    globalThis.Services = prevServices;
  }
});

// ─── Q3: Folder Search & Ranking ─────────────────────────────────────────────

test("Q3: filterAndRankFolders preserves order when empty and ranks exact > prefix > word > substring > fuzzy", () => {
  const folders = [
    { id: "1", label: "My Design Docs" },
    { id: "2", label: "Docs" },
    { id: "3", label: "Documentation" },
    { id: "4", label: "Backend-Docs-Archive" },
    { id: "5", label: "Data Operations Center System" },
    { id: "6", label: "Unrelated" },
  ];

  assert.deepEqual(
    filterAndRankFolders(folders, "").map((f) => f.id),
    ["1", "2", "3", "4", "5", "6"],
  );

  const ranked = filterAndRankFolders(folders, "docs").map((f) => f.id);
  assert.equal(ranked[0], "2"); // exact "Docs"
  assert.ok(ranked.slice(1, 3).includes("1")); // word-boundary "My Design Docs"
  assert.ok(ranked.slice(1, 3).includes("4")); // word-boundary "Backend-Docs-Archive"
  assert.ok(!ranked.includes("6"));

  const rankedDoc = filterAndRankFolders(folders, "doc").map((f) => f.id);
  assert.equal(rankedDoc[0], "2"); // prefix "Docs" (shorter)
  assert.equal(rankedDoc[1], "3"); // prefix "Documentation"
  assert.ok(rankedDoc.indexOf("1") < rankedDoc.indexOf("5")); // word-boundary beats fuzzy
});

// ─── Q5: Nesting Cycle Detection & Workspace Visibility ──────────────────────

test("Q5: wouldCreateParentCycle catches self, direct, transitive, and DOM containment cycles", () => {
  const a = createMockElement("tab-group", { id: "g-a" });
  const b = createMockElement("tab-group", { id: "g-b" });
  const c = createMockElement("tab-group", { id: "g-c" });
  const d = createMockElement("tab-group", { id: "g-d" });

  // Self cycle
  assert.equal(wouldCreateParentCycle(a, a), true);

  // Valid nesting: a -> b
  assert.equal(wouldCreateParentCycle(a, b), false);

  // Persisted transitive cycle: c -> b -> a, attempting a -> c
  const savedParents = { "g-b": "g-a", "g-c": "g-b" };
  const map = new Map([["g-a", a], ["g-b", b], ["g-c", c], ["g-d", d]]);
  assert.equal(
    wouldCreateParentCycle(a, c, { getGroupById: (id) => map.get(id), savedParents }),
    true,
  );
  // Valid unrelated branch: d -> c
  assert.equal(
    wouldCreateParentCycle(d, c, { getGroupById: (id) => map.get(id), savedParents }),
    false,
  );

  // DOM containment cycle
  const containerA = createMockElement("div", { props: { className: "tab-group-container" } });
  a.appendChild(containerA);
  containerA.appendChild(b);
  assert.equal(wouldCreateParentCycle(a, b), true);
  assert.equal(wouldCreateParentCycle(c, b), false);
});

test("Q5: nestGroupUnder and unnestGroup enforce guards and update parent attributes", () => {
  const ws = createMockElement("zen-workspace", { id: "ws-1" });
  const tabsContainer = createMockElement("div", { props: { className: "zen-workspace-normal-tabs-section" } });
  ws.tabsContainer = tabsContainer;
  ws.appendChild(tabsContainer);

  const parent = createMockElement("tab-group", { id: "parent-1", attrs: { "zen-workspace-id": "ws-1" } });
  const parentBox = createMockElement("div", { props: { className: "tab-group-container" } });
  parent.appendChild(parentBox);

  const child = createMockElement("tab-group", { id: "child-1", attrs: { "zen-workspace-id": "ws-1" } });
  const split = createMockElement("tab-group", { id: "split-1", attrs: { "split-view-group": "true" } });

  tabsContainer.appendChild(parent);
  tabsContainer.appendChild(child);
  tabsContainer.appendChild(split);

  const mockDoc = {
    createElement: (t) => createMockElement(t),
    getElementById: (id) => [parent, child, split].find((x) => x.id === id) || null,
    querySelectorAll: () => [parent, child],
  };
  const mockWin = {
    document: mockDoc,
    gZenWorkspaces: {
      activeWorkspace: "ws-1",
      activeWorkspaceStrip: tabsContainer,
      workspaceElement: (id) => (id === "ws-1" ? ws : null),
    },
  };

  // Split-view group is blocked
  assert.equal(nestGroupUnder(split, parent, { win: mockWin, save: false, sync: false }), false);

  // Valid nesting succeeds
  assert.equal(nestGroupUnder(child, parent, { win: mockWin, save: false, sync: false }), true);
  assert.equal(child.parentElement, parentBox);
  assert.equal(child.getAttribute("data-atg-parent-id"), "parent-1");

  // Reverse nesting (cycle) is blocked
  assert.equal(nestGroupUnder(parent, child, { win: mockWin, save: false, sync: false }), false);

  // Unnesting restores child to root tabsContainer and clears parent attr
  assert.equal(unnestGroup(child, { win: mockWin, save: false, sync: false }), true);
  assert.equal(child.parentElement, tabsContainer);
  assert.equal(child.hasAttribute("data-atg-parent-id"), false);
});

test("Q5: updateGroupVisibility hides inactive-workspace groups with atg-ws-hidden and removes legacy hidden", () => {
  const ws1Strip = createMockElement("div", { id: "strip-1" });
  const ws2Strip = createMockElement("div", { id: "strip-2" });
  const g1 = createMockElement("tab-group", { id: "g1", attrs: { hidden: "true", "zen-workspace-id": "ws1" } });
  const g2 = createMockElement("tab-group", { id: "g2", attrs: { "zen-workspace-id": "ws2" } });
  ws1Strip.appendChild(g1);
  ws2Strip.appendChild(g2);

  const mockWin = {
    document: {
      querySelectorAll: () => [g1, g2],
    },
    gZenWorkspaces: {
      activeWorkspace: "ws1",
      activeWorkspaceStrip: ws1Strip,
    },
  };

  const res = updateGroupVisibility(mockWin);
  assert.deepEqual(res, { visible: 1, hidden: 1 });
  assert.equal(g1.hasAttribute("hidden"), false);
  assert.equal(g1.hasAttribute("atg-ws-hidden"), false);
  assert.equal(g2.getAttribute("atg-ws-hidden"), "true");
});

// ─── Q2 & Q7: ATG Conflict Detection, Tab Counts, Shortcuts & Emoji SVG ─────

test("Q2: detectAtgConflict flags ATG globals and sets window._zaoAtgConflictDetected", () => {
  const cleanWin = { document: { getElementById: () => null } };
  const clean = detectAtgConflict(cleanWin);
  assert.equal(clean.conflict, false);
  assert.equal(cleanWin._zaoAtgConflictDetected, false);

  const conflictWin = { atgFolderLook: {}, document: { getElementById: () => null } };
  const detected = detectAtgConflict(conflictWin);
  assert.equal(detected.conflict, true);
  assert.ok(detected.sources.includes("window.atgFolderLook"));
  assert.equal(conflictWin._zaoAtgConflictDetected, true);

  const prevGlobal = globalThis.advancedTabGroups;
  globalThis.advancedTabGroups = {};
  try {
    const gConflict = detectAtgConflict(cleanWin);
    assert.equal(gConflict.conflict, true);
    assert.ok(gConflict.sources.includes("globalThis.advancedTabGroups"));
    assert.equal(cleanWin._zaoAtgConflictDetected, true);
  } finally {
    if (prevGlobal === undefined) delete globalThis.advancedTabGroups;
    else globalThis.advancedTabGroups = prevGlobal;
  }
});

test("Q7: countDirectFolderTabs counts only direct real tabs and ignores placeholders and subfolder tabs", () => {
  const folder = createMockElement("tab-group", { id: "f1" });
  const container = createMockElement("div", { props: { className: "tab-group-container" } });
  folder.appendChild(container);

  const t1 = createMockElement("tab", { id: "t1" });
  const t2 = createMockElement("tab", { id: "t2" });
  const emptyTab = createMockElement("tab", { id: "t3", attrs: { "zen-empty-tab": "true" } });
  const pinnedTab = createMockElement("tab", { id: "t4", props: { pinned: true } });

  const subFolder = createMockElement("tab-group", { id: "sub1" });
  const subTab = createMockElement("tab", { id: "t5" });
  subFolder.appendChild(subTab);

  container.appendChild(t1);
  container.appendChild(t2);
  container.appendChild(emptyTab);
  container.appendChild(pinnedTab);
  container.appendChild(subFolder);

  assert.equal(countDirectFolderTabs(folder), 2);
  assert.equal(countDirectFolderTabs(subFolder), 1);
});

test("Q7: parseFolderShortcut and matchesFolderShortcut support Ctrl/Cmd/Shift/Alt", () => {
  const ctrlShiftG = parseFolderShortcut("Ctrl+Shift+G");
  assert.equal(ctrlShiftG.ctrl, true);
  assert.equal(ctrlShiftG.shift, true);
  assert.equal(ctrlShiftG.key, "g");

  // Default Ctrl acts as cross-platform Accel (matches Ctrl or Cmd)
  assert.equal(matchesFolderShortcut({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "G" }, ctrlShiftG), true);
  assert.equal(matchesFolderShortcut({ ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, key: "g" }, ctrlShiftG), true);
  assert.equal(matchesFolderShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: "g" }, ctrlShiftG), false);

  // Explicit Cmd requires metaKey only
  const cmdShiftG = parseFolderShortcut("Cmd+Shift+G");
  assert.equal(matchesFolderShortcut({ ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, key: "G" }, cmdShiftG), true);
  assert.equal(matchesFolderShortcut({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "G" }, cmdShiftG), false);
});

test("emojiToSvgDataUrl encodes valid base64 SVG and safely escapes XML entities", () => {
  assert.equal(emojiToSvgDataUrl(""), "");
  const uri = emojiToSvgDataUrl("🚀");
  assert.ok(uri.startsWith("data:image/svg+xml;base64,"));
  const decoded = Buffer.from(uri.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  assert.ok(decoded.includes("🚀"));
  assert.ok(decoded.includes("<svg"));

  const escaped = emojiToSvgDataUrl("<script>&\"");
  const decodedEsc = Buffer.from(escaped.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  assert.ok(!decodedEsc.includes("<script>"));
  assert.ok(decodedEsc.includes("&lt;script&gt;&amp;&quot;"));
});

// ─── Q4 & Zia CSS Contracts ──────────────────────────────────────────────────

test("Q4 & Zia CSS contract: zero max-height 4000px hacks and proper userChrome.css import", () => {
  const root = process.cwd();
  const engineCss = readFileSync(resolve(root, "styles/folder-engine.css"), "utf8");
  const libraryCss = readFileSync(resolve(root, "styles/folder-library.css"), "utf8");
  const userChrome = readFileSync(resolve(root, "userChrome.css"), "utf8");

  assert.ok(!engineCss.includes("4000px"), "styles/folder-engine.css must not use max-height: 4000px");
  assert.ok(!libraryCss.includes("4000px"), "styles/folder-library.css must not use max-height: 4000px");
  assert.ok(engineCss.includes("tab-group[atg-folder-look]:not([split-view-group])"), "Zia-compatible folder-look selector must be present");
  assert.ok(engineCss.includes("atg-folder-active"), "active-in-collapsed selector must be present");
  assert.ok(engineCss.includes(".zao-move-folder-popover"), "Quick-Pick popover styles must be present");
  assert.ok(userChrome.startsWith('@import url("styles/folder-engine.css");'), "userChrome.css must import styles/folder-engine.css at the very top");
});

test("createFallbackFolderSvg builds a Zen-compatible SVG with .back/.front/.dots/.icon structure", () => {
  const mockDoc = {
    createElementNS: (_ns, tag) => createMockElement(tag),
  };
  const svg = createFallbackFolderSvg(mockDoc);
  assert.equal(svg.localName, "svg");
  assert.equal(svg.getAttribute("width"), "28");
  assert.equal(svg.getAttribute("height"), "28");
  assert.equal(svg.getAttribute("viewBox"), "0 0 28 28");
  const childClasses = svg.children.map((c) => c.getAttribute("class"));
  assert.deepEqual(childClasses, ["back", "front", "dots", "icon"]);
  const iconGroup = svg.children[3];
  assert.equal(iconGroup.children[0]?.localName, "image");
});
