// One sort at a time per browser window, including all command entry points.
export const isSortRunning = (win = globalThis.window) => Boolean(win?._zaoSortSession);

export const withSortSession = async (kind, run, win = globalThis.window) => {
  if (!win || isSortRunning(win)) return { busy: true };
  const session = { kind, controller: new AbortController() };
  win._zaoSortSession = session;
  const update = () => {
    for (const button of win.document.querySelectorAll(".zao-organize-button, #tab-wand-button, #zao-sort-workspaces")) {
      button.disabled = isSortRunning(win);
      button.setAttribute("aria-busy", String(isSortRunning(win)));
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
