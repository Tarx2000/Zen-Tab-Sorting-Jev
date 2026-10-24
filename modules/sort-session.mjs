// One sort at a time per browser window, including all command entry points.
export const isSortRunning = (win = globalThis.window) => Boolean(win?._zaoSortSession);

export const updateSortButtonState = (button, win = globalThis.window) => {
  const session = win?._zaoSortSession;
  const space = button.closest?.(".zen-library-space[data-uuid], zen-workspace");
  const id = space?.dataset?.uuid || space?.id;
  const busy = Boolean(session && (session.kind === "workspaces" || !id || id === session.workspaceId));
  button.disabled = Boolean(session);
  button.setAttribute("aria-busy", String(busy));
};

export const withSortSession = async (kind, run, win = globalThis.window, { workspaceId } = {}) => {
  if (!win || isSortRunning(win)) return { busy: true };
  const session = { kind, workspaceId: workspaceId || win.gZenWorkspaces?.activeWorkspace, controller: new AbortController() };
  win._zaoSortSession = session;
  const update = () => {
    for (const button of win.document.querySelectorAll(".zao-organize-button, #tab-wand-button, #zao-sort-workspaces")) {
      updateSortButtonState(button, win);
    }
  };
  const abort = () => session.controller.abort();
  win.addEventListener("unload", abort, { once: true });
  update();
  try {
    await win._zaoGroupState?.ready;
    if (session.controller.signal.aborted) return { aborted: true };
    return await run(session.controller.signal);
  }
  finally {
    win.removeEventListener("unload", abort);
    if (win._zaoSortSession === session) delete win._zaoSortSession;
    update();
  }
};
