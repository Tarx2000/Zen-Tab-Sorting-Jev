import { GROUP_SELECTOR, groupHeader, isSidebarCopy } from "./sidebar-elements.mjs";
import { activeLibrarySection, animateLibraryChanges } from "./library-sort-animation.mjs";
import { animateSortElement } from "./sort-motion.mjs";

const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const MAX_GHOSTS = 36;
const EASE_OUT_EXPO = "cubic-bezier(0.22, 1, 0.36, 1)";

const visibleRect = (win, element, allowHidden = false) => {
  if (!element?.isConnected || isSidebarCopy(element)) return null;
  const workspace = element.closest?.("zen-workspace");
  // Hidden workspace strips can retain on-screen rectangles while clipping or
  // opacity hides them. They are background moves, never visible flight origins.
  if (workspace && workspace.id !== win.gZenWorkspaces.activeWorkspace) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.top >= win.innerHeight || rect.right <= 0 || rect.left >= win.innerWidth) return null;
  const style = win.getComputedStyle(element);
  if (style.display === "none" || (!allowHidden && style.visibility === "hidden")) return null;
  const viewport = element.closest?.("arrowscrollbox")?.getBoundingClientRect();
  if (viewport && (rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.right <= viewport.left || rect.left >= viewport.right)) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: Math.min(rect.height, 44) };
};

const elementRect = (win, node, allowHidden = false) => {
  let anchor = node.matches?.(GROUP_SELECTOR) ? groupHeader(node) : node;
  let rect = visibleRect(win, anchor, allowHidden);
  let group = node.parentElement?.closest?.(GROUP_SELECTOR);
  while (!rect && group) {
    anchor = groupHeader(group);
    rect = visibleRect(win, anchor, allowHidden);
    group = group.parentElement?.closest?.(GROUP_SELECTOR);
  }
  return rect;
};

const spaceAnchor = (win, id) => {
  for (const element of win.document.querySelectorAll("toolbarbutton[zen-workspace-id]")) {
    if (element.getAttribute("zen-workspace-id") === id && visibleRect(win, element)) return element;
  }
  return win.gZenWorkspaces.workspaceElement(id)?.indicator;
};

const createFallbackIconSvg = (doc, isGroup) => {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("class", `zao-ghost-icon ${isGroup ? "zao-ghost-icon-folder" : "zao-ghost-icon-tab"}`);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = doc.createElementNS(SVG, "path");
  path.setAttribute(
    "d",
    isGroup
      ? "M1.75 4.25A1.25 1.25 0 0 1 3 3h3.1l1.4 1.5H13a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 13H3a1.25 1.25 0 0 1-1.25-1.25z"
      : "M4 2.25h5.25L12.5 5.5v8.25a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V3.25a1 1 0 0 1 1-1z M9 2.5v3.25h3.25",
  );
  svg.appendChild(path);
  return svg;
};

const createGhostIcon = (doc, entry) => {
  if (entry.image) {
    const img = doc.createElementNS(HTML, "img");
    img.className = "zao-ghost-icon";
    img.src = entry.image;
    img.alt = "";
    img.addEventListener("error", () => img.replaceWith(createFallbackIconSvg(doc, entry.isGroup)), { once: true });
    return img;
  }
  return createFallbackIconSvg(doc, entry.isGroup);
};

const captureEntryAppearance = (win, node, rect) => {
  if (!rect) return {};
  const isGroup = Boolean(node.matches?.(GROUP_SELECTOR));
  const anchor = isGroup ? groupHeader(node) : node;
  const style = win.getComputedStyle(anchor);
  const accent = isGroup ? win.getComputedStyle(node).getPropertyValue("--tab-group-color").trim() : "";
  return {
    image: !isGroup ? (node.image || "") : "",
    isGroup,
    color: style.color,
    font: style.font,
    accent,
  };
};

const animate = async (win, node, dx, dy, delay, duration, scale = 1) => {
  try {
    await animateSortElement(win, node, {
      transform: ["translate3d(0, 0, 0) scale(1)", `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`],
      opacity: [1, 0.92, 0],
      offset: [0, 0.72, 1],
    }, { duration, delay, easing: EASE_OUT_EXPO, fill: "both" });
  } finally { node.remove(); }
};

/** Native mutations plus a bounded presentation. Never clone live tab elements. */
export const animateSidebarChanges = async (win, mutate, { entries, budget = 3000 } = {}) => {
  const reducedMotion = Boolean(win.gReduceMotion || win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const librarySection = activeLibrarySection(win);
  if (librarySection) return animateLibraryChanges(win, librarySection, mutate, reducedMotion, entries);
  const explicit = Boolean(entries);
  const nodes = entries || [...win.gBrowser.tabs]
    .filter((node) => node.getAttribute("zen-workspace-id") === win.gZenWorkspaces.activeWorkspace && !isSidebarCopy(node))
    .map((node) => ({ node, label: node.getAttribute("label") || "Tab" }));

  // Read phase 1: snapshot pre-mutation geometry & styles before any DOM write.
  const before = nodes.map((entry) => {
    const rect = elementRect(win, entry.node);
    return {
      ...entry,
      rect,
      parent: entry.node.parentElement,
      workspaceId: entry.fromWorkspaceId || entry.node.getAttribute("zen-workspace-id"),
      ...captureEntryAppearance(win, entry.node, rect),
    };
  });
  const activeSpaceEl = win.gZenWorkspaces.activeWorkspaceElement;
  const existingGroups = new Set(activeSpaceEl?.querySelectorAll(GROUP_SELECTOR) || []);
  const layout = [...(activeSpaceEl?.querySelectorAll(`tab, ${GROUP_SELECTOR}`) || [])]
    .filter((node) => !isSidebarCopy(node))
    .map((node) => node.matches(GROUP_SELECTOR) ? groupHeader(node) : node)
    .map((node) => ({ node, rect: visibleRect(win, node) })).filter(({ rect }) => rect);

  const diagnostics = { startedAt: Date.now(), surface: "sidebar", reducedMotion, flyCount: 0, backgroundCount: 0, finished: false };
  win.ZenTabSortingLastAnimation = diagnostics;
  // Hide explicit moving units before an asynchronous retry can yield a paint.
  const hidden = [];
  const hide = (node) => {
    if (!node?.isConnected || hidden.includes(node)) return;
    node.setAttribute("data-zao-in-flight", "true");
    hidden.push(node);
  };
  let layer;
  const prepared = new Map();
  const ensureLayer = () => {
    if (layer) return;
    layer = win.document.createElementNS(HTML, "div");
    layer.className = "zao-sort-animation-layer";
    layer.setAttribute("data-zao-animation", "true");
    layer.setAttribute("aria-hidden", "true");
    win.document.documentElement.appendChild(layer);
  };
  const createGhost = (entry) => {
    ensureLayer();
    const ghost = win.document.createElementNS(HTML, "div");
    ghost.className = "zao-sort-ghost";
    Object.assign(ghost.style, {
      left: `${entry.rect.left}px`,
      top: `${entry.rect.top}px`,
      width: `${entry.rect.width}px`,
      height: `${Math.max(26, entry.rect.height)}px`,
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.font ? { font: entry.font } : {}),
    });
    if (entry.accent) ghost.style.setProperty("--zao-flight-accent", entry.accent);
    const label = win.document.createElementNS(HTML, "span");
    label.className = "zao-ghost-label";
    label.textContent = entry.label || entry.node.getAttribute("label") || "Tab";
    ghost.append(createGhostIcon(win.document, entry), label);
    layer.appendChild(ghost);
    return ghost;
  };
  try {
    if (!reducedMotion && explicit) {
      before.forEach(({ node }) => hide(node));
      // Keep visible stand-ins at the origins while native moves/retries run.
      for (const entry of before.filter(({ rect }) => rect).slice(0, MAX_GHOSTS)) prepared.set(entry.node, createGhost(entry));
    }
    const result = await mutate();
    if (reducedMotion || win.closed) return result;

    // Read phase 2: capture all post-mutation geometry before writing animations.
    const changed = before.filter(({ node, parent, workspaceId, toWorkspaceId }) => node.isConnected &&
      (node.parentElement !== parent || node.getAttribute("zen-workspace-id") !== workspaceId) &&
      (!toWorkspaceId || node.getAttribute("zen-workspace-id") === toWorkspaceId));
    if (!changed.length) return result;

    const movingNodes = new Set(changed.map(({ node }) => node));
    const layoutShifts = [];
    for (const { node, rect } of layout) {
      if (movingNodes.has(node) || changed.some((entry) => entry.node.contains(node))) continue;
      const after = visibleRect(win, node, true);
      if (!after || Math.abs(after.top - rect.top) + Math.abs(after.left - rect.left) < 1) continue;
      layoutShifts.push({ node, dx: rect.left - after.left, dy: rect.top - after.top });
    }

    const newGroupHeaders = [];
    for (const group of activeSpaceEl?.querySelectorAll(GROUP_SELECTOR) || []) {
      if (isSidebarCopy(group) || existingGroups.has(group)) continue;
      const header = groupHeader(group);
      if (visibleRect(win, header, true)) newGroupHeaders.push(header);
    }

    const visible = changed.filter((entry) => entry.rect).slice(0, MAX_GHOSTS);
    const plannedMoves = [];
    for (const entry of visible) {
      const targetId = entry.toWorkspaceId || entry.node.getAttribute("zen-workspace-id");
      const crossSpace = targetId !== entry.workspaceId;
      const directRect = !crossSpace && !explicit ? visibleRect(win, entry.node, true) : null;
      const target = crossSpace ? visibleRect(win, spaceAnchor(win, targetId)) : (directRect || elementRect(win, entry.node, true));
      if (!target) {
        diagnostics.backgroundCount++;
        continue;
      }
      plannedMoves.push({ entry, crossSpace, target, useFlip: Boolean(directRect) });
    }
    diagnostics.backgroundCount += changed.length - visible.length;

    const backgroundRoutes = diagnostics.backgroundCount
      ? [...new Set(changed.filter((entry) => !entry.rect).map((entry) => {
          if (!entry.toWorkspaceId) return "";
          const spaces = new Map(win.gZenWorkspaces.getWorkspaces().map((space) => [space.uuid, space.name]));
          return `${spaces.get(entry.workspaceId) || "Space"} → ${spaces.get(entry.toWorkspaceId) || "Space"}`;
        }))].filter(Boolean)
      : [];
    const backgroundAnchor = diagnostics.backgroundCount
      ? visibleRect(win, win.gZenWorkspaces.activeWorkspaceElement?.indicator)
      : null;

    // Write phase: clean up unused prepared ghosts and launch all animations cleanly.
    for (const [node, ghost] of prepared) {
      if (!changed.some((entry) => entry.node === node)) {
        ghost.remove();
        node.removeAttribute("data-zao-in-flight");
      }
    }

    const tasks = [];
    for (const shift of layoutShifts) {
      tasks.push(animateSortElement(win, shift.node, {
        transform: [`translate3d(${shift.dx}px, ${shift.dy}px, 0)`, "translate3d(0, 0, 0)"],
      }, { duration: 260, easing: EASE_OUT_EXPO, fill: "both" }));
    }
    for (const header of newGroupHeaders) {
      tasks.push(animateSortElement(win, header, {
        opacity: [0, 1],
        transform: ["translate3d(0, -6px, 0) scale(0.97)", "translate3d(0, 0, 0) scale(1)"],
      }, { duration: 240, easing: EASE_OUT_EXPO, fill: "both" }));
    }

    const flipStagger = Math.min(18, Math.round(180 / Math.max(1, plannedMoves.length)));
    const ghostDuration = Math.min(300, budget);
    const ghostStagger = Math.min(20, Math.max(0, Math.min(200, budget - ghostDuration) / Math.max(1, plannedMoves.length - 1)));

    for (const [index, move] of plannedMoves.entries()) {
      const { entry, crossSpace, target, useFlip } = move;
      if (useFlip) {
        const dx = entry.rect.left - target.left;
        const dy = entry.rect.top - target.top;
        if (Math.abs(dx) + Math.abs(dy) >= 1) {
          diagnostics.flyCount++;
          const delay = Math.min(index, 12) * flipStagger;
          tasks.push(animateSortElement(win, entry.node, {
            transform: [`translate3d(${dx}px, ${dy}px, 0)`, "translate3d(0, 0, 0)"],
          }, { duration: Math.min(280, budget), delay, easing: EASE_OUT_EXPO, fill: "both" }));
        }
        continue;
      }

      ensureLayer();
      const ghost = prepared.get(entry.node) || createGhost(entry);
      hide(entry.node);
      diagnostics.flyCount++;
      const dx = target.left + target.width / 2 - entry.rect.left - entry.rect.width / 2;
      const dy = target.top + target.height / 2 - entry.rect.top - entry.rect.height / 2;
      const delay = Math.min(index, 12) * ghostStagger;
      tasks.push(animate(win, ghost, dx, dy, delay, ghostDuration, crossSpace ? 0.25 : 0.92).finally(() => {
        entry.node.removeAttribute("data-zao-in-flight");
      }));
    }

    if (diagnostics.backgroundCount) {
      ensureLayer();
      const label = win.document.createElementNS(HTML, "div");
      label.className = "zao-sort-background";
      label.textContent = `${diagnostics.backgroundCount} weitere Elemente${backgroundRoutes.length ? `: ${backgroundRoutes.slice(0, 2).join(", ")}` : " werden einsortiert"}`;
      Object.assign(label.style, { left: `${backgroundAnchor?.left || 16}px`, top: `${backgroundAnchor?.top || 70}px` });
      label.style.maxWidth = `${Math.max(120, backgroundAnchor?.width || 240)}px`;
      layer.appendChild(label);
      tasks.push(animate(win, label, 0, -10, 0, 550));
    }

    await Promise.allSettled(tasks);
    return result;
  } finally {
    hidden.forEach((node) => node.removeAttribute("data-zao-in-flight"));
    layer?.remove();
    diagnostics.finished = true;
    diagnostics.finishedAt = Date.now();
  }
};
