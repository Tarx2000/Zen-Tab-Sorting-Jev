// Header edge targeting follows Advanced Tab Groups (MIT, 12th-devs).
// See THIRD_PARTY_NOTICES.md. Native Zen owns all final moves; this module adds
// header-edge targeting, live floating folder drag preview, and GPU-accelerated
// real-time sibling shift animations matching normal tab drags.
import { groupHeader, isSidebarCopy } from "./sidebar-elements.mjs";
import { prefersReducedMotion } from "./sort-motion.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const STYLE_ID = "zao-group-drag-styles";
const ATTR_DRAGGING_FOLDER = "data-zao-dragging-folder";
const ATTR_DRAG_SHIFT = "data-zao-drag-shift";
const ATTR_EDGE_REORDER = "data-zao-edge-reorder";
const PREVIEW_CLASS = "zao-folder-drag-preview";
const TAB_DRAG_TYPES = ["application/x-moz-tabbrowser-tab", "application/x-moz-tab", "text/tab"];
const SIBLING_TAGS = new Set(["tab", "tab-group", "zen-folder", "tab-split-view-wrapper"]);

const DRAG_STYLES_CSS = `
[${ATTR_DRAG_SHIFT}="true"] {
  transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1) !important;
  will-change: transform;
}
[${ATTR_DRAGGING_FOLDER}="true"] {
  opacity: 0.32 !important;
  transition: opacity 140ms ease !important;
}
.${PREVIEW_CLASS} {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483646;
  pointer-events: none;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-radius: var(--border-radius-medium, 8px);
  background: color-mix(in srgb, var(--toolbar-bgcolor, Canvas) 92%, var(--zao-drag-accent, AccentColor) 8%);
  color: var(--toolbar-color, CanvasText);
  border: 1px solid color-mix(in srgb, var(--zao-drag-accent, AccentColor) 42%, transparent);
  box-shadow:
    0 10px 26px rgba(0, 0, 0, 0.24),
    0 2px 6px rgba(0, 0, 0, 0.14);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  will-change: transform, opacity;
  opacity: 0.96;
  transition: opacity 120ms ease;
}
.${PREVIEW_CLASS}-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}
.${PREVIEW_CLASS}-icon svg {
  width: 20px;
  height: 20px;
  display: block;
}
.${PREVIEW_CLASS}-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--zao-drag-accent, AccentColor);
  display: block;
}
.${PREVIEW_CLASS}-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${PREVIEW_CLASS}-count {
  flex: 0 0 auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, currentColor 11%, transparent);
  opacity: 0.8;
}
@media (prefers-reduced-motion: reduce) {
  [${ATTR_DRAG_SHIFT}="true"],
  [${ATTR_DRAGGING_FOLDER}="true"],
  .${PREVIEW_CLASS} {
    transition: none !important;
  }
}
`;

const tagOf = (el) => (el?.localName || el?.tagName || "").toLowerCase();

const setStyleProp = (el, prop, value, priority = "") => {
  if (!el?.style) return;
  if (typeof el.style.setProperty === "function") {
    el.style.setProperty(prop, value, priority);
  } else {
    el.style[prop] = value;
  }
};

const removeStyleProp = (el, prop) => {
  if (!el?.style) return;
  if (typeof el.style.removeProperty === "function") {
    el.style.removeProperty(prop);
  } else {
    delete el.style[prop];
  }
};

const getStyleProp = (el, prop) => {
  if (!el?.style) return "";
  if (typeof el.style.getPropertyValue === "function") {
    return el.style.getPropertyValue(prop) || "";
  }
  return el.style[prop] || "";
};

const getStylePriority = (el, prop) => {
  if (!el?.style || typeof el.style.getPropertyPriority !== "function") return "";
  return el.style.getPropertyPriority(prop) || "";
};

const createHtmlEl = (doc, tag) =>
  typeof doc.createElementNS === "function" ? doc.createElementNS(HTML_NS, tag) : doc.createElement(tag);

/**
 * Pure helper: compute per-sibling vertical translate offsets (in px) for a live folder drag.
 *
 * @param {object} params
 * @param {number} params.count        Total visible sibling items in the target container.
 * @param {number} params.originIndex  Index of the dragged folder in container, or -1 if foreign.
 * @param {number} params.targetIndex  Live drop index (0..count-1 if same container, 0..count if foreign).
 * @param {number} params.shiftHeight  Vertical shift distance in px (> 0).
 * @returns {number[]} Array of length `count` with Y offsets in px.
 */
export const computeSiblingShifts = ({ count, originIndex, targetIndex, shiftHeight }) => {
  const offsets = new Array(Math.max(0, count)).fill(0);
  if (count <= 0 || !Number.isFinite(shiftHeight) || shiftHeight <= 0) return offsets;
  if (targetIndex == null || targetIndex < 0) return offsets;

  if (originIndex >= 0 && originIndex < count) {
    const clampedTarget = Math.max(0, Math.min(count - 1, targetIndex));
    if (clampedTarget > originIndex) {
      for (let i = originIndex + 1; i <= clampedTarget; i++) {
        offsets[i] = -shiftHeight;
      }
    } else if (clampedTarget < originIndex) {
      for (let i = clampedTarget; i < originIndex; i++) {
        offsets[i] = shiftHeight;
      }
    }
  } else {
    const clampedTarget = Math.max(0, Math.min(count, targetIndex));
    for (let i = clampedTarget; i < count; i++) {
      offsets[i] = shiftHeight;
    }
  }
  return offsets;
};

/**
 * Pure helper: resolve live drop index from baseline (untransformed) sibling rects.
 *
 * @param {object} params
 * @param {Array<{el: object, midY: number}>} params.items
 * @param {number} params.originIndex
 * @param {number} params.clientY
 * @param {{el: object, before: boolean}|null} [params.edgeTarget]
 * @param {boolean} [params.dropIntoTarget]
 * @returns {number}
 */
export const resolveTargetIndex = ({
  items,
  originIndex,
  clientY,
  edgeTarget = null,
  dropIntoTarget = false,
}) => {
  if (!Array.isArray(items) || items.length === 0) return -1;
  if (dropIntoTarget) return originIndex;

  if (edgeTarget?.el) {
    const k = items.findIndex((item) => item.el === edgeTarget.el);
    if (k !== -1) {
      if (originIndex >= 0) {
        if (k === originIndex) return originIndex;
        if (edgeTarget.before) return k > originIndex ? k - 1 : k;
        return k > originIndex ? k : k + 1;
      }
      return edgeTarget.before ? k : k + 1;
    }
  }

  if (!Number.isFinite(clientY)) return originIndex;

  if (originIndex >= 0) {
    let dest = 0;
    for (let i = 0; i < items.length; i++) {
      if (i === originIndex) continue;
      if (clientY >= items[i].midY) dest++;
    }
    return Math.max(0, Math.min(items.length - 1, dest));
  }

  let dest = 0;
  for (let i = 0; i < items.length; i++) {
    if (clientY >= items[i].midY) dest++;
  }
  return Math.max(0, Math.min(items.length, dest));
};

export const setupGroupDrag = (win = globalThis.window) => {
  if (win._zaoGroupDrag) return;
  const doc = win.document;
  const headers = new Map();
  const headerRects = new Map();
  let cachedThreshold = null;
  let edgeHeader = null;
  let styleEl = null;

  // Live folder drag preview & sibling-shift session state.
  let activeDrag = null;
  let lastHandledDragEvent = null;

  const ensureStyles = () => {
    if (styleEl?.isConnected) return;
    const existing = doc.getElementById?.(STYLE_ID);
    if (existing) {
      styleEl = existing;
      return;
    }
    const host = doc.head || doc.documentElement || doc.body;
    if (!host?.appendChild) return;
    const el = createHtmlEl(doc, "style");
    el.id = STYLE_ID;
    el.textContent = DRAG_STYLES_CSS;
    host.appendChild(el);
    styleEl = el;
  };

  const managed = (group) =>
    group?.localName === "tab-group" &&
    !group.hasAttribute("split-view-group") &&
    !group.isZenFolder &&
    !isSidebarCopy(group) &&
    Boolean(group.closest("zen-workspace"));

  const isDraggableFolder = (group) => {
    if (!group || isSidebarCopy(group)) return false;
    const tag = tagOf(group);
    if (tag !== "tab-group" && tag !== "zen-folder") return false;
    if (group.hasAttribute?.("split-view-group")) return false;
    return Boolean(group.closest?.("zen-workspace"));
  };

  const resolveDraggedFolder = (candidate) => {
    if (!candidate) return null;
    if (isDraggableFolder(candidate)) return candidate;
    const isLabelHit =
      candidate.classList?.contains?.("tab-group-label") ||
      candidate.classList?.contains?.("tab-group-label-container") ||
      Boolean(candidate.closest?.(".tab-group-label-container"));
    if (!isLabelHit) return null;
    const group = candidate.group || candidate.closest?.("tab-group, zen-folder") || null;
    return isDraggableFolder(group) ? group : null;
  };

  const getHeaderRect = (header) => {
    if (!header) return null;
    const cached = headerRects.get(header);
    if (cached) return cached;
    const rect = header.getBoundingClientRect?.();
    if (rect) headerRects.set(header, rect);
    return rect || null;
  };

  const getEdgeThreshold = () => {
    if (cachedThreshold != null) return cachedThreshold;
    try {
      const services = win.Services || globalThis.Services;
      cachedThreshold = Math.min(
        0.45,
        Math.max(0.05, (services?.prefs?.getIntPref("zen.tabs.folder-dragover-threshold-percent", 20) ?? 20) / 100),
      );
    } catch {
      cachedThreshold = 0.2;
    }
    return cachedThreshold;
  };

  const isVisibleSiblingItem = (el) => {
    if (!el || isSidebarCopy(el)) return false;
    const tag = tagOf(el);
    if (!SIBLING_TAGS.has(tag)) return false;
    if (el.hidden) return false;
    if (el.hasAttribute?.("zen-empty-tab") || el.hasAttribute?.("atg-ws-hidden")) return false;
    const computed = win.getComputedStyle?.(el);
    if (computed?.display === "none" || computed?.visibility === "hidden") return false;
    return true;
  };

  const getTransformTargets = (el, isContents) => {
    if (!isContents) return [el];
    const targets = [];
    for (const child of el.children || []) {
      const computed = win.getComputedStyle?.(child);
      if (computed?.display === "none" || computed?.display === "contents") continue;
      targets.push(child);
    }
    if (targets.length === 0) {
      const header = groupHeader(el);
      if (header && header !== el) targets.push(header);
    }
    return targets;
  };

  const measureElementBounds = (el, activeShift = 0) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    const computed = win.getComputedStyle?.(el);
    if (computed?.display === "none") return null;

    let rect = el.getBoundingClientRect();
    let isContents = computed?.display === "contents";

    // display:contents tab-groups report a 0x0 box; measure their visible header + container instead.
    if (isContents || (rect.width < 2 && rect.height < 2)) {
      const header = groupHeader(el);
      const headerRect = header && header !== el ? header.getBoundingClientRect?.() : null;
      if (headerRect && headerRect.height >= 2) {
        let top = headerRect.top;
        let bottom = headerRect.bottom;
        let left = headerRect.left;
        let right = headerRect.right;
        const container = el.querySelector?.(":scope > .tab-group-container");
        if (container && !el.collapsed && !el.hasAttribute?.("collapsed")) {
          const cRect = container.getBoundingClientRect?.();
          if (cRect && cRect.height >= 2) {
            top = Math.min(top, cRect.top);
            bottom = Math.max(bottom, cRect.bottom);
            left = Math.min(left, cRect.left);
            right = Math.max(right, cRect.right);
          }
        }
        rect = {
          top,
          bottom,
          left,
          right,
          width: right - left,
          height: bottom - top,
        };
        isContents = true;
      }
    }

    if (!rect || rect.height < 2) return null;
    const top = rect.top - activeShift;
    const bottom = rect.bottom - activeShift;
    return {
      top,
      bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: bottom - top,
      midY: (top + bottom) / 2,
      isContents,
    };
  };

  const snapshotContainer = (container, draggedFolder, prevShifted) => {
    if (!container?.children) return { container, items: [], originIndex: -1 };
    const items = [];
    let originIndex = -1;
    for (const child of container.children) {
      if (!isVisibleSiblingItem(child)) continue;
      // Subtract any active shift we previously applied to recover true baseline coordinates.
      const tracked = prevShifted?.get(child);
      let activeShift = tracked?.dy || 0;
      if (!activeShift && prevShifted) {
        const header = groupHeader(child);
        activeShift = prevShifted.get(header)?.dy || 0;
      }
      const bounds = measureElementBounds(child, activeShift);
      if (!bounds) continue;
      if (child === draggedFolder) originIndex = items.length;
      items.push({ el: child, ...bounds });
    }
    return { container, items, originIndex };
  };

  const clearShiftedNodes = (shiftedNodes, { immediate = true } = {}) => {
    if (!shiftedNodes || shiftedNodes.size === 0) return;
    for (const [node, saved] of shiftedNodes) {
      if (immediate) node.removeAttribute?.(ATTR_DRAG_SHIFT);
      if (saved.prevTransform) {
        setStyleProp(node, "transform", saved.prevTransform, saved.prevPriority);
      } else {
        removeStyleProp(node, "transform");
      }
      if (!immediate) node.removeAttribute?.(ATTR_DRAG_SHIFT);
    }
    shiftedNodes.clear();
  };

  const applySiblingOffsets = (session, snapshot, offsets) => {
    const reduced = prefersReducedMotion(win);
    const nextTouched = new Set();

    for (let i = 0; i < snapshot.items.length; i++) {
      const item = snapshot.items[i];
      if (item.el === session.folder) continue;
      const dy = offsets[i] || 0;
      const targets = getTransformTargets(item.el, item.isContents);

      for (const node of targets) {
        nextTouched.add(node);
        let entry = session.shiftedNodes.get(node);
        if (!entry) {
          entry = {
            dy: 0,
            prevTransform: getStyleProp(node, "transform"),
            prevPriority: getStylePriority(node, "transform"),
          };
          session.shiftedNodes.set(node, entry);
        }
        if (!reduced) {
          node.setAttribute?.(ATTR_DRAG_SHIFT, "true");
        } else {
          node.removeAttribute?.(ATTR_DRAG_SHIFT);
        }
        if (entry.dy !== dy) {
          entry.dy = dy;
          if (dy === 0) {
            if (entry.prevTransform) {
              setStyleProp(node, "transform", entry.prevTransform, entry.prevPriority);
            } else {
              removeStyleProp(node, "transform");
            }
          } else {
            setStyleProp(node, "transform", `translate3d(0, ${Math.round(dy)}px, 0)`);
          }
        }
      }
    }

    // Reset any nodes from a previously hovered container that are no longer part of this snapshot.
    for (const [node, saved] of [...session.shiftedNodes]) {
      if (nextTouched.has(node)) continue;
      node.removeAttribute?.(ATTR_DRAG_SHIFT);
      if (saved.prevTransform) {
        setStyleProp(node, "transform", saved.prevTransform, saved.prevPriority);
      } else {
        removeStyleProp(node, "transform");
      }
      session.shiftedNodes.delete(node);
    }
  };

  const createDragPreview = (folder, headerRect) => {
    const host = doc.documentElement || doc.body;
    if (!host?.appendChild) return null;

    const preview = createHtmlEl(doc, "div");
    preview.className = PREVIEW_CLASS;
    preview.setAttribute("data-zao-animation", "true");
    preview.setAttribute("aria-hidden", "true");

    const computed = win.getComputedStyle?.(folder);
    const accent =
      computed?.getPropertyValue?.("--atg-folder-tint")?.trim() ||
      computed?.getPropertyValue?.("--tab-group-color")?.trim() ||
      "";
    if (accent) setStyleProp(preview, "--zao-drag-accent", accent);

    const width = Math.max(120, Math.round(headerRect?.width || 200));
    const height = Math.max(28, Math.round(headerRect?.height || 34));
    setStyleProp(preview, "width", `${width}px`);
    setStyleProp(preview, "height", `${height}px`);

    // Icon: clone folder SVG if available, otherwise a crisp accent dot.
    const iconWrap = createHtmlEl(doc, "span");
    iconWrap.className = `${PREVIEW_CLASS}-icon`;
    const header = groupHeader(folder);
    const svg = header?.querySelector?.(".tab-group-folder-icon > svg, svg");
    if (svg && typeof svg.cloneNode === "function") {
      try {
        iconWrap.appendChild(svg.cloneNode(true));
      } catch {
        const dot = createHtmlEl(doc, "span");
        dot.className = `${PREVIEW_CLASS}-dot`;
        iconWrap.appendChild(dot);
      }
    } else {
      const dot = createHtmlEl(doc, "span");
      dot.className = `${PREVIEW_CLASS}-dot`;
      iconWrap.appendChild(dot);
    }
    preview.appendChild(iconWrap);

    // Label
    const labelSpan = createHtmlEl(doc, "span");
    labelSpan.className = `${PREVIEW_CLASS}-label`;
    const labelText =
      (folder.label || folder.getAttribute?.("label") || header?.textContent || "")
        .replace(/\u200b/g, "")
        .trim() || "Folder";
    labelSpan.textContent = labelText;
    preview.appendChild(labelSpan);

    // Optional tab count badge
    const countAttr = folder.getAttribute?.("data-zao-tab-count");
    const tabCount = countAttr != null && countAttr !== ""
      ? Number.parseInt(countAttr, 10)
      : (folder.querySelectorAll?.("tab:not([zen-empty-tab])")?.length || 0);
    if (Number.isFinite(tabCount) && tabCount > 0) {
      const badge = createHtmlEl(doc, "span");
      badge.className = `${PREVIEW_CLASS}-count`;
      badge.textContent = String(tabCount);
      preview.appendChild(badge);
    }

    host.appendChild(preview);
    return preview;
  };

  const positionDragPreview = (session, clientY) => {
    const preview = session?.previewEl;
    if (!preview) return;
    const x = Math.round(session.anchorLeft);
    const y = Math.round(clientY - session.grabOffsetY);
    const scale = prefersReducedMotion(win) ? "" : " scale(1.02)";
    setStyleProp(preview, "transform", `translate3d(${x}px, ${y}px, 0)${scale}`);
    setStyleProp(preview, "opacity", "0.96");
  };

  const endFolderDrag = ({ immediate = true } = {}) => {
    if (!activeDrag) return;
    const session = activeDrag;
    activeDrag = null;
    lastHandledDragEvent = null;

    clearShiftedNodes(session.shiftedNodes, { immediate });
    session.folder?.removeAttribute?.(ATTR_DRAGGING_FOLDER);
    try {
      session.previewEl?.remove?.();
    } catch {}
  };

  const beginFolderDrag = (folder, event) => {
    if (!isDraggableFolder(folder)) return;
    if (activeDrag?.folder === folder) return;
    endFolderDrag({ immediate: true });
    ensureStyles();

    const header = groupHeader(folder);
    const headerRect = header?.getBoundingClientRect?.() || folder.getBoundingClientRect?.() || {
      left: 0,
      top: 0,
      width: 200,
      height: 34,
    };
    const folderBounds = measureElementBounds(folder, 0) || {
      top: headerRect.top,
      bottom: headerRect.bottom,
      left: headerRect.left,
      right: headerRect.right,
      width: headerRect.width,
      height: headerRect.height || 34,
      midY: headerRect.top + (headerRect.height || 34) / 2,
      isContents: false,
    };

    const originContainer = folder.parentElement;
    const originSnapshot = snapshotContainer(originContainer, folder, null);
    const shiftHeight = Math.max(24, Math.round(folderBounds.height || headerRect.height || 34));
    const grabOffsetY = Number.isFinite(event?.clientY)
      ? Math.max(0, Math.min(headerRect.height || 34, event.clientY - headerRect.top))
      : (headerRect.height || 34) / 2;

    const previewEl = createDragPreview(folder, headerRect);
    folder.setAttribute?.(ATTR_DRAGGING_FOLDER, "true");

    activeDrag = {
      folder,
      originContainer,
      snapshots: new Map(originContainer ? [[originContainer, originSnapshot]] : []),
      activeSnapshot: originSnapshot,
      shiftHeight,
      anchorLeft: headerRect.left || 0,
      grabOffsetY,
      previewEl,
      shiftedNodes: new Map(),
      lastTargetIndex: originSnapshot.originIndex,
      lastContainer: originContainer,
    };

    if (Number.isFinite(event?.clientY)) {
      positionDragPreview(activeDrag, event.clientY);
    }
  };

  const refreshActiveDragSnapshots = () => {
    if (!activeDrag) return;
    const refreshed = new Map();
    for (const container of activeDrag.snapshots.keys()) {
      if (!container?.isConnected) continue;
      refreshed.set(container, snapshotContainer(container, activeDrag.folder, activeDrag.shiftedNodes));
    }
    activeDrag.snapshots = refreshed;
    if (activeDrag.lastContainer && refreshed.has(activeDrag.lastContainer)) {
      activeDrag.activeSnapshot = refreshed.get(activeDrag.lastContainer);
    }
  };

  const resolveHoverContainer = (target, session) => {
    if (!target || !session) return session?.originContainer || null;
    // Never shift items inside the folder being dragged.
    if (session.folder?.contains?.(target)) return session.originContainer;

    // If hovering a direct child of the origin container (or inside one), use origin container.
    if (session.originContainer?.contains?.(target)) {
      // Check if we're actually inside a different nested folder's .tab-group-container.
      const nestedContainer = target.closest?.(".tab-group-container");
      if (
        nestedContainer &&
        nestedContainer !== session.originContainer &&
        !session.folder.contains?.(nestedContainer)
      ) {
        const parentGroup = nestedContainer.closest?.("tab-group, zen-folder");
        if (parentGroup && parentGroup !== session.folder && !parentGroup.collapsed && !parentGroup.hasAttribute?.("collapsed")) {
          // Only switch to nested container if hovering one of its inner items, not its header.
          if (!target.closest?.(".tab-group-label-container")) {
            return nestedContainer;
          }
        }
      }
      return session.originContainer;
    }

    // Hovering a sibling container (e.g. dragging a subfolder out to root workspace strip).
    const hoveredGroup = target.closest?.("tab-group, zen-folder");
    if (hoveredGroup && hoveredGroup !== session.folder && !session.folder.contains?.(hoveredGroup)) {
      return hoveredGroup.parentElement || session.originContainer;
    }
    const hoveredTab = target.closest?.("tab");
    if (hoveredTab && !session.folder.contains?.(hoveredTab)) {
      return hoveredTab.parentElement || session.originContainer;
    }
    return session.originContainer;
  };

  const updateFolderDragPreview = (event) => {
    if (!activeDrag) return;
    if (event && event === lastHandledDragEvent) return;
    if (event) lastHandledDragEvent = event;

    if (Number.isFinite(event?.clientY)) {
      positionDragPreview(activeDrag, event.clientY);
    }

    const target = event?.target;
    const container = resolveHoverContainer(target, activeDrag);
    if (!container) return;

    let snapshot = activeDrag.snapshots.get(container);
    if (!snapshot) {
      snapshot = snapshotContainer(container, activeDrag.folder, activeDrag.shiftedNodes);
      activeDrag.snapshots.set(container, snapshot);
    }
    activeDrag.activeSnapshot = snapshot;

    // Detect if hovering a sibling folder's header (either edge-reorder or drop-into).
    const hoveredHeader = target?.closest?.(".tab-group-label-container");
    const hoveredGroup = hoveredHeader?.closest?.("tab-group, zen-folder");
    let edgeTarget = null;
    let dropIntoTarget = false;

    if (
      hoveredGroup &&
      hoveredGroup !== activeDrag.folder &&
      !activeDrag.folder.contains?.(hoveredGroup) &&
      hoveredGroup.parentElement === container
    ) {
      if (hoveredHeader.hasAttribute?.(ATTR_EDGE_REORDER)) {
        const rect = getHeaderRect(hoveredHeader);
        const before = rect?.height ? event.clientY < rect.top + rect.height / 2 : true;
        edgeTarget = { el: hoveredGroup, before };
      } else if (hoveredHeader.classList?.contains?.("zen-drop-target")) {
        dropIntoTarget = true;
      }
    }

    const targetIndex = resolveTargetIndex({
      items: snapshot.items,
      originIndex: snapshot.originIndex,
      clientY: event?.clientY,
      edgeTarget,
      dropIntoTarget,
    });

    if (targetIndex === activeDrag.lastTargetIndex && container === activeDrag.lastContainer) {
      return;
    }
    activeDrag.lastTargetIndex = targetIndex;
    activeDrag.lastContainer = container;

    const offsets = computeSiblingShifts({
      count: snapshot.items.length,
      originIndex: snapshot.originIndex,
      targetIndex,
      shiftHeight: activeDrag.shiftHeight,
    });
    applySiblingOffsets(activeDrag, snapshot, offsets);
  };

  const invalidateDragCache = () => {
    headerRects.clear();
    cachedThreshold = null;
    refreshActiveDragSnapshots();
  };

  const service = win.gBrowser.tabContainer.tabDragAndDrop;
  const nativeStart = service?.startTabDrag;
  const start = function (event, tab, options = {}, ...rest) {
    invalidateDragCache();
    const draggedFolder = resolveDraggedFolder(tab);
    if (draggedFolder) {
      beginFolderDrag(draggedFolder, event);
    }

    const group = tab?.group;
    const isManagedLabel = tab?.classList?.contains("tab-group-label") && managed(group);
    const rect = isManagedLabel ? group.getBoundingClientRect?.() : null;
    const needsHeaderImage =
      isManagedLabel &&
      !options.dragImageSource &&
      (rect && (rect.width < 2 || rect.height < 2 || !group.collapsed));

    if (needsHeaderImage) {
      // Some native tab-group layouts use display:contents (0x0 group rect), and
      // expanded groups span all their child tabs. Let Zen's existing dragImageSource
      // option measure and clone the compact folder header instead, giving Zen the
      // right cursor offset with exactly one setDragImage.
      const header = group.labelContainerElement || tab;
      const properties = [
        "--tab-group-color",
        "--tab-group-color-invert",
        "--tab-group-color-pale",
        "--tab-group-line-color",
        "--atg-folder-tint",
        "--zen-folder-behind-bgcolor",
        "--zen-folder-front-bgcolor",
        "--zen-folder-stroke",
      ];
      const previous = properties.map((name) => [
        name,
        getStyleProp(header, name),
        getStylePriority(header, name),
      ]);
      const computed = win.getComputedStyle?.(group);
      if (computed) {
        for (const name of properties) {
          const val = computed.getPropertyValue(name);
          if (val) setStyleProp(header, name, val);
        }
      }
      try {
        return nativeStart.call(this, event, tab, { ...options, dragImageSource: header }, ...rest);
      } finally {
        for (const [name, value, priority] of previous) {
          if (value) setStyleProp(header, name, value, priority);
          else removeStyleProp(header, name);
        }
      }
    }
    return nativeStart.call(this, event, tab, options, ...rest);
  };
  if (nativeStart) service.startTabDrag = start;

  const nativeOver = service?.handle_dragover;
  const over = function (event, ...args) {
    const result = nativeOver.call(this, event, ...args);
    const header = event.target?.closest?.(`.tab-group-label-container[${ATTR_EDGE_REORDER}]`);
    const group = header?.closest?.("tab-group");
    if (managed(group) && !this._splitDropReady) {
      try {
        const type = [...(event.dataTransfer?.types || [])].find(
          (value) => value === "application/x-moz-tabbrowser-tab" || value === "application/x-moz-tab",
        );
        if (type) {
          const dragged = event.dataTransfer.mozGetDataAt(type, 0);
          const data = dragged?._dragData;
          const moving = dragged?.group || dragged;
          if (
            data &&
            moving !== group &&
            !moving?.contains?.(group) &&
            Boolean(dragged.pinned) === Boolean(group.labelElement?.pinned)
          ) {
            const rect = getHeaderRect(header);
            if (rect?.height) {
              const before = event.clientY < rect.top + rect.height / 2;
              // Native geometry can resolve a display:contents group to the hidden
              // placeholder instead of its header. Correct the native target and native
              // indicator together, so the displayed position is the actual drop.
              data.dropElement = group;
              data.dropBefore = before;
              data.animDropElementIndex = (group.labelElement?.elementIndex ?? 0) + (before ? 0 : 1);
              data.shouldCreateGroupOnDrop = false;
              data.shouldDropIntoCollapsedTabGroup = false;
              this.clearDragOverVisuals?.();
              this._placeDropIndicator?.({
                left: rect.left + 2,
                width: rect.width - 4,
                top: before ? rect.top : rect.bottom,
              });
              win.gBrowser.tabContainer.removeAttribute("movingtab-addToGroup");
            }
          }
        }
      } catch {
        /* Older Zen versions retain their own native targeting. */
      }
    }
    if (activeDrag) {
      // Allow re-applying after nativeOver in case Zen touched sibling transforms.
      lastHandledDragEvent = null;
      updateFolderDragPreview(event);
    }
    return result;
  };
  if (nativeOver) service.handle_dragover = over;

  const prepare = (root) => {
    const groups = root.matches?.("tab-group") ? [root] : root.querySelectorAll?.("tab-group") || [];
    for (const group of groups) {
      if (!managed(group)) continue;
      const header = group.labelContainerElement || group.querySelector(":scope > .tab-group-label-container");
      if (!header || headers.has(header)) continue;
      headers.set(header, header.classList.contains("zen-drop-target"));
      header.classList.add("zen-drop-target");
    }
  };

  const pruneNode = (root) => {
    if (!root || root.nodeType !== 1) return;
    if (headers.has(root)) {
      headers.delete(root);
      headerRects.delete(root);
    }
    const nested = root.querySelectorAll?.(".tab-group-label-container");
    if (nested) {
      for (const header of nested) {
        headers.delete(header);
        headerRects.delete(header);
      }
    }
  };

  const restore = () => {
    if (edgeHeader?.isConnected) edgeHeader.classList.add("zen-drop-target");
    edgeHeader?.removeAttribute(ATTR_EDGE_REORDER);
    edgeHeader = null;
  };

  const tabContainer = win.gBrowser.tabContainer;

  const onDragLeave = (event) => {
    if (!edgeHeader?.contains?.(event.relatedTarget)) {
      restore();
    }
    if (activeDrag) {
      const related = event.relatedTarget;
      const stillInsideStrip = Boolean(related && tabContainer?.contains?.(related));
      if (!stillInsideStrip) {
        // Pointer left the tab strip (or window): relax sibling shifts and hide preview until re-entry.
        if (activeDrag.activeSnapshot) {
          const zeros = new Array(activeDrag.activeSnapshot.items.length).fill(0);
          applySiblingOffsets(activeDrag, activeDrag.activeSnapshot, zeros);
        }
        activeDrag.lastTargetIndex = activeDrag.activeSnapshot?.originIndex ?? -1;
        if (activeDrag.previewEl) setStyleProp(activeDrag.previewEl, "opacity", "0");
      }
    }
  };

  const onDragEndOrDrop = () => {
    restore();
    endFolderDrag({ immediate: true });
    invalidateDragCache();
  };

  const onDragStart = (event) => {
    invalidateDragCache();
    const draggedFolder = resolveDraggedFolder(event?.target);
    if (draggedFolder) {
      beginFolderDrag(draggedFolder, event);
    }
  };

  const onDragOver = (event) => {
    const types = [...(event.dataTransfer?.types || [])];
    const hasTabPayload = types.some((type) => TAB_DRAG_TYPES.includes(type));
    if (!hasTabPayload && !activeDrag) return;

    const header = event.target?.closest?.(".tab-group-label-container");
    const group = header?.closest?.("tab-group");
    if (hasTabPayload) {
      if (!managed(group)) {
        restore();
      } else {
        if (edgeHeader && edgeHeader !== header) restore();
        const rect = getHeaderRect(header);
        if (rect?.height) {
          const threshold = getEdgeThreshold();
          const overlap = (event.clientY - rect.top) / rect.height;
          const count = group.childGroupsAndTabs?.length || 0;
          const edge = overlap < threshold || (overlap > 1 - threshold && (group.collapsed || count < 2));
          header.classList.toggle("zen-drop-target", !edge);
          header.toggleAttribute(ATTR_EDGE_REORDER, edge);
          edgeHeader = edge ? header : null;
        }
      }
    }

    if (activeDrag) {
      updateFolderDragPreview(event);
    }
    // No preventDefault, stopPropagation or second setDragImage: Zen decides.
  };

  const observer = new win.MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1 && !isSidebarCopy(node)) prepare(node);
      }
      for (const node of mutation.removedNodes) {
        if (node.nodeType === 1) pruneNode(node);
      }
    }
  });

  prepare(doc);
  observer.observe(tabContainer, { childList: true, subtree: true });
  doc.addEventListener("dragstart", onDragStart, true);
  doc.addEventListener("dragover", onDragOver, true);
  doc.addEventListener("dragleave", onDragLeave, true);
  doc.addEventListener("drop", onDragEndOrDrop, true);
  doc.addEventListener("dragend", onDragEndOrDrop, true);
  tabContainer.addEventListener("scroll", invalidateDragCache, { capture: true, passive: true });
  win.addEventListener("resize", invalidateDragCache, { passive: true });

  win._zaoGroupDrag = {
    headers,
    headerRects,
    observer,
    tabContainer,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDragEndOrDrop,
    invalidateDragCache,
    restore,
    endFolderDrag,
    getStyleEl: () => styleEl,
    getActiveDrag: () => activeDrag,
    service,
    nativeStart,
    start,
    nativeOver,
    over,
  };
};

export const teardownGroupDrag = (win = globalThis.window) => {
  const state = win?._zaoGroupDrag;
  if (!state) return;
  state.endFolderDrag?.({ immediate: true });
  state.restore();
  state.invalidateDragCache();
  state.observer.disconnect();
  win.document.removeEventListener("dragstart", state.onDragStart, true);
  win.document.removeEventListener("dragover", state.onDragOver, true);
  win.document.removeEventListener("dragleave", state.onDragLeave, true);
  win.document.removeEventListener("drop", state.onDragEndOrDrop, true);
  win.document.removeEventListener("dragend", state.onDragEndOrDrop, true);
  state.tabContainer?.removeEventListener("scroll", state.invalidateDragCache, true);
  win.removeEventListener("resize", state.invalidateDragCache);
  const styleEl = state.getStyleEl?.() || win.document.getElementById?.(STYLE_ID);
  try {
    styleEl?.remove?.();
  } catch {}
  for (const [header, originallyTarget] of state.headers) {
    if (!originallyTarget) header.classList.remove("zen-drop-target");
  }
  if (state.service?.startTabDrag === state.start) state.service.startTabDrag = state.nativeStart;
  if (state.service?.handle_dragover === state.over) state.service.handle_dragover = state.nativeOver;
  delete win._zaoGroupDrag;
};
