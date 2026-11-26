import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_EXPAND_DELAY_MS,
  computeEdgeScrollVelocity,
  computeSiblingShifts,
  resolveTargetIndex,
  setupGroupDrag,
  teardownGroupDrag,
} from "../modules/group-drag.mjs";

// Minimal DOM harness supporting classList, attributes, style, selector matching,
// getBoundingClientRect, and capture-phase event dispatch.
const createDragDom = () => {
  const listeners = new Map();

  const makeStyle = () => {
    const props = new Map();
    return {
      setProperty(name, value, priority = "") {
        props.set(name, { value: String(value), priority: String(priority || "") });
      },
      getPropertyValue(name) {
        return props.get(name)?.value || "";
      },
      getPropertyPriority(name) {
        return props.get(name)?.priority || "";
      },
      removeProperty(name) {
        const prev = props.get(name)?.value || "";
        props.delete(name);
        return prev;
      },
      get transform() {
        return props.get("transform")?.value || "";
      },
      set transform(v) {
        if (!v) props.delete("transform");
        else props.set("transform", { value: String(v), priority: "" });
      },
      _map: props,
    };
  };

  const matchesSingle = (el, sel) => {
    const s = sel.trim();
    if (!s) return false;
    // Handle :scope > prefix by stripping it for direct checks
    const cleaned = s.replace(/^:scope\s*>\s*/, "");
    // Handle attribute selectors like .cls[attr] or tag[attr] or [attr]
    const parts = cleaned.match(/([a-zA-Z0-9_-]+|\.[a-zA-Z0-9_-]+|\[[^\]]+\])/g) || [];
    if (parts.length === 0) return false;
    for (const part of parts) {
      if (part.startsWith(".")) {
        if (!el.classList.contains(part.slice(1))) return false;
      } else if (part.startsWith("[")) {
        const inner = part.slice(1, -1);
        const eq = inner.indexOf("=");
        if (eq === -1) {
          if (!el.hasAttribute(inner)) return false;
        } else {
          const k = inner.slice(0, eq).trim();
          const v = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
          if (el.getAttribute(k) !== v) return false;
        }
      } else {
        if (el.localName !== part.toLowerCase()) return false;
      }
    }
    return true;
  };

  const matchesSelector = (el, selector) =>
    String(selector || "")
      .split(",")
      .some((part) => matchesSingle(el, part));

  const makeEl = (tag) => {
    const attrs = new Map();
    const classes = new Set();
    const style = makeStyle();
    const elListeners = new Map();

    const el = {
      nodeType: 1,
      localName: tag.toLowerCase(),
      tagName: tag.toUpperCase(),
      parentElement: null,
      children: [],
      isConnected: false,
      hidden: false,
      style,
      _rect: { left: 0, top: 0, width: 200, height: 36, right: 200, bottom: 36 },
      _computed: { display: "flex", visibility: "visible" },
      textContent: "",
      get id() {
        return attrs.get("id") || "";
      },
      set id(v) {
        attrs.set("id", String(v));
      },
      get className() {
        return [...classes].join(" ");
      },
      set className(v) {
        classes.clear();
        for (const c of String(v || "").split(/\s+/).filter(Boolean)) classes.add(c);
      },
      classList: {
        add(...cs) {
          for (const c of cs) classes.add(c);
        },
        remove(...cs) {
          for (const c of cs) classes.delete(c);
        },
        contains(c) {
          return classes.has(c);
        },
        toggle(c, force) {
          const next = force === undefined ? !classes.has(c) : Boolean(force);
          if (next) classes.add(c);
          else classes.delete(c);
          return next;
        },
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      toggleAttribute(k, force) {
        const next = force === undefined ? !attrs.has(k) : Boolean(force);
        if (next) attrs.set(k, "");
        else attrs.delete(k);
        return next;
      },
      appendChild(child) {
        if (child.parentElement) {
          const idx = child.parentElement.children.indexOf(child);
          if (idx !== -1) child.parentElement.children.splice(idx, 1);
        }
        child.parentElement = el;
        el.children.push(child);
        const setConn = (node, val) => {
          node.isConnected = val;
          for (const c of node.children) setConn(c, val);
        };
        setConn(child, el.isConnected);
        return child;
      },
      remove() {
        if (!el.parentElement) return;
        const idx = el.parentElement.children.indexOf(el);
        if (idx !== -1) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
        el.isConnected = false;
      },
      contains(other) {
        let cur = other;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      matches(sel) {
        return matchesSelector(el, sel);
      },
      closest(sel) {
        let cur = el;
        while (cur) {
          if (matchesSelector(cur, sel)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const directOnly = String(sel).trim().startsWith(":scope >");
        const walk = (node, depth) => {
          for (const c of node.children) {
            if (matchesSelector(c, sel)) out.push(c);
            if (!directOnly || depth === 0) {
              if (!directOnly) walk(c, depth + 1);
            }
          }
        };
        walk(el, 0);
        return out;
      },
      getBoundingClientRect() {
        return { ...el._rect };
      },
      cloneNode() {
        const clone = makeEl(el.localName);
        clone.className = el.className;
        clone.textContent = el.textContent;
        return clone;
      },
      addEventListener(type, fn) {
        if (!elListeners.has(type)) elListeners.set(type, new Set());
        elListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        elListeners.get(type)?.delete(fn);
      },
    };
    return el;
  };

  const documentElement = makeEl("html");
  documentElement.isConnected = true;
  const head = makeEl("head");
  const body = makeEl("body");
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const doc = {
    documentElement,
    head,
    body,
    createElement: makeEl,
    createElementNS: (_ns, tag) => makeEl(tag),
    getElementById(id) {
      const walk = (node) => {
        if (node.id === id) return node;
        for (const c of node.children) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(documentElement);
    },
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
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

  return { doc, makeEl };
};

const makeFolder = (makeEl, { label, top, height = 36, collapsed = true, tag = "tab-group", tabCount = 2, display = "flex" }) => {
  const group = makeEl(tag);
  group.setAttribute("label", label);
  group.label = label;
  group.collapsed = collapsed;
  if (collapsed) group.setAttribute("collapsed", "true");
  group.setAttribute("data-zao-tab-count", String(tabCount));
  group._computed = {
    display,
    visibility: "visible",
    getPropertyValue: (p) => (p === "--tab-group-color" ? "rgb(59, 130, 246)" : ""),
  };
  group._rect = display === "contents"
    ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
    : { left: 8, top, width: 220, height, right: 228, bottom: top + height };

  const header = makeEl("div");
  header.classList.add("tab-group-label-container");
  const headerH = Math.min(height, 36);
  header._rect = { left: 8, top, width: 220, height: headerH, right: 228, bottom: top + headerH };

  const labelEl = makeEl("label");
  labelEl.classList.add("tab-group-label");
  labelEl.textContent = label;
  labelEl.group = group;
  labelEl.pinned = false;
  labelEl.elementIndex = Math.round(top / 36);
  header.appendChild(labelEl);

  const container = makeEl("div");
  container.classList.add("tab-group-container");
  container._rect = collapsed
    ? { left: 8, top: top + headerH, width: 220, height: 0, right: 228, bottom: top + headerH }
    : { left: 8, top: top + headerH, width: 220, height: Math.max(0, height - headerH), right: 228, bottom: top + height };

  group.appendChild(header);
  group.appendChild(container);
  group.labelContainerElement = header;
  group.labelElement = labelEl;
  group.groupContainer = container;
  if (tag === "zen-folder") group.isZenFolder = true;
  return { group, header, labelEl, container };
};

const makeTab = (makeEl, { label, top, height = 36 }) => {
  const tab = makeEl("tab");
  tab.setAttribute("label", label);
  tab._rect = { left: 8, top, width: 220, height, right: 228, bottom: top + height };
  return tab;
};

// ─── 1. Pure shift & target-index math ───────────────────────────────────────

test("computeSiblingShifts: shifts siblings symmetrically up, down, and in foreign containers", () => {
  // Dragging index 1 down to index 3 -> indices 2 and 3 move up by -40
  assert.deepEqual(
    computeSiblingShifts({ count: 5, originIndex: 1, targetIndex: 3, shiftHeight: 40 }),
    [0, 0, -40, -40, 0],
  );
  // Dragging index 3 up to index 1 -> indices 1 and 2 move down by +40
  assert.deepEqual(
    computeSiblingShifts({ count: 5, originIndex: 3, targetIndex: 1, shiftHeight: 40 }),
    [0, 40, 40, 0, 0],
  );
  // Staying at origin -> zero shifts
  assert.deepEqual(
    computeSiblingShifts({ count: 4, originIndex: 2, targetIndex: 2, shiftHeight: 36 }),
    [0, 0, 0, 0],
  );
  // Foreign container (originIndex = -1) inserting at index 1 -> items >= 1 shift down by +36
  assert.deepEqual(
    computeSiblingShifts({ count: 3, originIndex: -1, targetIndex: 1, shiftHeight: 36 }),
    [0, 36, 36],
  );
});

test("resolveTargetIndex: midpoint scanning, edge-reorder targeting, and drop-into suppression", () => {
  const items = [
    { el: { id: "a" }, midY: 18 },
    { el: { id: "dragged" }, midY: 54 },
    { el: { id: "b" }, midY: 90 },
    { el: { id: "c" }, midY: 126 },
  ];
  assert.equal(resolveTargetIndex({ items, originIndex: 1, clientY: 10 }), 0);
  assert.equal(resolveTargetIndex({ items, originIndex: 1, clientY: 50 }), 1);
  assert.equal(resolveTargetIndex({ items, originIndex: 1, clientY: 95 }), 2);
  assert.equal(resolveTargetIndex({ items, originIndex: 1, clientY: 140 }), 3);
  // Drop-into-folder settles siblings back to originIndex
  assert.equal(resolveTargetIndex({ items, originIndex: 1, clientY: 95, dropIntoTarget: true }), 1);
  // Edge-reorder before item "c" (index 3 > origin 1) -> targetIndex = 2
  assert.equal(
    resolveTargetIndex({ items, originIndex: 1, clientY: 110, edgeTarget: { el: items[3].el, before: true } }),
    2,
  );
  // Edge-reorder after item "c" (index 3 > origin 1) -> targetIndex = 3
  assert.equal(
    resolveTargetIndex({ items, originIndex: 1, clientY: 140, edgeTarget: { el: items[3].el, before: false } }),
    3,
  );
});

// ─── 2. Live drag preview, sibling shift, drop-into, edge-reorder & cleanup ──

test("folder drag preview: collapsed folder live preview, real-time sibling shift, drop-into settle, and clean drop reset", () => {
  const { doc, makeEl } = createDragDom();
  const tabContainer = makeEl("div");
  const ws = makeEl("zen-workspace");
  const strip = makeEl("div");

  const tab0 = makeTab(makeEl, { label: "Tab 0", top: 0, height: 36 });
  const f1 = makeFolder(makeEl, { label: "Work", top: 36, height: 36, collapsed: true, tabCount: 4 });
  const tab2 = makeTab(makeEl, { label: "Tab 2", top: 72, height: 36 });
  const f3 = makeFolder(makeEl, { label: "Docs", top: 108, height: 36, collapsed: true, tabCount: 3 });

  strip.appendChild(tab0);
  strip.appendChild(f1.group);
  strip.appendChild(tab2);
  strip.appendChild(f3.group);
  ws.appendChild(strip);
  tabContainer.appendChild(ws);
  doc.body.appendChild(tabContainer);

  const outsideEl = makeEl("div");
  doc.body.appendChild(outsideEl);

  let nativeStartOptions = null;
  let indicatorPlacement = null;
  const service = {
    startTabDrag(_event, _tab, options) {
      nativeStartOptions = options;
    },
    handle_dragover() {},
    clearDragOverVisuals() {},
    _placeDropIndicator(pos) {
      indicatorPlacement = pos;
    },
  };
  tabContainer.tabDragAndDrop = service;

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const win = {
    document: doc,
    MutationObserver: FakeMutationObserver,
    gBrowser: { tabContainer },
    getComputedStyle: (el) => el._computed || { display: "flex", visibility: "visible", getPropertyValue: () => "" },
    addEventListener() {},
    removeEventListener() {},
  };

  setupGroupDrag(win);
  try {
    // 1. Start dragging collapsed folder f1
    const dragData = {};
    f1.labelEl._dragData = dragData;
    service.startTabDrag({ clientY: 50 }, f1.labelEl, {});

    assert.equal(f1.group.getAttribute("data-zao-dragging-folder"), "true");
    const preview = doc.querySelector(".zao-folder-drag-preview");
    assert.ok(preview, "Floating drag preview element must be created");
    assert.equal(preview.getAttribute("data-zao-animation"), "true");
    assert.equal(preview.querySelector(".zao-folder-drag-preview-label").textContent, "Work");
    assert.equal(preview.querySelector(".zao-folder-drag-preview-count").textContent, "4");
    assert.match(preview.style.getPropertyValue("transform"), /translate3d\(8px, 36px, 0\) scale\(1\.02\)/);

    const makeDragOver = (target, clientY) => ({
      type: "dragover",
      target,
      clientY,
      dataTransfer: {
        types: ["application/x-moz-tabbrowser-tab"],
        mozGetDataAt: () => f1.labelEl,
      },
    });

    // 2. Drag down past tab2 (midY = 90) -> tab2 shifts UP by -36px
    const evDown = makeDragOver(tab2, 95);
    doc.dispatchEvent(evDown);
    service.handle_dragover(evDown);
    assert.equal(tab2.style.getPropertyValue("transform"), "translate3d(0, -36px, 0)");
    assert.equal(tab2.getAttribute("data-zao-drag-shift"), "true");
    assert.equal(tab0.style.getPropertyValue("transform"), "");
    assert.equal(f3.group.style.getPropertyValue("transform"), "");
    assert.match(preview.style.getPropertyValue("transform"), /translate3d\(8px, 81px, 0\)/);

    // 3. Hover center of f3 header (clientY = 126 -> overlap = 0.5, drop-into mode) -> siblings settle to 0
    const evInto = makeDragOver(f3.labelEl, 126);
    doc.dispatchEvent(evInto);
    assert.equal(f3.header.hasAttribute("data-zao-edge-reorder"), false);
    assert.equal(tab2.style.getPropertyValue("transform"), "");
    assert.equal(f3.group.style.getPropertyValue("transform"), "");

    // 4. Hover bottom edge of f3 header (clientY = 142 -> edge-reorder after f3) -> tab2 & f3 shift UP by -36px
    const evEdge = makeDragOver(f3.labelEl, 142);
    doc.dispatchEvent(evEdge);
    service.handle_dragover(evEdge);
    assert.equal(f3.header.hasAttribute("data-zao-edge-reorder"), true);
    assert.equal(dragData.dropElement, f3.group);
    assert.equal(dragData.dropBefore, false);
    assert.ok(indicatorPlacement, "Native drop indicator must still be placed on edge-reorder");
    assert.equal(tab2.style.getPropertyValue("transform"), "translate3d(0, -36px, 0)");
    assert.equal(f3.group.style.getPropertyValue("transform"), "translate3d(0, -36px, 0)");

    // 5. Drag UP past tab0 (clientY = 10 < midY 18) -> tab0 shifts DOWN by +36px, tab2 & f3 reset
    const evUp = makeDragOver(tab0, 10);
    doc.dispatchEvent(evUp);
    assert.equal(tab0.style.getPropertyValue("transform"), "translate3d(0, 36px, 0)");
    assert.equal(tab2.style.getPropertyValue("transform"), "");
    assert.equal(f3.group.style.getPropertyValue("transform"), "");

    // 6. dragleave to child inside tabContainer preserves shifts
    doc.dispatchEvent({ type: "dragleave", target: tab0, relatedTarget: tab2 });
    assert.equal(tab0.style.getPropertyValue("transform"), "translate3d(0, 36px, 0)");

    // 7. dragleave outside tabContainer relaxes shifts and fades preview
    doc.dispatchEvent({ type: "dragleave", target: tab0, relatedTarget: outsideEl });
    assert.equal(tab0.style.getPropertyValue("transform"), "");
    assert.equal(preview.style.getPropertyValue("opacity"), "0");

    // 8. Drop cleans up everything immediately (no stuck transforms or leftover preview)
    doc.dispatchEvent({ type: "drop" });
    assert.equal(f1.group.hasAttribute("data-zao-dragging-folder"), false);
    assert.equal(tab0.hasAttribute("data-zao-drag-shift"), false);
    assert.equal(tab2.hasAttribute("data-zao-drag-shift"), false);
    assert.equal(f3.group.hasAttribute("data-zao-drag-shift"), false);
    assert.equal(doc.querySelector(".zao-folder-drag-preview"), null);
    assert.equal(nativeStartOptions !== null, true);
  } finally {
    teardownGroupDrag(win);
    assert.equal(doc.getElementById("zao-group-drag-styles"), null);
    assert.equal(win._zaoGroupDrag, undefined);
  }
});

// ─── 3. Expanded folder + display:contents sibling + zen-folder + reduced motion ─

test("folder drag preview: expanded folder dragImageSource, display:contents sibling, zen-folder, and prefers-reduced-motion", () => {
  const { doc, makeEl } = createDragDom();
  const tabContainer = makeEl("div");
  const ws = makeEl("zen-workspace");
  const strip = makeEl("div");

  // Expanded folder (108px tall)
  const expanded = makeFolder(makeEl, { label: "Research", top: 0, height: 108, collapsed: false, tabCount: 3 });
  // display:contents sibling folder
  const contentsSibling = makeFolder(makeEl, {
    label: "NativeGroup",
    top: 108,
    height: 36,
    collapsed: true,
    display: "contents",
  });
  // Native zen-folder
  const zenFolder = makeFolder(makeEl, {
    label: "ZenFolder",
    top: 144,
    height: 36,
    collapsed: true,
    tag: "zen-folder",
  });

  strip.appendChild(expanded.group);
  strip.appendChild(contentsSibling.group);
  strip.appendChild(zenFolder.group);
  ws.appendChild(strip);
  tabContainer.appendChild(ws);
  doc.body.appendChild(tabContainer);

  let receivedDragImageSource = null;
  let capturedColorVarDuringStart = "";
  const service = {
    startTabDrag(_event, _tab, options) {
      receivedDragImageSource = options.dragImageSource || null;
      capturedColorVarDuringStart = options.dragImageSource?.style?.getPropertyValue?.("--tab-group-color") || "";
    },
    handle_dragover() {},
  };
  tabContainer.tabDragAndDrop = service;

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const win = {
    document: doc,
    MutationObserver: FakeMutationObserver,
    gBrowser: { tabContainer },
    gReduceMotion: false,
    getComputedStyle: (el) => el._computed || { display: "flex", visibility: "visible", getPropertyValue: () => "" },
    addEventListener() {},
    removeEventListener() {},
  };

  setupGroupDrag(win);
  try {
    // Expanded managed tab-group passes compact header as dragImageSource and restores CSS vars
    service.startTabDrag({ clientY: 16 }, expanded.labelEl, {});
    assert.equal(receivedDragImageSource, expanded.header, "Expanded folder uses compact header for drag image");
    assert.equal(capturedColorVarDuringStart, "rgb(59, 130, 246)");
    assert.equal(expanded.header.style.getPropertyValue("--tab-group-color"), "", "Temporary CSS var restored after nativeStart");

    // Drag down past display:contents sibling -> its child header box shifts by -108px
    doc.dispatchEvent({
      type: "dragover",
      target: zenFolder.labelEl,
      clientY: 162,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(contentsSibling.header.style.getPropertyValue("transform"), "translate3d(0, -108px, 0)");
    assert.equal(zenFolder.group.style.getPropertyValue("transform"), "translate3d(0, -108px, 0)");

    doc.dispatchEvent({ type: "dragend" });
    assert.equal(contentsSibling.header.style.getPropertyValue("transform"), "");
    assert.equal(zenFolder.group.style.getPropertyValue("transform"), "");

    // Now test zen-folder drag under prefers-reduced-motion
    win.gReduceMotion = true;
    service.startTabDrag({ clientY: 156 }, zenFolder.labelEl, {});
    const preview = doc.querySelector(".zao-folder-drag-preview");
    assert.ok(preview, "zen-folder drag also gets a live floating preview");
    assert.equal(
      preview.style.getPropertyValue("transform").includes("scale("),
      false,
      "Reduced motion omits hover scale on floating preview",
    );

    // Hovering center of expanded header (clientY=20) enters drop-into mode (siblings stay settled)
    doc.dispatchEvent({
      type: "dragover",
      target: expanded.labelEl,
      clientY: 20,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(expanded.group.style.getPropertyValue("transform"), "");

    // Hovering top edge of expanded header (clientY=3 -> overlap < 0.20) activates edge-reorder & shifts expanded down
    doc.dispatchEvent({
      type: "dragover",
      target: expanded.labelEl,
      clientY: 3,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(expanded.group.style.getPropertyValue("transform"), "translate3d(0, 36px, 0)");
    assert.equal(
      expanded.group.hasAttribute("data-zao-drag-shift"),
      false,
      "Reduced motion omits animated transition attribute while still showing live placement",
    );

    // Teardown mid-drag cleanly removes preview & transforms
    teardownGroupDrag(win);
    assert.equal(expanded.group.style.getPropertyValue("transform"), "");
    assert.equal(doc.querySelector(".zao-folder-drag-preview"), null);
    assert.equal(zenFolder.group.hasAttribute("data-zao-dragging-folder"), false);
  } finally {
    teardownGroupDrag(win);
  }
});

// ─── 4. Split-view groups and sidebar copies are never hijacked ──────────────

test("folder drag preview: ignores split-view groups and sidebar copies", () => {
  const { doc, makeEl } = createDragDom();
  const tabContainer = makeEl("div");
  const ws = makeEl("zen-workspace");
  const split = makeFolder(makeEl, { label: "Split", top: 0, height: 36 });
  split.group.setAttribute("split-view-group", "true");
  const copy = makeFolder(makeEl, { label: "Copy", top: 36, height: 36 });
  copy.group.setAttribute("drag-image", "true");
  ws.appendChild(split.group);
  ws.appendChild(copy.group);
  tabContainer.appendChild(ws);
  doc.body.appendChild(tabContainer);

  const service = { startTabDrag() {}, handle_dragover() {} };
  tabContainer.tabDragAndDrop = service;

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
    service.startTabDrag({ clientY: 12 }, split.labelEl, {});
    assert.equal(doc.querySelector(".zao-folder-drag-preview"), null);
    service.startTabDrag({ clientY: 48 }, copy.labelEl, {});
    assert.equal(doc.querySelector(".zao-folder-drag-preview"), null);
  } finally {
    teardownGroupDrag(win);
  }
});

// ─── 5. Verifier edge cases: post-nativeStart dimming, rename input, live headerRect ─

test("folder drag preview: dims only after nativeStart, ignores rename input drags, and reads live headerRect during shifts", () => {
  const { doc, makeEl } = createDragDom();
  const tabContainer = makeEl("div");
  const ws = makeEl("zen-workspace");
  const strip = makeEl("div");

  const f1 = makeFolder(makeEl, { label: "First", top: 0, height: 36, collapsed: true });
  const f2 = makeFolder(makeEl, { label: "Second", top: 36, height: 36, collapsed: true });

  // Inline rename input inside f1 header
  const renameInput = makeEl("input");
  renameInput.classList.add("zao-folder-rename-input");
  f1.header.appendChild(renameInput);

  strip.appendChild(f1.group);
  strip.appendChild(f2.group);
  ws.appendChild(strip);
  tabContainer.appendChild(ws);
  doc.body.appendChild(tabContainer);

  let dimmedDuringNativeStart = null;
  let shouldThrow = false;
  const service = {
    startTabDrag() {
      dimmedDuringNativeStart = f1.group.hasAttribute("data-zao-dragging-folder");
      if (shouldThrow) throw new Error("aborted drag");
    },
    handle_dragover() {},
  };
  tabContainer.tabDragAndDrop = service;

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  const win = {
    document: doc,
    MutationObserver: FakeMutationObserver,
    gBrowser: { tabContainer },
    getComputedStyle: (el) => el._computed || { display: "flex", visibility: "visible", getPropertyValue: () => "" },
    addEventListener() {},
    removeEventListener() {},
  };

  setupGroupDrag(win);
  try {
    // 1. Dragging text inside inline rename input must NOT start a folder drag
    service.startTabDrag({ clientY: 18 }, renameInput, {});
    assert.equal(doc.querySelector(".zao-folder-drag-preview"), null);
    assert.equal(f1.group.hasAttribute("data-zao-dragging-folder"), false);

    // 2. If nativeStart throws, activeDrag must not leak and folder must not be dimmed
    shouldThrow = true;
    assert.throws(() => service.startTabDrag({ clientY: 18 }, f1.labelEl, {}), /aborted drag/);
    assert.equal(f1.group.hasAttribute("data-zao-dragging-folder"), false);
    assert.equal(doc.querySelector(".zao-folder-drag-preview"), null);
    shouldThrow = false;

    // 3. On normal start, folder is NOT dimmed during nativeStart (full-opacity setDragImage), then dimmed after
    // Also ensure capture-phase dragstart does not prematurely dim when nativeStart exists.
    doc.dispatchEvent({ type: "dragstart", target: f1.labelEl, clientY: 18 });
    assert.equal(f1.group.hasAttribute("data-zao-dragging-folder"), false, "dragstart waits for nativeStart");
    service.startTabDrag({ clientY: 18 }, f1.labelEl, {});
    assert.equal(dimmedDuringNativeStart, false, "Folder must stay at full opacity while nativeStart captures setDragImage");
    assert.equal(f1.group.getAttribute("data-zao-dragging-folder"), "true");

    // 4. Live headerRect during active drag: simulate f2 visually shifted up to top=0
    f2.header._rect = { left: 8, top: 0, width: 220, height: 36, right: 228, bottom: 36 };
    doc.dispatchEvent({
      type: "dragover",
      target: f2.labelEl,
      clientY: 2, // top edge of live shifted rect (0..36), NOT cached unshifted rect (36..72)
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(f2.header.hasAttribute("data-zao-edge-reorder"), true, "Edge reorder uses live shifted header rect");
    assert.equal(win._zaoGroupDrag.headerRects.has(f2.header), false, "Shifted rect must not be cached in headerRects");

    doc.dispatchEvent({ type: "dragend" });
  } finally {
    teardownGroupDrag(win);
  }
});

// ─── 6. Edge auto-scroll & 650 ms auto-expand hover timer ────────────────────

test("computeEdgeScrollVelocity scales smoothly at top/bottom edges and returns 0 in center", () => {
  assert.equal(computeEdgeScrollVelocity({ clientY: 150, containerTop: 0, containerBottom: 300 }), 0);
  const topFast = computeEdgeScrollVelocity({ clientY: 0, containerTop: 0, containerBottom: 300 });
  const topSlow = computeEdgeScrollVelocity({ clientY: 32, containerTop: 0, containerBottom: 300 });
  assert.ok(topFast < 0 && topSlow < 0 && topFast < topSlow, "closer to top edge scrolls upward faster");

  const botSlow = computeEdgeScrollVelocity({ clientY: 268, containerTop: 0, containerBottom: 300 });
  const botFast = computeEdgeScrollVelocity({ clientY: 300, containerTop: 0, containerBottom: 300 });
  assert.ok(botSlow > 0 && botFast > 0 && botFast > botSlow, "closer to bottom edge scrolls downward faster");

  assert.equal(computeEdgeScrollVelocity({ clientY: NaN, containerTop: 0, containerBottom: 300 }), 0);
});

test("folder drag edge auto-scroll advances scrollTop via rAF, refreshes rects, and stops on dragend", () => {
  const { doc, makeEl } = createDragDom();
  const tabContainer = makeEl("div");
  const ws = makeEl("zen-workspace");
  const strip = makeEl("div");

  // Scrollable viewport: 0..200px visible, 600px total height
  strip.scrollTop = 0;
  strip.scrollHeight = 600;
  strip.clientHeight = 200;
  strip._rect = { left: 8, top: 0, width: 220, height: 200, right: 228, bottom: 200 };

  const f0 = makeFolder(makeEl, { label: "Source", top: 0, height: 36, collapsed: true });
  const tab1 = makeTab(makeEl, { label: "Tab 1", top: 36, height: 36 });
  const tab2 = makeTab(makeEl, { label: "Tab 2", top: 180, height: 36 });
  strip.appendChild(f0.group);
  strip.appendChild(tab1);
  strip.appendChild(tab2);
  ws.appendChild(strip);
  tabContainer.appendChild(ws);
  doc.body.appendChild(tabContainer);

  const service = { startTabDrag() {}, handle_dragover() {} };
  tabContainer.tabDragAndDrop = service;

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  let nextRafId = 1;
  const rafQueue = new Map();
  const win = {
    document: doc,
    MutationObserver: FakeMutationObserver,
    gBrowser: { tabContainer },
    getComputedStyle: (el) => el._computed || { display: "flex", visibility: "visible", getPropertyValue: () => "" },
    requestAnimationFrame: (cb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => {
      rafQueue.delete(id);
    },
    addEventListener() {},
    removeEventListener() {},
  };

  setupGroupDrag(win);
  try {
    service.startTabDrag({ clientY: 18 }, f0.labelEl, {});

    // Drag into bottom edge zone (clientY = 192 inside 0..200)
    doc.dispatchEvent({
      type: "dragover",
      target: tab2,
      clientY: 192,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(rafQueue.size, 1, "rAF loop scheduled when hovering bottom edge");

    // Simulate scrolling advancing one frame and updating visible rect positions
    const [rafId, cb] = [...rafQueue.entries()][0];
    rafQueue.delete(rafId);
    const prevScroll = strip.scrollTop;
    cb();
    assert.ok(strip.scrollTop > prevScroll, "scrollTop advances downward");
    const dy = strip.scrollTop - prevScroll;
    tab1._rect.top -= dy;
    tab1._rect.bottom -= dy;

    // Moving back to center cancels active rAF auto-scroll
    doc.dispatchEvent({
      type: "dragover",
      target: tab1,
      clientY: 100,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(rafQueue.size, 0, "moving out of edge zone cancels auto-scroll loop");

    doc.dispatchEvent({ type: "dragend" });
  } finally {
    teardownGroupDrag(win);
  }
});

test("collapsed folder auto-expands after ~650ms center hover and cancels on edge-reorder, self-hover, or leave", () => {
  const { doc, makeEl } = createDragDom();
  const tabContainer = makeEl("div");
  const ws = makeEl("zen-workspace");
  const strip = makeEl("div");

  const dragged = makeFolder(makeEl, { label: "Dragged", top: 0, height: 36, collapsed: true });
  const target = makeFolder(makeEl, { label: "Target", top: 36, height: 36, collapsed: true });
  const zenTarget = makeFolder(makeEl, { label: "Native", top: 72, height: 36, collapsed: true, tag: "zen-folder" });
  strip.appendChild(dragged.group);
  strip.appendChild(target.group);
  strip.appendChild(zenTarget.group);
  ws.appendChild(strip);
  tabContainer.appendChild(ws);
  doc.body.appendChild(tabContainer);

  const service = { startTabDrag() {}, handle_dragover() {} };
  tabContainer.tabDragAndDrop = service;

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }

  let nextTimerId = 1;
  const timers = new Map();
  const win = {
    document: doc,
    MutationObserver: FakeMutationObserver,
    gBrowser: { tabContainer },
    getComputedStyle: (el) => el._computed || { display: "flex", visibility: "visible", getPropertyValue: () => "" },
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    addEventListener() {},
    removeEventListener() {},
  };

  setupGroupDrag(win);
  try {
    assert.equal(AUTO_EXPAND_DELAY_MS, 650);
    service.startTabDrag({ clientY: 18 }, dragged.labelEl, {});

    // 1. Hovering dragged folder itself must never arm auto-expand
    doc.dispatchEvent({
      type: "dragover",
      target: dragged.labelEl,
      clientY: 18,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(timers.size, 0);

    // 2. Hovering center of collapsed target folder arms 650ms timer (and repeated dragover doesn't reset it)
    doc.dispatchEvent({
      type: "dragover",
      target: target.labelEl,
      clientY: 54,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(timers.size, 1);
    const [[firstTimerId, firstTimer]] = [...timers.entries()];
    assert.equal(firstTimer.ms, AUTO_EXPAND_DELAY_MS);

    doc.dispatchEvent({
      type: "dragover",
      target: target.labelEl,
      clientY: 55,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(timers.has(firstTimerId), true, "repeated dragover on same folder keeps existing timer");

    // 3. Moving into top edge-reorder zone (clientY = 38) cancels the timer without expanding
    doc.dispatchEvent({
      type: "dragover",
      target: target.labelEl,
      clientY: 38,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(timers.size, 0);
    assert.equal(target.group.collapsed, true);

    // 4. Re-entering center and letting 650ms elapse expands the collapsed folder cleanly
    doc.dispatchEvent({
      type: "dragover",
      target: target.labelEl,
      clientY: 54,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(timers.size, 1);
    const [[expandId, expandEntry]] = [...timers.entries()];
    timers.delete(expandId);
    expandEntry.fn();
    assert.equal(target.group.collapsed, false);
    assert.equal(target.group.hasAttribute("collapsed"), false);

    // 5. Native zen-folder also auto-expands, and dragleave cancels before timer fires
    doc.dispatchEvent({
      type: "dragover",
      target: zenTarget.labelEl,
      clientY: 90,
      dataTransfer: { types: ["application/x-moz-tabbrowser-tab"] },
    });
    assert.equal(timers.size, 1);
    doc.dispatchEvent({ type: "dragleave", target: zenTarget.labelEl, relatedTarget: strip });
    assert.equal(timers.size, 0);
    assert.equal(zenTarget.group.collapsed, true);

    doc.dispatchEvent({ type: "drop" });
  } finally {
    teardownGroupDrag(win);
  }
});
