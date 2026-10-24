import { readSkipDomainsPref } from "./rules.mjs";
import { classifyWorkspaceUnitsWithJev } from "./workspace-jev.mjs";
import { snapshotWorkspaceUnits, workspaceUnitIsUnchanged, workspaceUnitIsAtTarget, moveWorkspaceUnit } from "./workspace-browser.mjs";
import { animateSidebarChanges } from "./sort-animation.mjs";
import { isSortRunning, withSortSession } from "./sort-session.mjs";
import { showToast } from "./ui-toast.mjs";
import { recordDebugEvent } from "./debug-journal.mjs";
import { saveGroupState } from "./group-state.mjs";

const HTML = "http://www.w3.org/1999/xhtml";

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
  panel.setAttribute("aria-label", "Fehler beim Sortieren der Spaces");
  const title = element("strong", `${errors.length} Elemente konnten nicht einsortiert werden`);
  const close = element("button", "Schließen");
  close.type = "button";
  close.addEventListener("click", () => panel.remove());
  const list = element("ul");
  for (const error of errors) list.appendChild(element("li", `${error.name}: ${error.reason}`));
  panel.append(title, close, list);
  win.document.documentElement.appendChild(panel);
};

export const organizeWorkspaces = (win = globalThis.window) => withSortSession("workspaces", async (signal) => {
  const toast = (message, options = {}) => showToast(message, { ...options, targetWindow: win });
  const run = { startedAt: Date.now(), finished: false, moved: 0, kept: 0, excluded: 0, errors: [], moves: [] };
  win.ZenTabSortingLastWorkspaceRun = run;
  win.document.getElementById("zao-workspace-errors")?.remove();
  const buttons = [...win.document.querySelectorAll("#tab-wand-button")];
  buttons.forEach((button) => button.classList.add("zao-thinking"));
  try {
    const snapshot = snapshotWorkspaceUnits(win, readSkipDomainsPref());
    run.excluded = snapshot.skipped.length;
    if (snapshot.workspaces.length < 2) {
      toast("Zum Sortieren werden mindestens zwei Spaces in diesem Fenster benötigt.");
      return run;
    }
    if (!snapshot.units.length) {
      toast("Keine sortierbaren Tabs oder Ordner gefunden.");
      return run;
    }
    recordDebugEvent("SPACE-START", `${snapshot.units.length} Einheiten in ${snapshot.workspaces.length} Spaces`);
    const plan = await classifyWorkspaceUnitsWithJev({ ...snapshot, fetchImpl: win.fetch.bind(win), signal });
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
    try {
      // Freeze validation before the first mutation so one planned move cannot
      // invalidate the neighbours of a later one.
      const ready = moves.filter(({ unit, toWorkspaceId }) => {
        const target = win.gZenWorkspaces.getWorkspaces().find((space) => space.uuid === toWorkspaceId);
        const original = snapshot.workspaces.find((space) => space.id === toWorkspaceId);
        const source = win.gZenWorkspaces.getWorkspaces().find((space) => space.uuid === unit.workspaceId);
        const originalSource = snapshot.workspaces.find((space) => space.id === unit.workspaceId);
        if (workspaceUnitIsUnchanged(unit) && target?.name === original?.name && source?.name === originalSource?.name) return true;
        errors.push({ unit, phase: "move", reason: "Element oder Ziel-Space wurde während der Berechnung verändert" });
        return false;
      });
      await animateSidebarChanges(win, async () => {
        for (const decision of ready) {
          const { unit, toWorkspaceId } = decision;
          let failure;
          for (let attempt = 0; attempt < 2; attempt++) {
            if (signal.aborted) throw new Error("Sortierung abgebrochen");
            if (attempt) await new Promise((resolve) => win.setTimeout(resolve, 350));
            try {
              mutating = true;
              moveWorkspaceUnit(win, unit, toWorkspaceId);
              failure = null;
              break;
            } catch (error) {
              // A native event listener can throw after the mutation succeeded.
              if (workspaceUnitIsAtTarget(win, unit, toWorkspaceId)) { failure = null; break; }
              failure = error;
            } finally { mutating = false; }
          }
          if (failure) errors.push({ unit, phase: "move", reason: failure.message || "Transfer fehlgeschlagen" });
          else {
            run.moved++;
            run.moves.push({ id: unit.id, name: unit.name, kind: unit.kind, from: unit.workspaceId, to: toWorkspaceId, score: decision.score, currentScore: decision.currentScore });
          }
        }
        win.gBrowser.tabContainer._invalidateCachedTabs?.();
        win.gZenWorkspaces.updateTabsContainers?.();
        void win.gBrowser.tabs.length;
        if (!saveGroupState(win)) errors.push({ unit: { id: "group-state", name: "Gruppenstatus" }, phase: "persistence", reason: "Gruppenstatus konnte nicht für den nächsten Neustart gespeichert werden" });
      }, { entries: ready.map(({ unit, toWorkspaceId }) => ({ node: unit._node, label: unit.name, fromWorkspaceId: unit.workspaceId, toWorkspaceId })) });
      if (!userChangedFocus && selected?.isConnected && !selected.closing) {
        const target = selected.getAttribute("zen-workspace-id");
        if (target && target !== win.gZenWorkspaces.activeWorkspace) {
          mutating = true;
          await win.gZenWorkspaces.changeWorkspaceWithID(target);
        }
        win.gBrowser.selectedTab = selected;
      }
    } finally {
      win.removeEventListener("TabSelect", onSelection);
      win.removeEventListener("ZenWorkspaceChange", onSpaceChange);
    }
    run.errors = errors.map(({ unit, reason, phase }) => ({ id: unit.id, name: unit.name, reason, phase }));
    showErrorReport(win, run.errors);
    toast(`${run.moved} Elemente verschoben, ${run.kept} bleiben, ${run.excluded} ausgenommen.${run.errors.length ? ` ${run.errors.length} Fehler – Details im Fehlerbericht.` : ""}`, {
      type: run.errors.length ? "warning" : "success", duration: run.errors.length ? 9000 : 5500,
    });
    recordDebugEvent("SPACE-RESULT", `${run.moved} verschoben, ${run.kept} bleiben, ${run.errors.length} Fehler`, run);
    return run;
  } catch (error) {
    run.errors.push({ name: "Workspace-Sortierung", reason: error.message || "Sortierung fehlgeschlagen", phase: "run" });
    showErrorReport(win, run.errors);
    toast(run.errors.at(-1).reason, { type: "error" });
    return run;
  } finally {
    buttons.forEach((button) => button.classList.remove("zao-thinking"));
    run.finished = true;
    run.finishedAt = Date.now();
  }
}, win);

export const setupWorkspaceSortMenu = (win = globalThis.window) => {
  const popup = win.document.getElementById("zenWorkspaceMoreActions");
  if (!popup || win._zaoWorkspaceMenu) return;
  const item = win.document.createXULElement("menuitem");
  item.id = "zao-sort-workspaces";
  item.setAttribute("label", "Alle Spaces automatisch sortieren");
  item.setAttribute("tooltiptext", "Tabs und vollständige Gruppen dieses Fensters mit Jev in vorhandene Spaces sortieren");
  const separator = win.document.createXULElement("menuseparator");
  const onShowing = (event) => {
    if (event.target !== popup) return;
    item.disabled = isSortRunning(win);
    item.setAttribute("label", isSortRunning(win) ? "Spaces werden sortiert …" : "Alle Spaces automatisch sortieren");
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
