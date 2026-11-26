import { GROUP_SELECTOR, groupHeader, isSidebarCopy } from "./sidebar-elements.mjs";
import { activeLibrarySection, animateLibraryChanges } from "./library-sort-animation.mjs";
import {
  animateSortElement,
  computeFlightDuration,
  createPresentationScope,
  prefersReducedMotion,
  SETTLE_EASE,
  SPRING_EASE,
} from "./sort-motion.mjs";
import { showToast } from "./ui-toast.mjs";

const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const MAX_GHOSTS = 36;
const OFFSCREEN_EXIT_PX = 36;

const readBounds = (element) => {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
};

const isInActiveWorkspace = (win, element) => {
  const workspace = element.closest?.("zen-workspace");
  return !workspace || workspace.id === win.gZenWorkspaces.activeWorkspace;
};

const visibleRect = (win, element, allowHidden = false, viewport = null, winWidth = win.innerWidth, winHeight = win.innerHeight) => {
  if (!element?.isConnected || isSidebarCopy(element)) return null;
  // Hidden workspace strips can retain on-screen rectangles while clipping or
  // opacity hides them. They are background moves, never visible flight origins.
  if (!isInActiveWorkspace(win, element)) return null;
  const rect = readBounds(element);
  if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.top >= winHeight || rect.right <= 0 || rect.left >= winWidth) return null;
  const style = win.getComputedStyle(element);
  if (style.display === "none" || (!allowHidden && style.visibility === "hidden")) return null;
  if (viewport && (rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.right <= viewport.left || rect.left >= viewport.right)) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: Math.min(rect.height, 48) };
};

const elementRect = (win, node, allowHidden = false, viewport = null, winWidth = win.innerWidth, winHeight = win.innerHeight) => {
  let anchor = node.matches?.(GROUP_SELECTOR) ? groupHeader(node) : node;
  let rect = visibleRect(win, anchor, allowHidden, viewport, winWidth, winHeight);
  let group = node.parentElement?.closest?.(GROUP_SELECTOR);
  while (!rect && group) {
    anchor = groupHeader(group);
    rect = visibleRect(win, anchor, allowHidden, viewport, winWidth, winHeight);
    group = group.parentElement?.closest?.(GROUP_SELECTOR);
  }
  return rect;
};

/**
 * Unclipped layout rect for a same-space target whose node or ancestor group
 * is currently scrolled outside the sidebar viewport.
 */
const unclippedElementRect = (win, node) => {
  if (!node?.isConnected || isSidebarCopy(node) || !isInActiveWorkspace(win, node)) return null;
  let anchor = node.matches?.(GROUP_SELECTOR) ? groupHeader(node) : node;
  let group = node.parentElement?.closest?.(GROUP_SELECTOR);
  while (anchor) {
    if (anchor.isConnected) {
      const style = win.getComputedStyle(anchor);
      if (style.display !== "none") {
        const rect = readBounds(anchor);
        if (rect.width >= 2 && rect.height >= 2) return rect;
      }
    }
    if (!group) break;
    anchor = groupHeader(group);
    group = group.parentElement?.closest?.(GROUP_SELECTOR);
  }
  return null;
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
    compact: rect.width <= 52,
    color: style.color,
    font: style.font,
    borderRadius: style.borderRadius || "",
    accent,
  };
};

const collectSpaceAnchorRects = (win, winWidth, winHeight) => {
  const rects = new Map();
  for (const element of win.document.querySelectorAll("toolbarbutton[zen-workspace-id]")) {
    const id = element.getAttribute("zen-workspace-id");
    if (!id || rects.has(id)) continue;
    const rect = visibleRect(win, element, false, null, winWidth, winHeight);
    if (rect) rects.set(id, rect);
  }
  return (id) => {
    if (!id) return null;
    if (rects.has(id)) return rects.get(id);
    const indicator = win.gZenWorkspaces.workspaceElement?.(id)?.indicator;
    const rect = indicator ? visibleRect(win, indicator, false, null, winWidth, winHeight) : null;
    rects.set(id, rect);
    return rect;
  };
};

/** Native mutations plus a bounded, 3-beat presentation. Never clone live tab elements. */
export const animateSidebarChanges = async (
  win,
  mutate,
  { entries, budget = 3000, signal, onBackgroundSummary } = {},
) => {
  const reducedMotion = prefersReducedMotion(win);
  const librarySection = activeLibrarySection(win);
  if (librarySection) {
    return animateLibraryChanges(win, librarySection, mutate, reducedMotion, entries, { signal });
  }

  const explicit = Boolean(entries);
  const activeSpaceId = win.gZenWorkspaces.activeWorkspace;
  const activeSpaceEl = win.gZenWorkspaces.activeWorkspaceElement;
  const scrollbox = activeSpaceEl?.closest?.("arrowscrollbox") || activeSpaceEl?.querySelector?.("arrowscrollbox") || null;

  // Read phase 1: batch ALL pre-mutation geometry & styles before ANY DOM write.
  const winWidth1 = win.innerWidth;
  const winHeight1 = win.innerHeight;
  const viewport1 = scrollbox ? readBounds(scrollbox) : null;

  const nodes = entries || [...win.gBrowser.tabs]
    .filter((node) => node.getAttribute("zen-workspace-id") === activeSpaceId && !isSidebarCopy(node))
    .map((node) => ({ node, label: node.getAttribute("label") || "Tab" }));

  const before = nodes.map((entry) => {
    const rect = elementRect(win, entry.node, false, viewport1, winWidth1, winHeight1);
    return {
      ...entry,
      rect,
      parent: entry.node.parentElement,
      workspaceId: entry.fromWorkspaceId || entry.node.getAttribute("zen-workspace-id"),
      ...captureEntryAppearance(win, entry.node, rect),
    };
  });

  const existingGroups = new Set(activeSpaceEl?.querySelectorAll(GROUP_SELECTOR) || []);
  const layout = [...(activeSpaceEl?.querySelectorAll(`tab, ${GROUP_SELECTOR}`) || [])]
    .filter((node) => !isSidebarCopy(node))
    .map((node) => (node.matches(GROUP_SELECTOR) ? groupHeader(node) : node))
    .map((node) => ({ node, rect: visibleRect(win, node, false, viewport1, winWidth1, winHeight1) }))
    .filter(({ rect }) => rect);

  const diagnostics = {
    startedAt: Date.now(),
    surface: "sidebar",
    reducedMotion,
    flyCount: 0,
    offscreenExitCount: 0,
    backgroundCount: 0,
    cancelled: false,
    finished: false,
  };
  win.ZenTabSortingLastAnimation = diagnostics;

  const hidden = new Set();
  const hide = (node) => {
    if (!node?.isConnected || hidden.has(node)) return;
    node.setAttribute("data-zao-in-flight", "true");
    hidden.add(node);
  };
  const unhide = (node) => {
    if (!node) return;
    node.removeAttribute("data-zao-in-flight");
    hidden.delete(node);
  };

  let unclippedLayer = null;
  let clippedLayer = null;
  let scope = null;
  const prepared = new Map();

  const ensureUnclippedLayer = () => {
    if (unclippedLayer) return unclippedLayer;
    unclippedLayer = win.document.createElementNS(HTML, "div");
    unclippedLayer.className = "zao-sort-animation-layer";
    unclippedLayer.setAttribute("data-zao-animation", "true");
    unclippedLayer.setAttribute("aria-hidden", "true");
    win.document.documentElement.appendChild(unclippedLayer);
    return unclippedLayer;
  };

  const ensureClippedLayer = (viewport, winW, winH) => {
    if (!viewport) return ensureUnclippedLayer();
    if (!clippedLayer) {
      clippedLayer = win.document.createElementNS(HTML, "div");
      clippedLayer.className = "zao-sort-animation-layer zao-sort-animation-layer-clipped";
      clippedLayer.setAttribute("data-zao-animation", "true");
      clippedLayer.setAttribute("aria-hidden", "true");
      win.document.documentElement.appendChild(clippedLayer);
    }
    // Clip strictly to vertical scrollbox bounds with small horizontal breathing room for shadow.
    const top = Math.max(0, Math.round(viewport.top));
    const bottom = Math.max(0, Math.round(winH - viewport.bottom));
    const left = Math.max(0, Math.round(viewport.left - 8));
    const right = Math.max(0, Math.round(winW - viewport.right - 8));
    clippedLayer.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
    return clippedLayer;
  };

  const createGhost = (entry, targetLayer) => {
    const ghost = win.document.createElementNS(HTML, "div");
    ghost.className = entry.compact ? "zao-sort-ghost zao-sort-ghost-compact" : "zao-sort-ghost";
    Object.assign(ghost.style, {
      left: `${entry.rect.left}px`,
      top: `${entry.rect.top}px`,
      width: `${entry.rect.width}px`,
      height: `${entry.rect.height}px`,
      ...(entry.color ? { color: entry.color } : {}),
      ...(entry.font ? { font: entry.font } : {}),
      ...(entry.borderRadius ? { borderRadius: entry.borderRadius } : {}),
    });
    if (entry.accent) ghost.style.setProperty("--zao-flight-accent", entry.accent);
    ghost.append(createGhostIcon(win.document, entry));
    if (!entry.compact) {
      const label = win.document.createElementNS(HTML, "span");
      label.className = "zao-ghost-label";
      label.textContent = entry.label || entry.node.getAttribute("label") || "Tab";
      ghost.append(label);
    }
    targetLayer.appendChild(ghost);
    return ghost;
  };

  const createArrivalGlow = (targetLayer, rect, accent) => {
    const glow = win.document.createElementNS(HTML, "div");
    glow.className = "zao-arrival-glow";
    Object.assign(glow.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    if (accent) glow.style.setProperty("--zao-flight-accent", accent);
    targetLayer.appendChild(glow);
    return glow;
  };

  try {
    if (!reducedMotion && explicit && !signal?.aborted) {
      before.forEach(({ node }) => hide(node));
      // Keep visible stand-ins at the origins while native moves/retries run.
      for (const entry of before.filter(({ rect }) => rect).slice(0, MAX_GHOSTS)) {
        const isCross = Boolean(entry.toWorkspaceId && entry.toWorkspaceId !== entry.workspaceId);
        const hostLayer = isCross ? ensureUnclippedLayer() : ensureClippedLayer(viewport1, winWidth1, winHeight1);
        prepared.set(entry.node, createGhost(entry, hostLayer));
      }
    }

    const result = await mutate();
    if (reducedMotion || win.closed || signal?.aborted) return result;

    // Read phase 2: batch ALL post-mutation geometry & styles before ANY DOM writes.
    const winWidth2 = win.innerWidth;
    const winHeight2 = win.innerHeight;
    const viewport2 = scrollbox?.isConnected ? readBounds(scrollbox) : null;

    const changed = before.filter(({ node, parent, workspaceId, toWorkspaceId }) => node.isConnected &&
      (node.parentElement !== parent || node.getAttribute("zen-workspace-id") !== workspaceId) &&
      (!toWorkspaceId || node.getAttribute("zen-workspace-id") === toWorkspaceId));
    if (!changed.length) return result;

    const changedSet = new Set(changed.map(({ node }) => node));
    const layoutShifts = [];
    for (const { node, rect } of layout) {
      if (changedSet.has(node) || changed.some((entry) => entry.node.contains(node))) continue;
      const after = visibleRect(win, node, true, viewport2, winWidth2, winHeight2);
      if (!after || Math.abs(after.top - rect.top) + Math.abs(after.left - rect.left) < 1) continue;
      layoutShifts.push({ node, dx: rect.left - after.left, dy: rect.top - after.top });
    }

    const newGroupHeaders = [];
    for (const group of activeSpaceEl?.querySelectorAll(GROUP_SELECTOR) || []) {
      if (isSidebarCopy(group) || existingGroups.has(group)) continue;
      const header = groupHeader(group);
      if (visibleRect(win, header, true, viewport2, winWidth2, winHeight2)) newGroupHeaders.push(header);
    }

    const getSpaceAnchorRect = collectSpaceAnchorRects(win, winWidth2, winHeight2);
    const visible = changed.filter((entry) => entry.rect).slice(0, MAX_GHOSTS);
    const plannedMoves = [];
    const headerGlowMeta = new Map();

    const clipTop = viewport2 ? viewport2.top : 0;
    const clipBottom = viewport2 ? viewport2.bottom : winHeight2;

    for (const entry of visible) {
      const targetId = entry.toWorkspaceId || entry.node.getAttribute("zen-workspace-id");
      const crossSpace = targetId !== entry.workspaceId;

      if (crossSpace) {
        const target = getSpaceAnchorRect(targetId);
        if (!target) {
          diagnostics.backgroundCount++;
          continue;
        }
        plannedMoves.push({ entry, crossSpace: true, target, landingNode: null, destHeader: null, offscreenExit: null });
        continue;
      }

      const directRect = visibleRect(win, entry.node, true, viewport2, winWidth2, winHeight2);
      const target = directRect || elementRect(win, entry.node, true, viewport2, winWidth2, winHeight2);
      if (target) {
        const destGroup = entry.node.parentElement?.closest?.(GROUP_SELECTOR) || null;
        const destHeader = destGroup ? groupHeader(destGroup) : null;
        if (destHeader && destGroup && !headerGlowMeta.has(destHeader)) {
          const headerRect = visibleRect(win, destHeader, true, viewport2, winWidth2, winHeight2);
          if (headerRect) {
            const accent = win.getComputedStyle(destGroup).getPropertyValue("--tab-group-color").trim();
            headerGlowMeta.set(destHeader, { rect: headerRect, accent, arrivalDelay: Infinity });
          }
        }
        plannedMoves.push({
          entry,
          crossSpace: false,
          target,
          landingNode: directRect ? entry.node : null,
          destHeader: destHeader && headerGlowMeta.has(destHeader) ? destHeader : null,
          offscreenExit: null,
        });
        continue;
      }

      // Smooth off-screen exit: visible tab moved into a scrolled-out destination in the same space.
      const rawTarget = unclippedElementRect(win, entry.node);
      if (rawTarget && (rawTarget.bottom <= clipTop || rawTarget.top >= clipBottom)) {
        const toTop = rawTarget.bottom <= clipTop;
        const exitTarget = {
          left: entry.rect.left,
          top: toTop ? clipTop - OFFSCREEN_EXIT_PX : clipBottom + OFFSCREEN_EXIT_PX,
          width: entry.rect.width,
          height: entry.rect.height,
        };
        plannedMoves.push({
          entry,
          crossSpace: false,
          target: exitTarget,
          landingNode: null,
          destHeader: null,
          offscreenExit: toTop ? "top" : "bottom",
        });
        continue;
      }

      diagnostics.backgroundCount++;
    }
    diagnostics.backgroundCount += changed.length - visible.length;

    let backgroundRoutes = [];
    let backgroundAnchor = null;
    if (diagnostics.backgroundCount > 0) {
      const spaceNames = new Map((win.gZenWorkspaces.getWorkspaces?.() || []).map((space) => [space.uuid, space.name]));
      backgroundRoutes = [...new Set(changed.filter((entry) => !entry.rect).map((entry) => {
        if (!entry.toWorkspaceId) return "";
        return `${spaceNames.get(entry.workspaceId) || "Space"} → ${spaceNames.get(entry.toWorkspaceId) || "Space"}`;
      }))].filter(Boolean);
      backgroundAnchor = visibleRect(win, activeSpaceEl?.indicator, false, null, winWidth2, winHeight2);
    }

    // Create presentation scope right after mutations settle so user scroll/click/abort
    // immediately cancels animations and cleans up all ghosts.
    scope = createPresentationScope(win, { container: scrollbox || activeSpaceEl || win.document, signal });
    if (scope.cancelled) {
      diagnostics.cancelled = true;
      return result;
    }

    // Write phase: clean up unused prepared ghosts and launch 3-beat choreography.
    for (const [node, ghost] of prepared) {
      if (!changedSet.has(node)) {
        ghost.remove();
        unhide(node);
      }
    }

    const tasks = [];

    // Beat 2 (lead): shift surviving siblings and reveal newly created folder headers immediately
    // so space opens ahead of incoming flights without overlap collisions.
    for (const shift of layoutShifts) {
      const shiftDuration = Math.min(budget, computeFlightDuration(Math.hypot(shift.dx, shift.dy), { min: 200, max: 300 }));
      tasks.push(animateSortElement(win, shift.node, {
        transform: [`translate3d(${shift.dx}px, ${shift.dy}px, 0)`, "translate3d(0, 0, 0)"],
      }, { duration: shiftDuration, easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal));
    }

    for (const header of newGroupHeaders) {
      tasks.push(animateSortElement(win, header, {
        opacity: [0, 1],
        transform: ["translate3d(0, -6px, 0) scale(0.97)", "translate3d(0, 0, 0) scale(1)"],
      }, { duration: Math.min(220, budget), easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal));
    }

    // Beat 1 & Beat 3: elevate moving tabs into clipped/unclipped layers and cross-fade
    // destination nodes in lockstep with ghost fade-out (eliminating 72%-100% blink).
    const baseFlightDelay = (layoutShifts.length > 0 || newGroupHeaders.length > 0) ? 28 : 0;
    const flightStagger = Math.min(20, Math.max(0, Math.min(180, budget - 260) / Math.max(1, plannedMoves.length - 1)));

    for (const [index, move] of plannedMoves.entries()) {
      const { entry, crossSpace, target, landingNode, destHeader, offscreenExit } = move;
      const hostLayer = crossSpace
        ? ensureUnclippedLayer()
        : ensureClippedLayer(viewport2, winWidth2, winHeight2);

      let ghost = prepared.get(entry.node);
      if (ghost) {
        if (ghost.parentElement !== hostLayer) hostLayer.appendChild(ghost);
      } else {
        ghost = createGhost(entry, hostLayer);
      }

      const dx = crossSpace
        ? target.left + target.width / 2 - entry.rect.left - entry.rect.width / 2
        : target.left - entry.rect.left;
      const dy = crossSpace
        ? target.top + target.height / 2 - entry.rect.top - entry.rect.height / 2
        : target.top - entry.rect.top;
      const dist = Math.hypot(dx, dy);
      const duration = Math.min(
        budget,
        computeFlightDuration(dist, offscreenExit ? { min: 190, max: 300 } : { min: 210, max: 420 }),
      );
      const delay = baseFlightDelay + Math.min(index, 12) * flightStagger;

      if (offscreenExit) {
        unhide(entry.node);
        diagnostics.offscreenExitCount++;
        diagnostics.flyCount++;
        tasks.push(
          animateSortElement(win, ghost, {
            transform: ["translate3d(0, 0, 0) scale(1)", `translate3d(${dx}px, ${dy}px, 0) scale(0.95)`],
            opacity: [1, 0.85, 0],
            offset: [0, 0.65, 1],
          }, { duration, delay, easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal)
            .finally(() => ghost.remove()),
        );
        continue;
      }

      if (crossSpace) {
        hide(entry.node);
        diagnostics.flyCount++;
        tasks.push(
          animateSortElement(win, ghost, {
            transform: ["translate3d(0, 0, 0) scale(1)", `translate3d(${dx}px, ${dy}px, 0) scale(0.28)`],
            opacity: [1, 0.92, 0],
            offset: [0, 0.72, 1],
          }, { duration, delay, easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal)
            .finally(() => {
              ghost.remove();
              unhide(entry.node);
            }),
        );
        continue;
      }

      // Same-space elevated flight with lockstep landing crossfade.
      diagnostics.flyCount++;
      const scaleX = entry.rect.width > 0 ? Math.max(0.78, Math.min(1.18, target.width / entry.rect.width)) : 1;
      const scaleY = entry.rect.height > 0 ? Math.max(0.82, Math.min(1.15, target.height / entry.rect.height)) : 1;

      if (landingNode) {
        // Start landing WAAPI with fill:"both" (opacity 0 from 0%..72%, crossfading to 1 at 100%)
        // and remove data-zao-in-flight immediately so the node is visible during the 72%-100% blend.
        const landingTask = animateSortElement(win, landingNode, {
          opacity: [0, 0, 1],
          transform: ["scale(0.97)", "scale(0.97)", "scale(1)"],
          offset: [0, 0.72, 1],
        }, { duration, delay, easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal);
        unhide(landingNode);
        tasks.push(landingTask);
      } else {
        hide(entry.node);
      }

      tasks.push(
        animateSortElement(win, ghost, {
          transform: ["translate3d(0, 0, 0) scale(1)", `translate3d(${dx}px, ${dy}px, 0) scale(${scaleX}, ${scaleY})`],
          opacity: [1, 0.92, 0],
          offset: [0, 0.72, 1],
        }, { duration, delay, easing: SPRING_EASE, fill: "both" }, scope.interrupted, signal)
          .finally(() => {
            ghost.remove();
            if (!landingNode) unhide(entry.node);
          }),
      );

      if (destHeader) {
        const meta = headerGlowMeta.get(destHeader);
        if (meta) {
          const arrivalAt = Math.max(0, Math.round(delay + duration * 0.72));
          if (arrivalAt < meta.arrivalDelay) meta.arrivalDelay = arrivalAt;
        }
      }
    }

    // Subtle 240ms composited arrival glow on destination folder headers.
    for (const meta of headerGlowMeta.values()) {
      if (!Number.isFinite(meta.arrivalDelay)) continue;
      const hostLayer = ensureClippedLayer(viewport2, winWidth2, winHeight2);
      const glow = createArrivalGlow(hostLayer, meta.rect, meta.accent);
      tasks.push(
        animateSortElement(win, glow, {
          opacity: [0, 0.95, 0],
          transform: ["scale(0.985)", "scale(1)", "scale(1.005)"],
          offset: [0, 0.35, 1],
        }, { duration: 240, delay: meta.arrivalDelay, easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal)
          .finally(() => glow.remove()),
      );
    }

    // Route background-move summary cleanly via callback or toast (>=2200ms visible).
    if (diagnostics.backgroundCount > 0) {
      const summaryMessage = `${diagnostics.backgroundCount} weitere Elemente${backgroundRoutes.length ? `: ${backgroundRoutes.slice(0, 2).join(", ")}` : " wurden einsortiert"}`;
      if (typeof onBackgroundSummary === "function") {
        try {
          onBackgroundSummary({
            count: diagnostics.backgroundCount,
            routes: backgroundRoutes,
            message: summaryMessage,
          });
        } catch {}
      } else {
        let toasted = false;
        try {
          showToast(summaryMessage, { type: "info", duration: 2600, targetWindow: win });
          toasted = true;
        } catch {}
        if (!toasted) {
          const hostLayer = ensureUnclippedLayer();
          const label = win.document.createElementNS(HTML, "div");
          label.className = "zao-sort-background";
          label.textContent = summaryMessage;
          Object.assign(label.style, {
            left: `${backgroundAnchor?.left || 16}px`,
            top: `${backgroundAnchor?.top || 70}px`,
            maxWidth: `${Math.max(140, backgroundAnchor?.width || 240)}px`,
          });
          hostLayer.appendChild(label);
          tasks.push(
            animateSortElement(win, label, {
              transform: ["translate3d(0, 6px, 0)", "translate3d(0, 0, 0)", "translate3d(0, 0, 0)", "translate3d(0, -6px, 0)"],
              opacity: [0, 1, 1, 0],
              offset: [0, 0.08, 0.86, 1],
            }, { duration: 2400, easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal)
              .finally(() => label.remove()),
          );
        }
      }
    }

    await Promise.allSettled(tasks);
    diagnostics.cancelled = Boolean(scope?.cancelled);
    return result;
  } finally {
    scope?.dispose();
    for (const node of hidden) node.removeAttribute("data-zao-in-flight");
    hidden.clear();
    clippedLayer?.remove();
    unclippedLayer?.remove();
    diagnostics.finished = true;
    diagnostics.finishedAt = Date.now();
  }
};
