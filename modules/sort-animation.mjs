import { GROUP_SELECTOR, groupHeader, isSidebarCopy } from "./sidebar-elements.mjs";

const HTML = "http://www.w3.org/1999/xhtml";
const MAX_GHOSTS = 36;

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

const animate = async (win, node, dx, dy, delay, duration, scale = 1) => {
  let control;
  try {
    const motion = win.gZenUIManager?.motion;
    if (motion?.animate) {
      control = motion.animate(node, {
        x: [0, dx], y: [0, dy], scale: [1, scale], opacity: [0.95, 0.95, 0],
      }, { duration: duration / 1000, delay: delay / 1000, ease: [0.22, 0.7, 0.2, 1] });
      await Promise.race([
        Promise.resolve(control.finished || control),
        new Promise((resolve) => win.setTimeout(resolve, delay + duration + 150)),
      ]);
    } else {
      control = node.animate([
        { transform: "translate(0, 0) scale(1)", opacity: 0.95 },
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 },
      ], { duration, delay, easing: "cubic-bezier(.22,.7,.2,1)", fill: "both" });
      await control.finished;
    }
  } catch { /* Animation must never prevent a completed native move. */ }
  finally {
    control?.stop?.();
    control?.cancel?.();
    node.remove();
  }
};

/** Native mutations plus a bounded presentation. Never clone live tab elements. */
export const animateSidebarChanges = async (win, mutate, { entries, budget = 3000 } = {}) => {
  const reducedMotion = Boolean(win.gReduceMotion || win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const explicit = Boolean(entries);
  const nodes = entries || [...win.gBrowser.tabs]
    .filter((node) => node.getAttribute("zen-workspace-id") === win.gZenWorkspaces.activeWorkspace && !isSidebarCopy(node))
    .map((node) => ({ node, label: node.getAttribute("label") || "Tab" }));
  const before = nodes.map((entry) => ({
    ...entry, rect: elementRect(win, entry.node), parent: entry.node.parentElement,
    workspaceId: entry.fromWorkspaceId || entry.node.getAttribute("zen-workspace-id"),
  }));
  const layout = [...(win.gZenWorkspaces.activeWorkspaceElement?.querySelectorAll(`tab, ${GROUP_SELECTOR}`) || [])]
    .filter((node) => !isSidebarCopy(node))
    .map((node) => node.matches(GROUP_SELECTOR) ? groupHeader(node) : node)
    .map((node) => ({ node, rect: visibleRect(win, node) })).filter(({ rect }) => rect);
  const diagnostics = { startedAt: Date.now(), reducedMotion, flyCount: 0, backgroundCount: 0, finished: false };
  win.ZenTabSortingLastAnimation = diagnostics;
  // Hide explicit moving units before an asynchronous retry can yield a paint.
  const hidden = [];
  const hide = (node) => {
    if (!node?.isConnected || hidden.includes(node)) return;
    node.setAttribute("data-zao-in-flight", "true");
    hidden.push(node);
  };
  if (!reducedMotion && explicit) before.forEach(({ node }) => hide(node));
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
    ghost.textContent = `${entry.node.matches?.(GROUP_SELECTOR) ? "▰" : "▱"}  ${entry.label || entry.node.getAttribute("label") || "Tab"}`;
    Object.assign(ghost.style, {
      left: `${entry.rect.left}px`, top: `${entry.rect.top}px`,
      width: `${entry.rect.width}px`, height: `${Math.max(26, entry.rect.height)}px`,
    });
    layer.appendChild(ghost);
    return ghost;
  };
  try {
    if (!reducedMotion && explicit) {
      // Keep visible stand-ins at the origins while native moves/retries run.
      for (const entry of before.filter(({ rect }) => rect).slice(0, MAX_GHOSTS)) prepared.set(entry.node, createGhost(entry));
    }
    const result = await mutate();
    if (reducedMotion || win.closed) return result;
    const changed = before.filter(({ node, parent, workspaceId, toWorkspaceId }) => node.isConnected &&
      (node.parentElement !== parent || node.getAttribute("zen-workspace-id") !== workspaceId) &&
      (!toWorkspaceId || node.getAttribute("zen-workspace-id") === toWorkspaceId));
    if (!changed.length) return result;
    ensureLayer();
    for (const [node, ghost] of prepared) if (!changed.some((entry) => entry.node === node)) {
      ghost.remove();
      node.removeAttribute("data-zao-in-flight");
    }
    const tasks = [];
    const movingNodes = new Set(changed.map(({ node }) => node));
    for (const { node, rect } of layout) {
      if (movingNodes.has(node) || changed.some((entry) => entry.node.contains(node))) continue;
      const after = visibleRect(win, node, true);
      if (!after || Math.abs(after.top - rect.top) + Math.abs(after.left - rect.left) < 1) continue;
      const animation = node.animate([
        { transform: `translate(${rect.left - after.left}px, ${rect.top - after.top}px)` },
        { transform: "translate(0, 0)" },
      ], { duration: 220, easing: "cubic-bezier(.22,.7,.2,1)" });
      tasks.push(animation.finished.catch(() => {}).finally(() => animation.cancel()));
    }
    const visible = changed.filter((entry) => entry.rect).slice(0, MAX_GHOSTS);
    const duration = Math.min(240, budget);
    const stagger = Math.min(48, Math.max(0, (budget - duration) / Math.max(1, visible.length - 1)));
    for (const [index, entry] of visible.entries()) {
      const targetId = entry.toWorkspaceId || entry.node.getAttribute("zen-workspace-id");
      const crossSpace = targetId !== entry.workspaceId;
      const target = crossSpace ? visibleRect(win, spaceAnchor(win, targetId)) : elementRect(win, entry.node, true);
      if (!target) { diagnostics.backgroundCount++; continue; }
      const ghost = prepared.get(entry.node) || createGhost(entry);
      hide(entry.node);
      diagnostics.flyCount++;
      const dx = target.left + target.width / 2 - entry.rect.left - entry.rect.width / 2;
      const dy = target.top + target.height / 2 - entry.rect.top - entry.rect.height / 2;
      tasks.push(animate(win, ghost, dx, dy, index * stagger, duration, crossSpace ? 0.25 : 0.92).finally(() => {
        entry.node.removeAttribute("data-zao-in-flight");
      }));
    }
    diagnostics.backgroundCount += changed.length - visible.length;
    if (diagnostics.backgroundCount) {
      const label = win.document.createElementNS(HTML, "div");
      label.className = "zao-sort-background";
      const spaces = new Map(win.gZenWorkspaces.getWorkspaces().map((space) => [space.uuid, space.name]));
      const routes = [...new Set(changed.filter((entry) => !entry.rect).map((entry) =>
        entry.toWorkspaceId ? `${spaces.get(entry.workspaceId) || "Space"} → ${spaces.get(entry.toWorkspaceId) || "Space"}` : ""))].filter(Boolean);
      label.textContent = `${diagnostics.backgroundCount} weitere Elemente${routes.length ? `: ${routes.slice(0, 2).join(", ")}` : " werden einsortiert"}`;
      const anchor = visibleRect(win, win.gZenWorkspaces.activeWorkspaceElement?.indicator);
      Object.assign(label.style, { left: `${anchor?.left || 16}px`, top: `${anchor?.top || 70}px` });
      label.style.maxWidth = `${Math.max(120, anchor?.width || 240)}px`;
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
