// Shared motion primitives for Zen Tab Sorting animations.
// Runs in Firefox/Zen browser chrome and unit-test environments.

// Damped native Gecko linear() spring curves (Firefox 112+).
// SPRING_EASE: brisk physical spring with subtle ~1.8% settle overshoot.
export const SPRING_EASE =
  "linear(0, 0.012, 0.045, 0.098, 0.168, 0.251, 0.343, 0.439, 0.535, 0.627, 0.713, 0.789, 0.855, 0.909, 0.952, 0.984, 1.005, 1.016, 1.019, 1.017, 1.012, 1.007, 1.003, 1.001, 1)";

// SETTLE_EASE: critically damped zero-overshoot deceleration for layout shifts,
// opacity cross-fades, and off-screen exits.
export const SETTLE_EASE =
  "linear(0, 0.015, 0.058, 0.123, 0.205, 0.298, 0.396, 0.494, 0.588, 0.674, 0.75, 0.816, 0.87, 0.913, 0.946, 0.97, 0.986, 0.995, 0.999, 1)";

export const EASE_OUT_EXPO = "cubic-bezier(0.22, 1, 0.36, 1)";

export const prefersReducedMotion = (win = globalThis.window) =>
  Boolean(win?.gReduceMotion || win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

/** Distance-adaptive flight duration: clamp(min, 175 + sqrt(dist) * 9, max). */
export const computeFlightDuration = (distPx, { min = 210, max = 420 } = {}) => {
  const dist = Number.isFinite(distPx) ? Math.max(0, distPx) : 0;
  const raw = Math.round(175 + Math.sqrt(dist) * 9);
  return Math.max(min, Math.min(max, raw));
};

/**
 * Shared cancellation scope for sort presentations.
 * Cancels cleanly on meaningful scroll (> 4px), resize, unload, pointerdown,
 * dragstart, TabMove, TabGroupMoved, ZenWorkspaceChange, AbortSignal, or
 * reduced-motion changes.
 */
export const createPresentationScope = (
  win,
  { container = null, signal, checkActive = null, scrollThreshold = 4 } = {},
) => {
  let resolveInterrupted;
  let frame = null;
  let disposed = false;

  const interrupted = new Promise((done) => {
    resolveInterrupted = done;
  });

  const scope = {
    cancelled: false,
    interrupted,
    cancel: () => {},
    dispose: () => {},
  };

  const cancel = () => {
    if (scope.cancelled) return;
    scope.cancelled = true;
    resolveInterrupted();
  };
  scope.cancel = cancel;

  const effectiveSignal = signal !== undefined ? signal : win?._zaoSortSession?.controller?.signal;
  const eventRoot = container || win?.document || null;

  // Snapshot initial scroll offsets on known scrollers so tiny sub-4px layout
  // adjustments do not abort the choreography while real user scroll does.
  const scrollOrigins = new WeakMap();
  const recordScrollOrigin = (el) => {
    if (!el || typeof el.scrollTop !== "number") return;
    if (!scrollOrigins.has(el)) {
      scrollOrigins.set(el, { top: el.scrollTop, left: el.scrollLeft || 0 });
    }
  };
  if (container) {
    recordScrollOrigin(container);
    recordScrollOrigin(container.closest?.("arrowscrollbox"));
    try {
      for (const scroller of container.querySelectorAll?.("arrowscrollbox, .zen-library-space-body") || []) {
        recordScrollOrigin(scroller);
      }
    } catch { /* Non-DOM test containers may omit querySelectorAll. */ }
  }

  const onScroll = (event) => {
    const target = event?.target;
    if (!target || typeof target.scrollTop !== "number") {
      cancel();
      return;
    }
    const origin = scrollOrigins.get(target);
    if (!origin) {
      cancel();
      return;
    }
    if (
      Math.abs(target.scrollTop - origin.top) > scrollThreshold ||
      Math.abs((target.scrollLeft || 0) - origin.left) > scrollThreshold
    ) {
      cancel();
    }
  };

  const listeners = [];
  const listen = (target, name, handler) => {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(name, handler, { capture: true, passive: true });
    listeners.push([target, name, handler]);
  };

  listen(win, "resize", cancel);
  listen(win, "unload", cancel);
  listen(win, "TabMove", cancel);
  listen(win, "TabGroupMoved", cancel);
  listen(win, "ZenWorkspaceChange", cancel);
  listen(eventRoot, "pointerdown", cancel);
  listen(eventRoot, "dragstart", cancel);
  listen(eventRoot, "scroll", onScroll);

  if (effectiveSignal && typeof effectiveSignal.addEventListener === "function") {
    effectiveSignal.addEventListener("abort", cancel, { once: true });
  }

  const motionQuery = win?.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
  if (motionQuery && typeof motionQuery.addEventListener === "function") {
    motionQuery.addEventListener("change", cancel);
  }

  const checkFrame = () => {
    if (scope.cancelled || disposed) return;
    if (win?.closed || (typeof checkActive === "function" && !checkActive())) {
      cancel();
      return;
    }
    if (typeof win?.requestAnimationFrame === "function") {
      frame = win.requestAnimationFrame(checkFrame);
    }
  };

  if (effectiveSignal?.aborted || win?.closed || prefersReducedMotion(win)) {
    cancel();
  } else if (typeof win?.requestAnimationFrame === "function") {
    frame = win.requestAnimationFrame(checkFrame);
  }

  scope.dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel();
    if (frame != null && typeof win?.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(frame);
      frame = null;
    }
    for (const [target, name, handler] of listeners) {
      try { target.removeEventListener(name, handler, true); } catch {}
    }
    listeners.length = 0;
    try { effectiveSignal?.removeEventListener?.("abort", cancel); } catch {}
    try { motionQuery?.removeEventListener?.("change", cancel); } catch {}
  };

  return scope;
};

/**
 * Run a bounded WAAPI animation on `node`.
 * Captures the native Animation object directly from `node.animate(...)` for
 * deterministic `.finished` and `.cancel()` control, falling back to
 * `gZenUIManager.elementAnimate` only when `node.animate` is unavailable.
 */
export const animateSortElement = async (win, node, frames, options = {}, interrupted = null, signal = null) => {
  if (!node || win?.closed || signal?.aborted) return;

  let directAnimation = null;
  let fallbackControls = [];
  let timer = null;
  let onAbort = null;

  try {
    const duration = Number.isFinite(options.duration) ? options.duration : 0;
    const delay = Number.isFinite(options.delay) ? options.delay : 0;

    let finished;
    if (typeof node.animate === "function") {
      directAnimation = node.animate(frames, options);
      finished = directAnimation?.finished;
    } else {
      const helper = win?.gZenUIManager?.elementAnimate;
      if (typeof helper !== "function") return;
      const previous = new Set(node.getAnimations?.() || []);
      finished = helper.call(win.gZenUIManager, node, frames, options);
      fallbackControls = (node.getAnimations?.() || []).filter((animation) => !previous.has(animation));
    }

    const racers = [
      Promise.resolve(finished).catch(() => {}),
      new Promise((resolve) => {
        const setTimer = typeof win?.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
        timer = setTimer(resolve, Math.max(0, delay) + Math.max(0, duration) + 120);
      }),
    ];

    if (interrupted) racers.push(Promise.resolve(interrupted).catch(() => {}));
    if (signal && typeof signal.addEventListener === "function") {
      racers.push(new Promise((resolve) => {
        onAbort = () => resolve();
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", onAbort, { once: true });
      }));
    }

    await Promise.race(racers);
  } catch {
    /* Presentation failure cannot change a completed native mutation. */
  } finally {
    if (timer != null) {
      const clearTimer = typeof win?.clearTimeout === "function" ? win.clearTimeout.bind(win) : clearTimeout;
      clearTimer(timer);
    }
    if (onAbort && signal && typeof signal.removeEventListener === "function") {
      try { signal.removeEventListener("abort", onAbort); } catch {}
    }
    try { directAnimation?.cancel?.(); } catch {}
    for (const animation of fallbackControls) {
      try { animation.cancel(); } catch {}
    }
  }
};
