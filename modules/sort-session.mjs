// One sort at a time per browser window, including all command entry points.
export const isSortRunning = (win = globalThis.window) => Boolean(win?._zaoSortSession);

export const abortSortSession = (win = globalThis.window) => {
  const session = win?._zaoSortSession;
  if (!session?.controller || session.controller.signal.aborted) return false;
  session.controller.abort();
  return true;
};

const BUTTON_SELECTOR = ".zao-organize-button, #tab-wand-button, #zao-sort-workspaces";
const GROUP_STATE_READY_TIMEOUT_MS = 3000;

const WAND_BUTTON_SELECTOR = "#tab-wand-button, .zao-organize-button:not([data-zao-library-organize]):not(#zao-sort-workspaces)";

const isWandButton = (button) => {
  if (!button) return false;
  const id = button.id || button.getAttribute?.("id") || "";
  if (id === "zao-sort-workspaces") return false;
  if (id === "tab-wand-button") return true;
  if (typeof button.matches === "function") {
    try {
      if (button.matches(".zao-organize-button:not([data-zao-library-organize]):not(#zao-sort-workspaces)")) return true;
    } catch {}
  }
  const hasOrganizeClass = Boolean(button.classList?.contains?.("zao-organize-button"));
  const isLibrary = Boolean(button.hasAttribute?.("data-zao-library-organize"));
  return hasOrganizeClass && !isLibrary;
};

const buttonMatchesSession = (button, session) => {
  const space = button.closest?.(".zen-library-space[data-uuid], zen-workspace");
  const id = space?.dataset?.uuid || space?.id;
  return Boolean(session && (session.kind === "workspaces" || !id || id === session.workspaceId));
};

export const updateSortButtonState = (button, win = globalThis.window) => {
  const session = win?._zaoSortSession;
  const busy = buttonMatchesSession(button, session);
  // Keep the primary wand clickable while busy so a second click can abort the active session.
  const canClickToAbort = Boolean(session && busy && isWandButton(button));
  button.disabled = Boolean(session) && !canClickToAbort;
  button.setAttribute("aria-busy", String(busy));
  if (canClickToAbort) {
    button.setAttribute?.("data-zao-cancellable", "true");
  } else {
    button.removeAttribute?.("data-zao-cancellable");
  }
};

const waitForGroupStateReady = (win, signal, timeoutMs = GROUP_STATE_READY_TIMEOUT_MS) => {
  const ready = win?._zaoGroupState?.ready;
  if (!ready || typeof ready.then !== "function") return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    timer?.unref?.();
    signal?.addEventListener?.("abort", done, { once: true });
    Promise.resolve(ready).then(done, done);
  });
};

export const withSortSession = async (
  kind,
  run,
  win = globalThis.window,
  { workspaceId, abortOnBusy = false } = {},
) => {
  if (!win) return { busy: true };
  if (isSortRunning(win)) {
    if (abortOnBusy) {
      abortSortSession(win);
      return { aborted: true, busy: true };
    }
    return { busy: true };
  }

  if (win._zaoDoneTimer) {
    win.clearTimeout?.(win._zaoDoneTimer);
    delete win._zaoDoneTimer;
  }

  const session = {
    kind,
    workspaceId: workspaceId || win.gZenWorkspaces?.activeWorkspace,
    controller: new AbortController(),
  };
  win._zaoSortSession = session;

  const update = () => {
    if (!win || win.closed || !win.document) return;
    for (const button of win.document.querySelectorAll(BUTTON_SELECTOR)) {
      button.removeAttribute?.("data-zao-done");
      updateSortButtonState(button, win);
    }
  };

  const abort = () => session.controller.abort();
  const onWandAbortClick = (event) => {
    if (event.type === "click" && event.button !== 0) return;
    const button = event.target?.closest?.(WAND_BUTTON_SELECTOR);
    if (!button || !buttonMatchesSession(button, session)) return;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    session.controller.abort();
  };

  win.addEventListener("beforeunload", abort, { once: true });
  win.addEventListener("unload", abort, { once: true });
  win.document?.addEventListener?.("click", onWandAbortClick, true);
  update();

  let completed = false;
  try {
    await waitForGroupStateReady(win, session.controller.signal);
    if (session.controller.signal.aborted) return { aborted: true };
    const result = await run(session.controller.signal);
    completed =
      !session.controller.signal.aborted &&
      !result?.aborted &&
      !result?.failed &&
      !result?.busy;
    return result;
  } finally {
    win.removeEventListener("beforeunload", abort);
    win.removeEventListener("unload", abort);
    win.document?.removeEventListener?.("click", onWandAbortClick, true);
    if (win._zaoSortSession === session) delete win._zaoSortSession;
    update();
    if (completed && !win.closed && win.document) {
      for (const button of win.document.querySelectorAll(BUTTON_SELECTOR)) {
        if (buttonMatchesSession(button, session)) button.setAttribute?.("data-zao-done", "true");
      }
      if (typeof win.setTimeout === "function") {
        win._zaoDoneTimer = win.setTimeout(() => {
          delete win._zaoDoneTimer;
          if (win.closed || !win.document) return;
          for (const button of win.document.querySelectorAll(BUTTON_SELECTOR)) {
            button.removeAttribute?.("data-zao-done");
          }
        }, 900);
      }
    }
  }
};
