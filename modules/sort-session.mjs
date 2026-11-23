// One sort at a time per browser window, including all command entry points.
export const isSortRunning = (win = globalThis.window) => Boolean(win?._zaoSortSession);

const BUTTON_SELECTOR = ".zao-organize-button, #tab-wand-button, #zao-sort-workspaces";

const buttonMatchesSession = (button, session) => {
  const space = button.closest?.(".zen-library-space[data-uuid], zen-workspace");
  const id = space?.dataset?.uuid || space?.id;
  return Boolean(session && (session.kind === "workspaces" || !id || id === session.workspaceId));
};

export const updateSortButtonState = (button, win = globalThis.window) => {
  const session = win?._zaoSortSession;
  const busy = buttonMatchesSession(button, session);
  button.disabled = Boolean(session);
  button.setAttribute("aria-busy", String(busy));
};

export const withSortSession = async (kind, run, win = globalThis.window, { workspaceId } = {}) => {
  if (!win || isSortRunning(win)) return { busy: true };
  if (win._zaoDoneTimer) {
    win.clearTimeout?.(win._zaoDoneTimer);
    delete win._zaoDoneTimer;
  }
  const session = { kind, workspaceId: workspaceId || win.gZenWorkspaces?.activeWorkspace, controller: new AbortController() };
  win._zaoSortSession = session;
  const update = () => {
    for (const button of win.document.querySelectorAll(BUTTON_SELECTOR)) {
      button.removeAttribute?.("data-zao-done");
      updateSortButtonState(button, win);
    }
  };
  const abort = () => session.controller.abort();
  win.addEventListener("unload", abort, { once: true });
  update();
  let completed = false;
  try {
    await win._zaoGroupState?.ready;
    if (session.controller.signal.aborted) return { aborted: true };
    const result = await run(session.controller.signal);
    completed = !session.controller.signal.aborted && !result?.aborted && !result?.busy;
    return result;
  }
  finally {
    win.removeEventListener("unload", abort);
    if (win._zaoSortSession === session) delete win._zaoSortSession;
    update();
    if (completed && !win.closed) {
      for (const button of win.document.querySelectorAll(BUTTON_SELECTOR)) {
        if (buttonMatchesSession(button, session)) button.setAttribute?.("data-zao-done", "true");
      }
      if (typeof win.setTimeout === "function") {
        win._zaoDoneTimer = win.setTimeout(() => {
          delete win._zaoDoneTimer;
          if (win.closed) return;
          for (const button of win.document.querySelectorAll(BUTTON_SELECTOR)) {
            button.removeAttribute?.("data-zao-done");
          }
        }, 900);
      }
    }
  }
};
