import { readSkipDomainsPref } from "./rules.mjs";
import { classifyWorkspaceUnitsWithJev } from "./workspace-jev.mjs";
import {
  snapshotWorkspaceUnits,
  workspaceUnitIsUnchanged,
  workspaceUnitIsAtTarget,
  moveWorkspaceUnit,
  captureUndoSnapshot,
  restoreUndoSnapshot,
} from "./workspace-browser.mjs";
import { animateSidebarChanges } from "./sort-animation.mjs";
import { isSortRunning, withSortSession } from "./sort-session.mjs";
import { showToast } from "./ui-toast.mjs";
import { recordDebugEvent } from "./debug-journal.mjs";
import { saveGroupState } from "./group-state.mjs";
import { t } from "./i18n.mjs";

const HTML = "http://www.w3.org/1999/xhtml";

const waitAbortable = (win, ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(t("error.sortAborted", null, win)));
      return;
    }
    const onAbort = () => {
      win.clearTimeout?.(timer);
      reject(new Error(t("error.sortAborted", null, win)));
    };
    const timer = (win.setTimeout || setTimeout)(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });

const settleFrame = (win) =>
  new Promise((resolve) => {
    if (typeof win?.requestAnimationFrame === "function") {
      win.requestAnimationFrame(() => resolve());
    } else {
      resolve();
    }
  });

const showErrorReport = (win, errors) => {
  win.document.getElementById("zao-workspace-errors")?.remove();
  if (!errors.length) return;
  const element = (tag, text) => {
    const node = win.document.createElementNS(HTML, tag);
    if (text) node.textContent = text;
    return node;
  };
  const panel = element("section");
  panel.id = "zao-workspace-errors";
  panel.className = "zao-workspace-errors";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", t("workspace.errorReportAria", null, win));
  const title = element("strong", t("workspace.errorReportTitle", { count: errors.length }, win));
  const close = element("button", t("workspace.close", null, win));
  close.type = "button";
  close.addEventListener("click", () => panel.remove());
  const list = element("ul");
  for (const error of errors) list.appendChild(element("li", `${error.name}: ${error.reason}`));
  panel.append(title, close, list);
  win.document.documentElement.appendChild(panel);
};

export const undoLastWorkspaceSort = (win = globalThis.window) =>
  withSortSession("workspaces", async () => {
    const toast = (message, options = {}) => showToast(message, { ...options, targetWindow: win });
    const snapshot = win?._zaoLastWorkspaceUndo;
    if (!snapshot || !snapshot.entries?.length) {
      toast(t("toast.undoUnavailable", null, win), { type: "info" });
      return { restored: 0, failed: 0 };
    }
    delete win._zaoLastWorkspaceUndo;
    const outcome = restoreUndoSnapshot(win, snapshot);
    saveGroupState(win);
    try { win.document.querySelector("zen-library-spaces-section")?.refreshStripsNow?.(); } catch {}
    if (outcome.failed > 0) {
      toast(t("toast.undoPartial", { restored: outcome.restored, failed: outcome.failed }, win), { type: "warning" });
    } else {
      toast(t("toast.undoDone", { count: outcome.restored }, win), { type: "success" });
    }
    recordDebugEvent("SPACE-UNDO", `Restored ${outcome.restored}, failed ${outcome.failed}`);
    return outcome;
  }, win);

export const organizeWorkspaces = (win = globalThis.window) => withSortSession("workspaces", async (signal) => {
  const toast = (message, options = {}) => showToast(message, { ...options, targetWindow: win });
  const run = { startedAt: Date.now(), finished: false, aborted: false, failed: false, moved: 0, kept: 0, excluded: 0, errors: [], moves: [] };
  win.ZenTabSortingLastWorkspaceRun = run;
  win.document.getElementById("zao-workspace-errors")?.remove();
  try {
    const snapshot = snapshotWorkspaceUnits(win, readSkipDomainsPref());
    run.excluded = snapshot.skipped.length;
    if (snapshot.workspaces.length < 2) {
      toast(t("workspace.needTwoSpaces", null, win));
      return run;
    }
    if (!snapshot.units.length) {
      toast(t("workspace.noUnits", null, win));
      return run;
    }
    recordDebugEvent("SPACE-START", `${snapshot.units.length} Einheiten in ${snapshot.workspaces.length} Spaces`);
    const plan = await classifyWorkspaceUnitsWithJev({ ...snapshot, fetchImpl: win.fetch.bind(win), signal, concurrency: 3 });
    if (signal.aborted) {
      run.aborted = true;
      toast(t("toast.sortAborted", null, win), { type: "info" });
      return run;
    }

    const errors = [...plan.errors];
    run.kept = plan.decisions.filter((decision) => !decision.shouldMove).length;
    const moves = plan.decisions.filter((decision) => decision.shouldMove);
    const selected = win.gBrowser.selectedTab;
    let userChangedFocus = false;
    let mutating = false;
    const onSelection = (event) => {
      if (!mutating && event.target !== selected) userChangedFocus = true;
    };
    const onSpaceChange = () => { if (!mutating) userChangedFocus = true; };
    win.addEventListener("TabSelect", onSelection);
    win.addEventListener("ZenWorkspaceChange", onSpaceChange);

    const movedDecisions = [];
    let fullUndoSnapshot = null;

    try {
      // Freeze validation before the first mutation so one planned move cannot
      // invalidate the neighbours of a later one.
      const ready = moves.filter(({ unit, toWorkspaceId }) => {
        const currentSpaces = win.gZenWorkspaces.getWorkspaces?.() || [];
        const target = currentSpaces.find((space) => space.uuid === toWorkspaceId);
        const original = snapshot.workspaces.find((space) => space.id === toWorkspaceId);
        const source = currentSpaces.find((space) => space.uuid === unit.workspaceId);
        const originalSource = snapshot.workspaces.find((space) => space.id === unit.workspaceId);
        if (workspaceUnitIsUnchanged(unit) && target?.name === original?.name && source?.name === originalSource?.name) return true;
        errors.push({ unit, phase: "move", reason: t("error.elementOrSpaceChanged", null, win) });
        return false;
      });

      fullUndoSnapshot = captureUndoSnapshot(win, ready);
      const retryQueue = [];

      // Keep mutating=true across the full synchronous mutation batch + rAF settle tick,
      // and keep retries outside the animation callback so motion never stalls for 350ms.
      mutating = true;
      try {
        await animateSidebarChanges(win, () => {
          for (const decision of ready) {
            if (signal.aborted) break;
            const { unit, toWorkspaceId } = decision;
            try {
              moveWorkspaceUnit(win, unit, toWorkspaceId);
              movedDecisions.push(decision);
              run.moved++;
              run.moves.push({
                id: unit.id,
                name: unit.name,
                kind: unit.kind,
                from: unit.workspaceId,
                to: toWorkspaceId,
                score: decision.score,
                currentScore: decision.currentScore,
              });
            } catch (error) {
              // A native event listener can throw after the mutation succeeded.
              if (workspaceUnitIsAtTarget(win, unit, toWorkspaceId)) {
                movedDecisions.push(decision);
                run.moved++;
                run.moves.push({
                  id: unit.id,
                  name: unit.name,
                  kind: unit.kind,
                  from: unit.workspaceId,
                  to: toWorkspaceId,
                  score: decision.score,
                  currentScore: decision.currentScore,
                });
              } else {
                retryQueue.push({ decision, firstError: error });
              }
            }
          }
          win.gBrowser.tabContainer._invalidateCachedTabs?.();
          win.gZenWorkspaces.updateTabsContainers?.();
          void win.gBrowser.tabs.length;
        }, {
          entries: ready.map(({ unit, toWorkspaceId }) => ({
            node: unit._node,
            label: unit.name,
            fromWorkspaceId: unit.workspaceId,
            toWorkspaceId,
          })),
          signal,
        });

        // Retry failed moves outside the animation callback.
        if (retryQueue.length > 0 && !signal.aborted) {
          await waitAbortable(win, 350, signal);
          for (const { decision, firstError } of retryQueue) {
            if (signal.aborted) break;
            const { unit, toWorkspaceId } = decision;
            try {
              moveWorkspaceUnit(win, unit, toWorkspaceId);
              movedDecisions.push(decision);
              run.moved++;
              run.moves.push({
                id: unit.id,
                name: unit.name,
                kind: unit.kind,
                from: unit.workspaceId,
                to: toWorkspaceId,
                score: decision.score,
                currentScore: decision.currentScore,
              });
            } catch (error) {
              if (workspaceUnitIsAtTarget(win, unit, toWorkspaceId)) {
                movedDecisions.push(decision);
                run.moved++;
                run.moves.push({
                  id: unit.id,
                  name: unit.name,
                  kind: unit.kind,
                  from: unit.workspaceId,
                  to: toWorkspaceId,
                  score: decision.score,
                  currentScore: decision.currentScore,
                });
              } else {
                errors.push({
                  unit,
                  phase: "move",
                  reason: error?.message || firstError?.message || t("error.transferFailed", null, win),
                });
              }
            }
          }
          win.gBrowser.tabContainer._invalidateCachedTabs?.();
          win.gZenWorkspaces.updateTabsContainers?.();
          void win.gBrowser.tabs.length;
        }

        if (!saveGroupState(win)) {
          errors.push({
            unit: { id: "group-state", name: t("workspace.groupStateName", null, win) },
            phase: "persistence",
            reason: t("workspace.groupStateSaveError", null, win),
          });
        }

        if (!signal.aborted && !userChangedFocus && selected?.isConnected && !selected.closing) {
          const target = selected.getAttribute("zen-workspace-id");
          if (target && target !== win.gZenWorkspaces.activeWorkspace) {
            await win.gZenWorkspaces.changeWorkspaceWithID(target);
          }
          win.gBrowser.selectedTab = selected;
        }

        // Wait one rAF settle tick while mutating=true so deferred Zen focus events
        // don't masquerade as user navigation.
        await settleFrame(win);
      } finally {
        mutating = false;
      }
    } finally {
      win.removeEventListener("TabSelect", onSelection);
      win.removeEventListener("ZenWorkspaceChange", onSpaceChange);
    }

    // Store undo snapshot restricted to entries that actually moved.
    if (movedDecisions.length > 0 && fullUndoSnapshot) {
      const movedIds = new Set(movedDecisions.map((d) => d.unit.id));
      win._zaoLastWorkspaceUndo = {
        createdAt: fullUndoSnapshot.createdAt,
        entries: fullUndoSnapshot.entries.filter((entry) => movedIds.has(entry.id)),
      };
    } else {
      delete win._zaoLastWorkspaceUndo;
    }

    if (signal.aborted) {
      run.aborted = true;
      toast(t("toast.sortAborted", null, win), { type: "info" });
      return run;
    }

    run.errors = errors.map(({ unit, reason, phase }) => ({ id: unit.id, name: unit.name, reason, phase }));
    showErrorReport(win, run.errors);
    const summaryKey = run.errors.length ? "workspace.summaryWithErrors" : "workspace.summary";
    const summaryMsg = t(summaryKey, {
      moved: run.moved,
      kept: run.kept,
      excluded: run.excluded,
      errors: run.errors.length,
    }, win);
    toast(summaryMsg, {
      type: run.errors.length ? "warning" : "success",
      duration: run.errors.length ? 9000 : run.moved > 0 ? 7500 : 5500,
      action: run.moved > 0
        ? {
            label: t("toast.undo", null, win),
            onClick: () => { void undoLastWorkspaceSort(win); },
          }
        : undefined,
    });
    recordDebugEvent("SPACE-RESULT", `${run.moved} verschoben, ${run.kept} bleiben, ${run.errors.length} Fehler`, run);
    return run;
  } catch (error) {
    if (signal.aborted) {
      run.aborted = true;
      toast(t("toast.sortAborted", null, win), { type: "info" });
      return run;
    }
    run.failed = true;
    run.errors.push({
      name: t("workspace.runName", null, win),
      reason: error?.message || t("toast.sortFailed", null, win),
      phase: "run",
    });
    showErrorReport(win, run.errors);
    toast(run.errors.at(-1).reason, { type: "error" });
    return run;
  } finally {
    // The native debounced rebuild can run while live units still carry their
    // flight marker. Reconcile from the settled real strips after animation and
    // focus changes, so every card reflects the final cross-Space membership.
    try { win.document.querySelector("zen-library-spaces-section")?.refreshStripsNow?.(); }
    catch (error) { recordDebugEvent("SPACE-LIBRARY", "Library konnte nach dem Sortieren nicht aktualisiert werden", { message: error.message }); }
    run.finished = true;
    run.finishedAt = Date.now();
  }
}, win);

export const setupWorkspaceSortMenu = (win = globalThis.window) => {
  const popup = win.document.getElementById("zenWorkspaceMoreActions");
  if (!popup || win._zaoWorkspaceMenu) return;
  const item = win.document.createXULElement("menuitem");
  item.id = "zao-sort-workspaces";
  item.setAttribute("label", t("workspace.menuLabel", null, win));
  item.setAttribute("tooltiptext", t("workspace.menuTooltip", null, win));
  const separator = win.document.createXULElement("menuseparator");
  const onShowing = (event) => {
    if (event.target !== popup) return;
    const running = isSortRunning(win);
    item.disabled = running;
    item.setAttribute("label", t(running ? "workspace.menuBusy" : "workspace.menuLabel", null, win));
  };
  const onCommand = () => { void organizeWorkspaces(win); };
  popup.append(separator, item);
  popup.addEventListener("popupshowing", onShowing);
  item.addEventListener("command", onCommand);
  win._zaoWorkspaceMenu = { popup, item, separator, onShowing, onCommand };
};

export const teardownWorkspaceSortMenu = (win = globalThis.window) => {
  const state = win?._zaoWorkspaceMenu;
  if (!state) return;
  state.popup.removeEventListener("popupshowing", state.onShowing);
  state.item.removeEventListener("command", state.onCommand);
  state.item.remove();
  state.separator.remove();
  win.document.getElementById("zao-workspace-errors")?.remove();
  delete win._zaoWorkspaceMenu;
};
