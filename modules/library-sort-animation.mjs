import { GROUP_SELECTOR, groupHeader } from "./sidebar-elements.mjs";
import { animateSortElement } from "./sort-motion.mjs";

const HTML = "http://www.w3.org/1999/xhtml";
const MAX_PRESENTATIONS = 24;
export const activeLibrarySection = (win) => {
  const library = win.document.querySelector("zen-library");
  if (!library?.constructor.isLibrarySlightlyOpen || library.activeTab !== "spaces") return null;
  const section = library.querySelector("zen-library-spaces-section");
  return section?.isConnected && typeof section.refreshStripsNow === "function" &&
    typeof section.realElementFor === "function" ? section : null;
};

const libraryRows = (win, section, captureAppearance = false) => [...section.querySelectorAll(`.zen-library-space-tabs :is(tab, ${GROUP_SELECTOR})`)]
  .flatMap(copy => {
    const real = section.realElementFor(copy);
    if (!real || real.hasAttribute("zen-empty-tab")) return [];
    const node = copy.matches(GROUP_SELECTOR) ? groupHeader(copy) : copy;
    const bounds = node.getBoundingClientRect();
    const viewport = copy.closest(".zen-library-space-body")?.getBoundingClientRect();
    const visible = bounds.width > 2 && bounds.height > 2 && bounds.bottom > 0 && bounds.top < win.innerHeight &&
      bounds.right > 0 && bounds.left < win.innerWidth && (!viewport || (bounds.bottom > viewport.top &&
        bounds.top < viewport.bottom && bounds.right > viewport.left && bounds.left < viewport.right)) &&
      win.getComputedStyle(node).visibility !== "hidden";
    const row = { real, node, visible, space: copy.closest(".zen-library-space")?.dataset.uuid,
      rect: { left: bounds.left, top: bounds.top, width: bounds.width, height: Math.min(bounds.height, 44) } };
    if (captureAppearance && visible) {
      const style = win.getComputedStyle(node);
      const cardStyle = win.getComputedStyle(copy.closest(".zen-library-space"));
      row.appearance = { color: style.color, background: cardStyle.backgroundColor, font: style.font,
        label: real.label || real.getAttribute("label") || "Tab", group: copy.matches(GROUP_SELECTOR),
        image: real.image || "", accent: win.getComputedStyle(copy).getPropertyValue("--tab-group-color") };
    }
    return [row];
  });

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
const createPresentation = (win, layer, row) => {
  const ghost = win.document.createElementNS(HTML, "div");
  ghost.className = "zao-library-flight";
  const { rect, appearance } = row;
  Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
    height: `${Math.max(24, rect.height)}px`, color: appearance.color, font: appearance.font,
    backgroundColor: appearance.background });
  if (appearance.group && appearance.accent) ghost.style.setProperty("--zao-flight-accent", appearance.accent);
  const icon = win.document.createElementNS(HTML, appearance.image ? "img" : "span");
  icon.className = appearance.group ? "zao-flight-folder" : "zao-flight-tab";
  if (appearance.image) { icon.src = appearance.image; icon.alt = ""; }
  const label = win.document.createElementNS(HTML, "span");
  label.textContent = appearance.label;
  ghost.append(icon, label);
  layer.appendChild(ghost);
  return ghost;
};

const presentationScope = (win, section) => {
  let resolve, frame;
  const scope = { cancelled: false, interrupted: new Promise(done => { resolve = done; }) };
  const cancel = () => { scope.cancelled = true; resolve(); };
  const signal = win._zaoSortSession?.controller.signal;
  const motion = win.matchMedia("(prefers-reduced-motion: reduce)");
  const events = [[win, "resize"], [win, "unload"], [section, "scroll"], [section, "dragstart"], [section, "pointerdown"],
    [win, "TabMove"], [win, "TabGroupMoved"], [win, "ZenWorkspaceChange"]];
  events.forEach(([target, name]) => target.addEventListener(name, cancel, { capture: true, passive: true }));
  signal?.addEventListener("abort", cancel, { once: true });
  motion.addEventListener("change", cancel);
  const check = () => {
    if (win.closed || activeLibrarySection(win) !== section) cancel();
    if (!scope.cancelled) frame = win.requestAnimationFrame(check);
  };
  if (signal?.aborted) cancel(); else frame = win.requestAnimationFrame(check);
  scope.dispose = () => {
    cancel();
    win.cancelAnimationFrame(frame);
    events.forEach(([target, name]) => target.removeEventListener(name, cancel, true));
    signal?.removeEventListener("abort", cancel);
    motion.removeEventListener("change", cancel);
  };
  return scope;
};

export const animateLibraryChanges = async (win, section, mutate, reducedMotion, entries) => {
  const diagnostics = { startedAt: Date.now(), surface: "library", reducedMotion, flyCount: 0,
    backgroundCount: 0, entranceCount: 0, nativeRefresh: false, cancelled: false, presentationFailed: false, finished: false };
  win.ZenTabSortingLastAnimation = diagnostics;
  let before = new Map();
  try { if (!reducedMotion) before = new Map(libraryRows(win, section, true).map(row => [row.real, row])); }
  catch { diagnostics.presentationFailed = true; }
  let layer, scope;
  try {
    let result;
    try { result = await mutate(); }
    finally {
      if (!win.closed && section.isConnected) {
        try { section.refreshStripsNow(); diagnostics.nativeRefresh = true; }
        catch { /* Rebuild from surviving native data even after partial failure. */ }
      }
    }
    if (reducedMotion || win.closed || diagnostics.presentationFailed) return result;
    try {
      if (activeLibrarySection(win) !== section) return result;
      const after = libraryRows(win, section);
      const afterMap = new Map(after.map(row => [row.real, row]));
      const units = entries?.map(entry => entry.node) || after.filter(row => !row.real.matches(GROUP_SELECTOR)).map(row => row.real);
      // Atomic folder/group moves get one header flight, never a flight per child.
      const flights = units.flatMap(real => {
        const origin = before.get(real), target = afterMap.get(real);
        return origin?.visible && target?.visible && origin.space !== target.space && origin.appearance
          ? [{ real, origin, target }] : [];
      }).slice(0, MAX_PRESENTATIONS);
      const covered = real => flights.some(flight => flight.real === real || flight.real.contains(real));
      const incoming = after.filter(row => row.visible && !covered(row.real) &&
        (!before.has(row.real) || before.get(row.real).space !== row.space)).slice(0, MAX_PRESENTATIONS);
      diagnostics.backgroundCount = after.filter(row => !covered(row.real) &&
        (!before.has(row.real) || before.get(row.real).space !== row.space)).length - incoming.length;
      scope = presentationScope(win, section);
      if (scope.cancelled) return result;
      const tasks = incoming.map(row => {
        diagnostics.entranceCount++;
        return animateSortElement(win, row.node, { transform: ["translateY(4px)", "translateY(0)"], opacity: [0.65, 1] },
          { duration: 180, easing: "ease-out" }, scope.interrupted);
      });
      if (flights.length) layer = createLayer(win);
      for (const [index, flight] of flights.entries()) {
        const ghost = createPresentation(win, layer, flight.origin);
        const dx = flight.target.rect.left - flight.origin.rect.left;
        const dy = flight.target.rect.top - flight.origin.rect.top;
        const scale = Math.max(0.75, Math.min(1.25, flight.target.rect.width / flight.origin.rect.width));
        diagnostics.flyCount++;
        tasks.push(animateSortElement(win, ghost, {
          transform: ["translate(0, 0) scale(1)", `translate(${dx}px, ${dy}px) scale(${scale}, 1)`], opacity: [0.9, 0.15],
        }, { duration: 360, delay: Math.min(index, 12) * 18, easing: "cubic-bezier(.22,.8,.2,1)" }, scope.interrupted)
          .finally(() => ghost.remove()));
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
