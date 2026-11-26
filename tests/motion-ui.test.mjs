import test from "node:test";
import assert from "node:assert/strict";

import {
  animateSortElement,
  computeFlightDuration,
  createPresentationScope,
  prefersReducedMotion,
} from "../modules/sort-motion.mjs";
import { showToast } from "../modules/ui-toast.mjs";
import { setupGroupDrag, teardownGroupDrag } from "../modules/group-drag.mjs";
import {
  fetchZenColorsFromBrowser,
  openColorPopover,
  updateSwatchAppearance,
} from "../modules/color-picker.mjs";
import { HEX_BY_NAME, HTML_NS, PRESET_COLORS } from "../modules/config.mjs";

// ─── Minimal DOM helper for motion / UI tests ────────────────────────────────

const createDom = () => {
  const createClassList = (el) => {
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
      _set: set,
      _setFromString: (str) => {
        set.clear();
        for (const token of String(str || "").split(/\s+/).filter(Boolean)) set.add(token);
      },
    };
  };

  const matchesSingle = (el, sel) => {
    const s = sel.trim();
    if (!s) return false;
    if (s.startsWith("#")) return el.id === s.slice(1);
    if (s.startsWith(".")) return el.classList.contains(s.slice(1));
    return el.localName === s.toLowerCase();
  };

  const makeEl = (tag, ns = HTML_NS) => {
    const attrs = new Map();
    const children = [];
    const listeners = new Map();
    const styleMap = new Map();
    const el = {
      nodeType: 1,
      namespaceURI: ns,
      tagName: tag.toUpperCase(),
      localName: tag.toLowerCase(),
      id: "",
      title: "",
      type: "",
      value: "",
      textContent: "",
      isConnected: false,
      parentElement: null,
      get parentNode() { return this.parentElement; },
      children,
      dataset: {},
      style: {
        cssText: "",
        background: "",
        left: "",
        top: "",
        setProperty: (k, v) => styleMap.set(k, String(v)),
        getPropertyValue: (k) => styleMap.get(k) || "",
        getPropertyPriority: () => "",
        removeProperty: (k) => { styleMap.delete(k); },
      },
      _rect: { left: 0, top: 0, width: 100, height: 30, right: 100, bottom: 30 },
      getBoundingClientRect() { return this._rect; },
      focused: false,
      focus() { this.focused = true; },
      get firstChild() { return children[0] || null; },
      get className() { return [...this.classList._set].join(" "); },
      set className(v) { this.classList._setFromString(v); },
      getAttribute(k) { return k === "id" && this.id ? this.id : (attrs.has(k) ? attrs.get(k) : null); },
      setAttribute(k, v) { if (k === "id") this.id = String(v); attrs.set(k, String(v)); },
      removeAttribute(k) { if (k === "id") this.id = ""; attrs.delete(k); },
      hasAttribute(k) { return (k === "id" && Boolean(this.id)) || attrs.has(k); },
      toggleAttribute(k, force) {
        const next = force === undefined ? !this.hasAttribute(k) : Boolean(force);
        if (next) this.setAttribute(k, "");
        else this.removeAttribute(k);
        return next;
      },
      appendChild(child) {
        const attach = (node) => {
          if (node.parentElement) {
            const i = node.parentElement.children.indexOf(node);
            if (i >= 0) node.parentElement.children.splice(i, 1);
          }
          node.parentElement = this;
          const setConn = (n, val) => {
            n.isConnected = val;
            for (const c of n.children || []) setConn(c, val);
          };
          setConn(node, this.isConnected);
          children.push(node);
        };
        if (child.nodeType === 11) {
          for (const item of [...child.children]) attach(item);
          child.children.length = 0;
          return child;
        }
        attach(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parentElement) {
          const i = child.parentElement.children.indexOf(child);
          if (i >= 0) child.parentElement.children.splice(i, 1);
        }
        child.parentElement = this;
        child.isConnected = this.isConnected;
        const idx = ref ? children.indexOf(ref) : -1;
        if (idx >= 0) children.splice(idx, 0, child);
        else children.push(child);
        return child;
      },
      remove() {
        if (this.parentElement) {
          const i = this.parentElement.children.indexOf(this);
          if (i >= 0) this.parentElement.children.splice(i, 1);
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
      matches(selector) {
        return String(selector || "").split(",").some((part) => matchesSingle(this, part));
      },
      closest(selector) {
        let cur = this;
        while (cur) {
          if (cur.nodeType === 1 && cur.matches(selector)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(selector) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children || []) {
            if (c.matches?.(selector)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatchEvent(event) {
        const ev = { stopPropagation() {}, preventDefault() {}, target: this, ...event };
        for (const fn of [...(listeners.get(ev.type) || [])]) fn(ev);
      },
      click() { this.dispatchEvent({ type: "click" }); },
    };
    el.classList = createClassList(el);
    return el;
  };

  const docListeners = new Map();
  const body = makeEl("body");
  body.isConnected = true;
  const documentElement = makeEl("html");
  documentElement.isConnected = true;
  documentElement.appendChild(body);

  const doc = {
    body,
    documentElement,
    createElementNS: (ns, tag) => makeEl(tag, ns),
    createElement: (tag) => makeEl(tag, HTML_NS),
    createDocumentFragment: () => ({
      nodeType: 11,
      children: [],
      appendChild(c) { this.children.push(c); return c; },
    }),
    getElementById: (id) => documentElement.querySelector(`#${id}`),
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => docListeners.get(type)?.delete(fn),
    dispatchEvent: (event) => {
      const ev = { stopPropagation() {}, preventDefault() {}, ...event };
      for (const fn of [...(docListeners.get(ev.type) || [])]) fn(ev);
    },
    _listeners: docListeners,
  };

  return { doc, makeEl };
};

// ─── 1. sort-motion.mjs ──────────────────────────────────────────────────────

test("sort-motion: prefersReducedMotion, computeFlightDuration, createPresentationScope scroll threshold & abort cancel", async () => {
  assert.equal(prefersReducedMotion({ gReduceMotion: true }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ gReduceMotion: false, matchMedia: () => ({ matches: false }) }), false);

  // computeFlightDuration clamping & monotonicity
  assert.equal(computeFlightDuration(0), 210);
  assert.equal(computeFlightDuration(-50), 210);
  assert.equal(computeFlightDuration(Number.NaN), 210);
  assert.ok(computeFlightDuration(400) > computeFlightDuration(25));
  assert.equal(computeFlightDuration(100000), 420);

  // createPresentationScope scroll-threshold (<= 4px ignored, > 4px cancels)
  const winListeners = new Map();
  const containerListeners = new Map();
  let rafId = 0;
  const cancelledRafs = [];
  const container = {
    scrollTop: 100,
    scrollLeft: 0,
    addEventListener: (t, fn) => containerListeners.set(t, fn),
    removeEventListener: (t) => containerListeners.delete(t),
  };
  const win = {
    closed: false,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (t, fn) => winListeners.set(t, fn),
    removeEventListener: (t) => winListeners.delete(t),
    requestAnimationFrame: () => ++rafId,
    cancelAnimationFrame: (id) => cancelledRafs.push(id),
  };

  const scope = createPresentationScope(win, { container, scrollThreshold: 4 });
  assert.equal(scope.cancelled, false);
  // Sub-threshold scroll (3px) does NOT cancel
  container.scrollTop = 103;
  containerListeners.get("scroll")({ target: container });
  assert.equal(scope.cancelled, false, "Sub-4px scroll must not abort choreography");

  // Above-threshold scroll (10px) cancels and resolves interrupted
  container.scrollTop = 110;
  containerListeners.get("scroll")({ target: container });
  assert.equal(scope.cancelled, true, "Scroll > 4px must cancel scope");
  await scope.interrupted;
  scope.dispose();
  assert.equal(cancelledRafs.length, 1);
  assert.equal(containerListeners.size, 0);

  // AbortSignal cancellation
  const controller = new AbortController();
  const scope2 = createPresentationScope(win, { container, signal: controller.signal });
  assert.equal(scope2.cancelled, false);
  controller.abort();
  assert.equal(scope2.cancelled, true);
  await scope2.interrupted;
  scope2.dispose();

  // animateSortElement cancels WAAPI animation on abort
  let animCancelled = false;
  const fakeNode = {
    animate: () => ({
      finished: new Promise(() => {}),
      cancel: () => { animCancelled = true; },
    }),
  };
  const animController = new AbortController();
  const p = animateSortElement(win, fakeNode, [{ opacity: 0 }, { opacity: 1 }], { duration: 500 }, null, animController.signal);
  animController.abort();
  await p;
  assert.equal(animCancelled, true);
});

// ─── 2. ui-toast.mjs ─────────────────────────────────────────────────────────

test("ui-toast: createElementNS, { update, dismiss }, action button, max-3 cap, and hover-timer leak guard", () => {
  const { doc } = createDom();
  const timers = new Map();
  let nextTimerId = 1;
  const win = {
    document: doc,
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };

  // Show toast with action button and verify HTML_NS + SVG_NS creation
  let actionClicked = 0;
  const h1 = showToast("Sorting...", {
    type: "info",
    duration: 5000,
    targetWindow: win,
    action: { label: "Undo", keepOpen: true, onClick: () => { actionClicked += 1; } },
  });

  const container = doc.getElementById("zao-toast-container");
  assert.ok(container);
  assert.equal(container.namespaceURI, HTML_NS);
  const toastEl = container.children[0];
  assert.equal(toastEl.namespaceURI, HTML_NS);
  assert.equal(toastEl.querySelector("svg").namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(toastEl.getAttribute("role"), "status");

  // Action click with keepOpen: true keeps toast open
  toastEl.querySelector(".zao-toast-action").click();
  assert.equal(actionClicked, 1);
  assert.equal(toastEl.classList.contains("zao-toast-dismissing"), false);

  // Live update switches type -> error (role="alert") & message text
  h1.update("Failed!", { type: "error", action: null });
  assert.equal(toastEl.querySelector(".zao-toast-message").textContent, "Failed!");
  assert.equal(toastEl.getAttribute("role"), "alert");
  assert.equal(toastEl.querySelector(".zao-toast-action"), null);

  // Hover-timer leak guard: mouseenter clears timer, dismiss + mouseleave does NOT leak a new timer
  toastEl.dispatchEvent({ type: "mouseenter" });
  const timersAfterEnter = timers.size;
  assert.equal(timersAfterEnter, 0, "mouseenter pauses auto-dismiss timer");
  h1.dismiss();
  const timersAfterDismiss = timers.size; // only exit animation timer
  toastEl.dispatchEvent({ type: "mouseleave" });
  assert.equal(timers.size, timersAfterDismiss, "mouseleave after dismiss must not schedule a new timer");

  // Flush exit timer to remove toast & empty container
  for (const { fn } of [...timers.values()]) fn();
  timers.clear();
  assert.equal(doc.getElementById("zao-toast-container"), null);

  // Max-3 cap: creating 4 toasts dismisses the oldest active toast
  showToast("One", { duration: 0, targetWindow: win });
  showToast("Two", { duration: 0, targetWindow: win });
  showToast("Three", { duration: 0, targetWindow: win });
  showToast("Four", { duration: 0, targetWindow: win });
  const c2 = doc.getElementById("zao-toast-container");
  assert.equal(c2.children[0].classList.contains("zao-toast-dismissing"), true, "Oldest toast marked dismissing on 4th toast");
  const activeCount = c2.children.filter((el) => !el.classList.contains("zao-toast-dismissing")).length;
  assert.equal(activeCount, 3, "At most 3 active toasts simultaneously");
});

// ─── 3. group-drag.mjs ───────────────────────────────────────────────────────

test("group-drag: dragleave child-target guard and edge-reorder activation/cleanup", () => {
  const { doc, makeEl } = createDom();
  const ws = makeEl("zen-workspace");
  const group = makeEl("tab-group");
  group.setAttribute("label", "Work");
  const header = makeEl("div");
  header.classList.add("tab-group-label-container");
  header._rect = { left: 0, top: 100, width: 200, height: 30, right: 200, bottom: 130 };
  const labelChild = makeEl("span");
  labelChild.classList.add("tab-group-label");
  header.appendChild(labelChild);
  group.appendChild(header);
  group.labelContainerElement = header;
  ws.appendChild(group);
  doc.body.appendChild(ws);

  const outsideEl = makeEl("div");
  doc.body.appendChild(outsideEl);

  const tabContainer = makeEl("div");
  tabContainer.tabDragAndDrop = {};

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const win = {
    document: doc,
    MutationObserver: FakeMutationObserver,
    gBrowser: { tabContainer },
    addEventListener() {},
    removeEventListener() {},
  };

  setupGroupDrag(win);
  try {
    assert.equal(header.classList.contains("zen-drop-target"), true);

    // Drag over top edge (clientY=102 -> overlap = 2/30 = 0.067 < 0.20) activates edge reorder
    doc.dispatchEvent({
      type: "dragover",
      target: labelChild,
      clientY: 102,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(header.hasAttribute("data-zao-edge-reorder"), true);
    assert.equal(header.classList.contains("zen-drop-target"), false);

    // dragleave moving into a child inside edgeHeader must NOT clear edge-reorder
    doc.dispatchEvent({ type: "dragleave", target: header, relatedTarget: labelChild });
    assert.equal(header.hasAttribute("data-zao-edge-reorder"), true, "dragleave to child element preserves edge reorder");

    // dragleave moving outside edgeHeader clears edge-reorder and restores zen-drop-target
    doc.dispatchEvent({ type: "dragleave", target: header, relatedTarget: outsideEl });
    assert.equal(header.hasAttribute("data-zao-edge-reorder"), false, "dragleave outside clears edge reorder");
    assert.equal(header.classList.contains("zen-drop-target"), true);
  } finally {
    teardownGroupDrag(win);
    assert.equal(win._zaoGroupDrag, undefined);
  }
});

// ─── 4. color-picker.mjs ─────────────────────────────────────────────────────

test("color-picker: batched probes, viewport right-edge clamp, keyboard Enter/Escape, and Reset swatch", async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevServices = globalThis.Services;

  const { doc, makeEl } = createDom();

  // 4a. Batched probes in a single DocumentFragment append
  let rootAppendCalls = 0;
  const origAppend = doc.documentElement.appendChild.bind(doc.documentElement);
  doc.documentElement.appendChild = (node) => {
    rootAppendCalls += 1;
    return origAppend(node);
  };
  const browserWin = {
    document: doc,
    getComputedStyle: (probe) => ({
      backgroundColor: probe.style.cssText.includes("blue") ? "rgb(10, 20, 200)" : "rgb(0, 0, 0)",
    }),
  };
  globalThis.Services = { wm: { getMostRecentWindow: () => browserWin } };
  const prevBlue = HEX_BY_NAME.get("blue");

  fetchZenColorsFromBrowser();
  assert.equal(rootAppendCalls, 1, "All 9 color probes appended in a single batched DocumentFragment");
  assert.equal(HEX_BY_NAME.get("blue"), "rgb(10, 20, 200)");
  assert.equal(doc.documentElement.children.length, 1, "All probe nodes removed after measurement");
  HEX_BY_NAME.set("blue", prevBlue);

  // 4b. Popover viewport right-edge clamp, Reset swatch, and Enter/Escape keyboard handling
  globalThis.document = doc;
  globalThis.window = {
    innerWidth: 300,
    innerHeight: 400,
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    const rule = { name: "Work", domains: ["github.com"], color: "blue" };
    const swatch = makeEl("button");
    swatch._rect = { left: 260, top: 200, width: 24, height: 24, right: 284, bottom: 224 };
    doc.body.appendChild(swatch);
    updateSwatchAppearance(swatch, rule.color);
    assert.equal(swatch.classList.contains("zao-swatch-empty"), false);

    let changes = 0;
    openColorPopover(rule, swatch, () => { changes += 1; });

    const pop = doc.querySelector(".zao-color-popover");
    assert.ok(pop);
    // Default mock rect width=100, innerWidth=300, gap=8 -> maxLeft = 300 - 100 - 8 = 192
    assert.equal(pop.style.left, "192px", "Popover clamped inside viewport right edge");
    assert.equal(pop.querySelectorAll(".zao-preset").length, PRESET_COLORS.length + 1, "Reset swatch + all presets rendered");

    // Click Reset swatch
    const resetBtn = pop.querySelector(".zao-preset-reset");
    resetBtn.click();
    assert.equal(rule.color, undefined, "Reset swatch clears rule.color");
    assert.equal(changes, 1);
    assert.equal(swatch.classList.contains("zao-swatch-empty"), true);
    assert.equal(resetBtn.getAttribute("aria-pressed"), "true");

    // Keyboard Enter on hex input closes popover
    const hexInput = pop.querySelector(".zao-color-hex");
    hexInput.value = "#12ab34";
    hexInput.dispatchEvent({ type: "input" });
    assert.equal(rule.color, "#12ab34");
    hexInput.dispatchEvent({ type: "keydown", key: "Enter" });
    assert.equal(pop.isConnected, false, "Enter on hex input closes popover");

    // Reopen and press Escape on document -> closes popover & restores focus to swatch
    openColorPopover(rule, swatch, () => {});
    const pop2 = doc.querySelector(".zao-color-popover");
    await new Promise((r) => setTimeout(r, 10)); // wait for attachTimer=0
    doc.dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(pop2.isConnected, false, "Escape closes popover");
    assert.equal(swatch.focused, true, "Escape returns focus to swatch");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.Services = prevServices;
  }
});
