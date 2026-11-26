import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ATTR_COLLAPSING,
  ATTR_FOLDER_ACTIVE,
  ATTR_FOLDER_LOOK,
  animateFolderToggle,
  setupFolderEngine,
  teardownFolderEngine,
} from "../modules/folder-engine.mjs";

// ─── Minimal DOM & WAAPI Test Harness ────────────────────────────────────────

const createDeferred = () => {
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
};

const createMockElement = (tag, { id = "", className = "", attrs = {}, rectHeight = 0, scrollHeight = 0 } = {}) => {
  const attrMap = new Map(Object.entries(attrs));
  const children = [];
  const listeners = new Map();
  const styleMap = new Map();
  const animations = [];

  const el = {
    nodeType: 1,
    localName: tag.toLowerCase(),
    tagName: tag.toLowerCase(),
    id,
    className,
    isConnected: true,
    parentElement: null,
    children,
    scrollHeight,
    _rectHeight: rectHeight,
    _animations: animations,
    value: "",
    textContent: "",
    hidden: false,
    classList: {
      _set: new Set(className ? className.split(/\s+/).filter(Boolean) : []),
      contains(c) { return this._set.has(c); },
      add(c) { this._set.add(c); el.className = [...this._set].join(" "); },
      remove(c) { this._set.delete(c); el.className = [...this._set].join(" "); },
      toggle(c, force) {
        const next = force === undefined ? !this._set.has(c) : Boolean(force);
        if (next) this._set.add(c);
        else this._set.delete(c);
        el.className = [...this._set].join(" ");
        return next;
      },
    },
    style: {
      set overflow(v) { styleMap.set("overflow", v); },
      get overflow() { return styleMap.get("overflow") || ""; },
      set height(v) { styleMap.set("height", v); },
      get height() { return styleMap.get("height") || ""; },
      set display(v) { styleMap.set("display", v); },
      get display() { return styleMap.get("display") || ""; },
      setProperty(k, v) { styleMap.set(k, v); },
      getPropertyValue(k) { return styleMap.get(k) || ""; },
      removeProperty(k) { styleMap.delete(k); },
    },
    getAttribute(name) { return attrMap.has(name) ? attrMap.get(name) : null; },
    setAttribute(name, value) { attrMap.set(name, String(value)); },
    removeAttribute(name) { attrMap.delete(name); },
    hasAttribute(name) { return attrMap.has(name); },
    toggleAttribute(name, force) {
      const next = force === undefined ? !attrMap.has(name) : Boolean(force);
      if (next) attrMap.set(name, "");
      else attrMap.delete(name);
      return next;
    },
    getBoundingClientRect() {
      return { width: 200, height: el._rectHeight, top: 0, left: 0, bottom: el._rectHeight, right: 200 };
    },
    animate(keyframes, options) {
      const d = createDeferred();
      const anim = {
        keyframes,
        options,
        cancelled: false,
        finished: d.promise,
        finishNow: () => d.resolve(),
        cancel() {
          this.cancelled = true;
          d.resolve();
        },
      };
      animations.push(anim);
      return anim;
    },
    appendChild(child) {
      if (child.parentElement) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx !== -1) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = el;
      children.push(child);
      return child;
    },
    prepend(child) {
      if (child.parentElement) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx !== -1) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = el;
      children.unshift(child);
      return child;
    },
    after(sibling) {
      if (!el.parentElement) return;
      const idx = el.parentElement.children.indexOf(el);
      sibling.parentElement = el.parentElement;
      el.parentElement.children.splice(idx + 1, 0, sibling);
    },
    remove() {
      if (!el.parentElement) return;
      const idx = el.parentElement.children.indexOf(el);
      if (idx !== -1) el.parentElement.children.splice(idx, 1);
      el.parentElement = null;
      el.isConnected = false;
    },
    focus() {},
    select() {},
    setSelectionRange() {},
    addEventListener(type, fn, capture = false) {
      const key = `${type}:${Boolean(capture)}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key).push(fn);
    },
    removeEventListener(type, fn, capture = false) {
      const key = `${type}:${Boolean(capture)}`;
      const arr = listeners.get(key);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    dispatchEvent(event) {
      event.target = event.target || el;
      for (const capture of [true, false]) {
        const key = `${event.type}:${capture}`;
        for (const fn of [...(listeners.get(key) || [])]) {
          fn(event);
          if (event._immediateStopped) return !event.defaultPrevented;
        }
      }
      return !event.defaultPrevented;
    },
    matches(selector) {
      return selector.split(",").map((s) => s.trim()).some((part) => {
        if (part === ".tab-group-label-container") return el.className.split(/\s+/).includes("tab-group-label-container");
        if (part === ".tab-group-container") return el.className.split(/\s+/).includes("tab-group-container");
        if (part === ".tab-group-label") return el.className.split(/\s+/).includes("tab-group-label");
        if (part === ".zao-folder-rename-input") return el.className.split(/\s+/).includes("zao-folder-rename-input");
        if (part === ".tab-group-folder-icon") return el.className.split(/\s+/).includes("tab-group-folder-icon");
        if (part === ".zao-folder-tab-count") return el.className.split(/\s+/).includes("zao-folder-tab-count");
        if (part === "tab-group") return el.localName === "tab-group";
        if (part === "zen-folder") return el.localName === "zen-folder";
        if (part === "zen-library") return el.localName === "zen-library";
        if (part === "tab-group:not([split-view-group])") {
          return el.localName === "tab-group" && !el.hasAttribute("split-view-group");
        }
        if (part === `tab-group[${ATTR_FOLDER_LOOK}]`) {
          return el.localName === "tab-group" && el.hasAttribute(ATTR_FOLDER_LOOK);
        }
        if (part === `tab[${ATTR_FOLDER_ACTIVE}]`) {
          return el.localName === "tab" && el.hasAttribute(ATTR_FOLDER_ACTIVE);
        }
        if (part === "tab[selected]") {
          return el.localName === "tab" && (el.selected || el.hasAttribute("selected"));
        }
        if (part === "tab") return el.localName === "tab";
        if (part === "svg") return el.localName === "svg";
        return false;
      });
    },
    closest(selector) {
      let cur = el;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(selector) {
      const results = [];
      if (selector.startsWith(":scope > ")) {
        const rest = selector.slice(":scope > ".length);
        const parts = rest.split(" > ");
        const walkChain = (nodes, depth) => {
          for (const node of nodes) {
            if (node.matches(parts[depth])) {
              if (depth === parts.length - 1) results.push(node);
              else walkChain(node.children, depth + 1);
            }
          }
        };
        walkChain(el.children, 0);
        return results;
      }
      const walk = (node) => {
        for (const c of node.children) {
          if (c.matches(selector)) results.push(c);
          walk(c);
        }
      };
      walk(el);
      return results;
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] || null;
    },
  };
  return el;
};

const createFolderFixture = ({ tabCount = 3, activeIndex = -1, extraGroupAttrs = {} } = {}) => {
  const group = createMockElement("tab-group", {
    id: "grp-1",
    attrs: { label: "Work", [ATTR_FOLDER_LOOK]: "true", ...extraGroupAttrs },
  });
  const header = createMockElement("div", { className: "tab-group-label-container" });
  const label = createMockElement("label", { className: "tab-group-label" });
  header.appendChild(label);
  group.appendChild(header);

  const container = createMockElement("div", {
    className: "tab-group-container",
    scrollHeight: tabCount * 36,
    rectHeight: tabCount * 36,
  });
  group.appendChild(container);

  const tabs = [];
  for (let i = 0; i < tabCount; i++) {
    const isActive = i === activeIndex;
    const tab = createMockElement("tab", {
      id: `tab-${i}`,
      attrs: isActive ? { selected: "true", [ATTR_FOLDER_ACTIVE]: "true" } : { "aria-hidden": "true" },
      rectHeight: 36,
    });
    if (isActive) tab.selected = true;
    container.appendChild(tab);
    tabs.push(tab);
  }
  return { group, header, label, container, tabs };
};

const createMockEvent = (type, target) => ({
  type,
  target,
  defaultPrevented: false,
  _stopped: false,
  _immediateStopped: false,
  screenX: 100,
  screenY: 120,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this._stopped = true; },
  stopImmediatePropagation() { this._immediateStopped = true; },
});

// ─── 1. CSS Contract Tests ───────────────────────────────────────────────────

test("CSS collapse rules allow mid-collapse WAAPI animation while preserving split-view, drag-image & Library guards", () => {
  const root = process.cwd();
  const userChrome = readFileSync(resolve(root, "userChrome.css"), "utf8");
  const folderCss = readFileSync(resolve(root, "styles/folder-engine.css"), "utf8");

  assert.ok(
    userChrome.includes(
      'tab-group[collapsed]:not([split-view-group]):not([drag-image]):not([data-zao-collapsing="true"]) tab[aria-hidden="true"]',
    ),
    "userChrome.css must guard tab[aria-hidden='true'] collapse rule with :not([data-zao-collapsing=\"true\"])",
  );
  assert.ok(
    userChrome.includes(
      'tab-group[collapsed]:not([split-view-group]):not([drag-image]):not([data-zao-collapsing="true"]) > .tab-group-container > :is(tab-group, zen-folder)',
    ),
    "userChrome.css must guard nested subfolder collapse rule with :not([data-zao-collapsing=\"true\"])",
  );
  assert.ok(
    folderCss.includes(
      '#tabbrowser-tabs tab-group[collapsed][data-zao-collapsing="true"]:not([split-view-group]):not([drag-image]) > .tab-group-container > tab:not([zen-empty-tab]):not([atg-folder-active]):not([selected])',
    ),
    "styles/folder-engine.css must keep direct child tabs visible during data-zao-collapsing=\"true\"",
  );
  assert.ok(
    folderCss.includes("user-select: none !important;"),
    "styles/folder-engine.css should prevent accidental label text selection during rapid toggling",
  );
});

// ─── 2. Smooth Close Animation Tests ─────────────────────────────────────────

test("animateFolderToggle runs smooth reverse-stagger close animation and cleans up ATTR_COLLAPSING on finish", async () => {
  const { group, container, tabs } = createFolderFixture({ tabCount: 3, activeIndex: 0 });
  const win = { closed: false, setTimeout, clearTimeout };

  animateFolderToggle(win, group, true);

  assert.equal(group.getAttribute(ATTR_COLLAPSING), "true");
  assert.equal(container.style.overflow, "hidden");
  assert.equal(container._animations.length, 1);
  assert.deepEqual(container._animations[0].keyframes, [
    { height: "108px" },
    { height: "36px" },
  ]);
  assert.equal(container._animations[0].options.fill, "forwards");

  // Active tab (index 0) must stay untouched; inactive tabs (1, 2) animate out with reverse stagger.
  assert.equal(tabs[0]._animations.length, 0);
  assert.equal(tabs[1]._animations.length, 1);
  assert.equal(tabs[2]._animations.length, 1);
  assert.ok(
    tabs[1]._animations[0].options.delay > tabs[2]._animations[0].options.delay,
    "bottom tab should tuck slightly before top tab (reverse stagger)",
  );

  // Settle all animations and verify clean teardown
  container._animations[0].finishNow();
  tabs[1]._animations[0].finishNow();
  tabs[2]._animations[0].finishNow();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(group.hasAttribute(ATTR_COLLAPSING), false);
  assert.equal(container.style.overflow, "");
  assert.equal(container.style.height, "");
  assert.equal(container._animations[0].cancelled, true);
  assert.equal(tabs[1]._animations[0].cancelled, true);
});

// ─── 3. Rapid Toggle Interruptibility Tests ──────────────────────────────────

test("animateFolderToggle is fully interruptible across rapid open → close → open → close without getting stuck", async () => {
  const { group, container, tabs } = createFolderFixture({ tabCount: 4 });
  const win = { closed: false, setTimeout, clearTimeout };

  // 1. Start closing from full height (144px)
  animateFolderToggle(win, group, true);
  assert.equal(group.getAttribute(ATTR_COLLAPSING), "true");
  const closeAnim1 = container._animations[0];
  assert.deepEqual(closeAnim1.keyframes, [{ height: "144px" }, { height: "0px" }]);

  // 2. Interrupt mid-flight at 60px -> expand!
  container._rectHeight = 60;
  animateFolderToggle(win, group, false);
  assert.equal(closeAnim1.cancelled, true, "prior close animation must be cancelled");
  assert.equal(group.hasAttribute(ATTR_COLLAPSING), false, "ATTR_COLLAPSING must clear immediately on expand");
  const openAnim1 = container._animations[1];
  assert.deepEqual(openAnim1.keyframes, [{ height: "60px" }, { height: "144px" }]);
  assert.ok(openAnim1.options.duration < 250, "mid-flight interruption scales duration proportionally");

  // 3. Interrupt again at 100px -> close!
  container._rectHeight = 100;
  animateFolderToggle(win, group, true);
  assert.equal(openAnim1.cancelled, true);
  assert.equal(group.getAttribute(ATTR_COLLAPSING), "true");
  const closeAnim2 = container._animations[2];
  assert.deepEqual(closeAnim2.keyframes, [{ height: "100px" }, { height: "0px" }]);

  // 4. Finish final close cleanly
  closeAnim2.finishNow();
  for (const t of tabs) {
    for (const a of t._animations) a.finishNow();
  }
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(group.hasAttribute(ATTR_COLLAPSING), false);
  assert.equal(container.style.overflow, "");
  assert.equal(container.style.height, "");
  // aria-hidden on tabs was never corrupted by animation
  assert.equal(tabs[0].getAttribute("aria-hidden"), "true");
});

// ─── 4. Reduced Motion & Guard Tests ─────────────────────────────────────────

test("animateFolderToggle respects prefers-reduced-motion and guards split-view, drag-image & sidebar copies", () => {
  const { group, container } = createFolderFixture({ tabCount: 3 });

  // Reduced motion
  group.setAttribute(ATTR_COLLAPSING, "true");
  animateFolderToggle({ closed: false, gReduceMotion: true }, group, true);
  assert.equal(container._animations.length, 0);
  assert.equal(group.hasAttribute(ATTR_COLLAPSING), false);

  // Split-view group
  const split = createFolderFixture({ tabCount: 2, extraGroupAttrs: { "split-view-group": "true" } });
  animateFolderToggle({ closed: false }, split.group, true);
  assert.equal(split.container._animations.length, 0);

  // Drag image
  const drag = createFolderFixture({ tabCount: 2, extraGroupAttrs: { "drag-image": "true" } });
  animateFolderToggle({ closed: false }, drag.group, true);
  assert.equal(drag.container._animations.length, 0);

  // Zen Library copy (descendant of <zen-library>)
  const zenLib = createMockElement("zen-library", { id: "zen-library" });
  const libCopy = createFolderFixture({ tabCount: 2 });
  zenLib.appendChild(libCopy.group);
  animateFolderToggle({ closed: false }, libCopy.group, true);
  assert.equal(libCopy.container._animations.length, 0);
});

// ─── 5. Double-Click Rename Disabled + Context-Menu Rename Works ─────────────

test("double-click on folder header is suppressed (no inline rename), while Right-Click -> Rename works cleanly", () => {
  const docEl = createMockElement("window");
  const popupset = createMockElement("popupset", { id: "mainPopupSet" });
  const tabContainer = createMockElement("tabs", { id: "tabbrowser-tabs" });

  const { group, header, label } = createFolderFixture({ tabCount: 2 });
  group.label = "Work";
  tabContainer.appendChild(group);

  const zenFolder = createMockElement("zen-folder", { id: "zf-1" });
  const zfHeader = createMockElement("div", { className: "tab-group-label-container" });
  zenFolder.appendChild(zfHeader);
  tabContainer.appendChild(zenFolder);

  const splitGroup = createMockElement("tab-group", { id: "sg-1", attrs: { "split-view-group": "true" } });
  const sgHeader = createMockElement("div", { className: "tab-group-label-container" });
  splitGroup.appendChild(sgHeader);
  tabContainer.appendChild(splitGroup);

  const plainTab = createMockElement("tab", { id: "plain-tab" });
  tabContainer.appendChild(plainTab);

  const mockDoc = {
    documentElement: docEl,
    body: popupset,
    createElement: (tag) => createMockElement(tag),
    createElementNS: (_ns, tag) => createMockElement(tag),
    createXULElement: (tag) => {
      const el = createMockElement(tag);
      el.openPopupAtScreen = () => {};
      return el;
    },
    getElementById: (id) => (id === "mainPopupSet" ? popupset : null),
    querySelector: (sel) => tabContainer.querySelector(sel) || popupset.querySelector(sel),
  };

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const win = {
    closed: false,
    document: mockDoc,
    gBrowser: { tabContainer },
    MutationObserver: FakeMutationObserver,
    setTimeout,
    clearTimeout,
  };

  setupFolderEngine(win);
  try {
    // 1. Double-clicking a folder header label must be suppressed & must NOT open rename input
    const dblEvt = createMockEvent("dblclick", label);
    tabContainer.dispatchEvent(dblEvt);
    assert.equal(dblEvt.defaultPrevented, true, "dblclick on folder label must be prevented");
    assert.equal(dblEvt._stopped, true, "dblclick on folder label must stop propagation");
    assert.equal(dblEvt._immediateStopped, true, "dblclick on folder label must stop immediate propagation");
    assert.equal(docEl.hasAttribute("data-zao-renaming-folder"), false);
    assert.equal(header.querySelector(".zao-folder-rename-input"), null);

    // 2. Double-clicking a native zen-folder header must also be suppressed
    const zfDbl = createMockEvent("dblclick", zfHeader);
    tabContainer.dispatchEvent(zfDbl);
    assert.equal(zfDbl.defaultPrevented, true, "dblclick on zen-folder header must be prevented");

    // 3. Double-clicking a split-view header or a plain tab must NOT be suppressed
    const sgDbl = createMockEvent("dblclick", sgHeader);
    tabContainer.dispatchEvent(sgDbl);
    assert.equal(sgDbl.defaultPrevented, false);

    const tabDbl = createMockEvent("dblclick", plainTab);
    tabContainer.dispatchEvent(tabDbl);
    assert.equal(tabDbl.defaultPrevented, false);

    // 4. Right-Click -> Rename context menu MUST still trigger inline rename cleanly
    const ctxEvt = createMockEvent("contextmenu", header);
    tabContainer.dispatchEvent(ctxEvt);
    assert.equal(ctxEvt.defaultPrevented, true);

    const popup = popupset.children.find((c) => c.id === "zao-folder-context-menu");
    assert.ok(popup, "folder context menu should be created");
    const renameItem = popup.children.find((c) => c.id === "zao-folder-ctx-rename");
    assert.ok(renameItem, "Rename menuitem should exist");

    renameItem.dispatchEvent(createMockEvent("command", renameItem));
    assert.equal(docEl.getAttribute("data-zao-renaming-folder"), "true");

    const input = header.querySelector(".zao-folder-rename-input");
    assert.ok(input, "inline rename input should appear after Right-Click -> Rename");
    assert.equal(input.value, "Work");

    // 5. Double-clicking inside the active rename input (to select text) must NOT be prevented
    const inputDbl = createMockEvent("dblclick", input);
    tabContainer.dispatchEvent(inputDbl);
    assert.equal(inputDbl.defaultPrevented, false, "dblclick inside rename input should still select text");

    // 6. Pressing Enter commits the new name
    input.value = "Deep Work";
    input.dispatchEvent({ ...createMockEvent("keydown", input), key: "Enter" });
    assert.equal(group.label, "Deep Work");
    assert.equal(docEl.hasAttribute("data-zao-renaming-folder"), false);
  } finally {
    teardownFolderEngine(win);
  }
});
