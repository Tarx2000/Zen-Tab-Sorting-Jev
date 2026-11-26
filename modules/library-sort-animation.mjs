import { GROUP_SELECTOR, groupHeader } from "./sidebar-elements.mjs";
import {
  animateSortElement,
  computeFlightDuration,
  createPresentationScope,
  SETTLE_EASE,
  SPRING_EASE,
} from "./sort-motion.mjs";

const HTML = "http://www.w3.org/1999/xhtml";
const SVG = "http://www.w3.org/2000/svg";
const MAX_PRESENTATIONS = 24;

export const activeLibrarySection = (win) => {
  const library = win.document.querySelector("zen-library");
  if (!library?.constructor.isLibrarySlightlyOpen || library.activeTab !== "spaces") return null;
  const section = library.querySelector("zen-library-spaces-section");
  return section?.isConnected && typeof section.refreshStripsNow === "function" &&
    typeof section.realElementFor === "function" ? section : null;
};

const isTransparentColor = (color) => {
  if (!color) return true;
  const trimmed = color.trim().toLowerCase();
  return trimmed === "transparent" || trimmed === "rgba(0, 0, 0, 0)" || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(trimmed);
};

/**
 * Measure visible Library rows with zero per-tab layout thrashing:
 * `.zen-library-space-body` rects and `.zen-library-space` computed styles are
 * read ONCE per space card instead of once per tab.
 */
const libraryRows = (win, section, captureAppearance = false) => {
  const winWidth = win.innerWidth;
  const winHeight = win.innerHeight;
  const cardCache = new Map();

  const getCardInfo = (card) => {
    if (!card) return { space: undefined, viewport: null, background: "" };
    if (cardCache.has(card)) return cardCache.get(card);
    const body = card.querySelector?.(".zen-library-space-body");
    const viewport = body?.getBoundingClientRect?.() || null;
    const background = captureAppearance ? (win.getComputedStyle(card).backgroundColor || "") : "";
    const info = { space: card.dataset?.uuid, viewport, background };
    cardCache.set(card, info);
    return info;
  };

  return [...section.querySelectorAll(`.zen-library-space-tabs :is(tab, ${GROUP_SELECTOR})`)]
    .flatMap((copy) => {
      const real = section.realElementFor(copy);
      if (!real || real.hasAttribute("zen-empty-tab")) return [];
      const isGroup = copy.matches(GROUP_SELECTOR);
      const node = isGroup ? groupHeader(copy) : copy;
      const bounds = node.getBoundingClientRect();
      const card = copy.closest(".zen-library-space");
      const { space, viewport, background } = getCardInfo(card);
      const style = win.getComputedStyle(node);
      const visible = bounds.width > 2 && bounds.height > 2 && bounds.bottom > 0 && bounds.top < winHeight &&
        bounds.right > 0 && bounds.left < winWidth &&
        (!viewport || (bounds.bottom > viewport.top && bounds.top < viewport.bottom &&
          bounds.right > viewport.left && bounds.left < viewport.right)) &&
        style.visibility !== "hidden" && style.display !== "none";
      const row = {
        real,
        node,
        visible,
        space,
        rect: { left: bounds.left, top: bounds.top, width: bounds.width, height: Math.min(bounds.height, 44) },
      };
      if (captureAppearance && visible) {
        const accent = isGroup ? win.getComputedStyle(copy).getPropertyValue("--tab-group-color").trim() : "";
        row.appearance = {
          color: style.color,
          background: isTransparentColor(background) ? "" : background,
          font: style.font,
          label: real.label || real.getAttribute("label") || "Tab",
          group: isGroup,
          image: real.image || "",
          accent,
        };
      }
      return [row];
    });
};

// A layer of ordinary HTML, never cloned tab/group/browser elements. It doesn't
// hide originals or Library copies. Refreshing native strips cannot retain a
// hidden state, cancel its movement or transfer an event listener to live data.
const createLayer = (win) => {
  const layer = win.document.createElementNS(HTML, "div");
  layer.className = "zao-library-animation-layer";
  layer.setAttribute("data-zao-animation", "true");
  layer.setAttribute("aria-hidden", "true");
  win.document.documentElement.appendChild(layer);
  return layer;
};

const createFlightSvgIcon = (doc, isGroup) => {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("class", isGroup ? "zao-flight-folder" : "zao-flight-tab");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", isGroup ? "var(--zao-flight-accent, currentColor)" : "currentColor");
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

const createPresentation = (win, layer, row) => {
  const ghost = win.document.createElementNS(HTML, "div");
  ghost.className = "zao-library-flight";
  const { rect, appearance } = row;
  Object.assign(ghost.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${Math.max(24, rect.height)}px`,
    color: appearance.color,
    font: appearance.font,
  });
  // Only override frosted CSS fill when the space card has a non-transparent surface.
  if (appearance.background) {
    ghost.style.backgroundColor = `color-mix(in srgb, ${appearance.background} 92%, var(--toolbar-bgcolor, Canvas))`;
  }
  if (appearance.group && appearance.accent) ghost.style.setProperty("--zao-flight-accent", appearance.accent);

  let icon;
  if (appearance.image) {
    icon = win.document.createElementNS(HTML, "img");
    icon.className = appearance.group ? "zao-flight-folder" : "zao-flight-tab";
    icon.src = appearance.image;
    icon.alt = "";
    icon.addEventListener("error", () => icon.replaceWith(createFlightSvgIcon(win.document, appearance.group)), { once: true });
  } else {
    icon = createFlightSvgIcon(win.document, appearance.group);
  }
  const label = win.document.createElementNS(HTML, "span");
  label.textContent = appearance.label;
  ghost.append(icon, label);
  layer.appendChild(ghost);
  return ghost;
};

export const animateLibraryChanges = async (win, section, mutate, reducedMotion, entries, { signal } = {}) => {
  const diagnostics = {
    startedAt: Date.now(),
    surface: "library",
    reducedMotion,
    flyCount: 0,
    flipCount: 0,
    backgroundCount: 0,
    entranceCount: 0,
    nativeRefresh: false,
    cancelled: false,
    presentationFailed: false,
    finished: false,
  };
  win.ZenTabSortingLastAnimation = diagnostics;

  let before = new Map();
  try {
    if (!reducedMotion) before = new Map(libraryRows(win, section, true).map((row) => [row.real, row]));
  } catch {
    diagnostics.presentationFailed = true;
  }

  let layer = null;
  let scope = null;
  let refreshedOnce = false;

  const refreshStripsOnce = () => {
    if (refreshedOnce || win.closed || !section.isConnected) return;
    refreshedOnce = true;
    try {
      section.refreshStripsNow();
      diagnostics.nativeRefresh = true;
    } catch {
      /* Rebuild from surviving native data even after partial failure. */
    }
  };

  try {
    let result;
    try {
      result = await mutate();
    } finally {
      refreshStripsOnce();
    }

    if (reducedMotion || win.closed || signal?.aborted || diagnostics.presentationFailed) return result;

    try {
      if (activeLibrarySection(win) !== section) return result;
      const after = libraryRows(win, section);
      const afterMap = new Map(after.map((row) => [row.real, row]));
      const units = entries?.map((entry) => entry.node) ||
        after.filter((row) => !row.real.matches(GROUP_SELECTOR)).map((row) => row.real);

      // Atomic folder/group moves get one header flight, never a flight per child.
      const flights = units.flatMap((real) => {
        const origin = before.get(real);
        const target = afterMap.get(real);
        return origin?.visible && target?.visible && origin.space !== target.space && origin.appearance
          ? [{ real, origin, target }]
          : [];
      }).slice(0, MAX_PRESENTATIONS);

      const covered = (real) => flights.some((flight) => flight.real === real || flight.real.contains(real));

      // Intra-space FLIP animations when rows stay in the same Library card but shift position.
      const intraSpaceFlips = after.flatMap((row) => {
        if (!row.visible || covered(row.real)) return [];
        const origin = before.get(row.real);
        if (!origin?.visible || origin.space !== row.space) return [];
        const dx = origin.rect.left - row.rect.left;
        const dy = origin.rect.top - row.rect.top;
        if (Math.abs(dx) + Math.abs(dy) < 1) return [];
        return [{ row, dx, dy }];
      }).slice(0, MAX_PRESENTATIONS);

      const incoming = after.filter((row) => row.visible && !covered(row.real) &&
        (!before.has(row.real) || before.get(row.real).space !== row.space)).slice(0, MAX_PRESENTATIONS);
      diagnostics.backgroundCount = after.filter((row) => !covered(row.real) &&
        (!before.has(row.real) || before.get(row.real).space !== row.space)).length - incoming.length;

      scope = createPresentationScope(win, {
        container: section,
        signal,
        checkActive: () => activeLibrarySection(win) === section,
        scrollThreshold: 0,
      });
      if (scope.cancelled) {
        diagnostics.cancelled = true;
        return result;
      }

      const tasks = [];

      for (const { row, dx, dy } of intraSpaceFlips) {
        diagnostics.flipCount++;
        const duration = computeFlightDuration(Math.hypot(dx, dy), { min: 200, max: 340 });
        tasks.push(animateSortElement(win, row.node, {
          transform: [`translate3d(${dx}px, ${dy}px, 0)`, "translate3d(0, 0, 0)"],
        }, { duration, easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal));
      }

      for (const row of incoming) {
        diagnostics.entranceCount++;
        tasks.push(animateSortElement(win, row.node, {
          transform: ["translate3d(0, 4px, 0)", "translate3d(0, 0, 0)"],
          opacity: [0.65, 1],
        }, { duration: 190, easing: SETTLE_EASE }, scope.interrupted, signal));
      }

      if (flights.length) layer = createLayer(win);
      for (const [index, flight] of flights.entries()) {
        const ghost = createPresentation(win, layer, flight.origin);
        const dx = flight.target.rect.left - flight.origin.rect.left;
        const dy = flight.target.rect.top - flight.origin.rect.top;
        const scale = Math.max(0.75, Math.min(1.25, flight.target.rect.width / flight.origin.rect.width));
        const duration = computeFlightDuration(Math.hypot(dx, dy), { min: 220, max: 400 });
        const delay = Math.min(index, 10) * 16;
        diagnostics.flyCount++;
        tasks.push(animateSortElement(win, ghost, {
          transform: ["translate3d(0, 0, 0) scale(1)", `translate3d(${dx}px, ${dy}px, 0) scale(${scale}, 1)`],
          opacity: [0.96, 0.96, 0],
          offset: [0, 0.72, 1],
        }, { duration, delay, easing: SPRING_EASE, fill: "both" }, scope.interrupted, signal)
          .finally(() => ghost.remove()));
        tasks.push(animateSortElement(win, flight.target.node, {
          opacity: [0, 0, 1],
          transform: ["scale(0.97)", "scale(0.97)", "scale(1)"],
          offset: [0, 0.72, 1],
        }, { duration, delay, easing: SETTLE_EASE, fill: "both" }, scope.interrupted, signal));
      }

      await Promise.allSettled(tasks);
      diagnostics.cancelled = scope.cancelled;
      return result;
    } catch {
      // Never replay mutate() to recover a presentation error. Native data is
      // already committed; finish successfully without a visual effect.
      diagnostics.presentationFailed = true;
      return result;
    }
  } finally {
    scope?.dispose();
    layer?.remove();
    diagnostics.finished = true;
    diagnostics.finishedAt = Date.now();
  }
};
