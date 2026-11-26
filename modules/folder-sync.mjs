// Zen Tab Sorting — Built-in Folder Engine: multi-window sync, workspace
// visibility, and nested folder hierarchy helpers.
//
// Portions adapted from Advanced Tab Groups (MIT, Copyright (c) 2025 12th-devs).
// Uses event-driven coalesced updates and re-entrancy guards instead of global
// document.body MutationObserver storms.

import { LOG } from "./config.mjs";
import { NORMAL_GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";
import { saveGroupState } from "./group-state.mjs";

const WINDOW_SYNC_STATE = new WeakMap();
const SHARED_SYNC_PATCHES = new WeakMap();
const APPLYING_WINDOWS = new WeakSet();

const PARENT_ATTR = "data-atg-parent-id";
const WS_HIDDEN_ATTR = "atg-ws-hidden";

// ─── Pure predicates & hierarchy helpers ─────────────────────────────────────

export const isPlainTabGroup = (node) => {
  if (!node) return false;
  const tag = (node.localName || node.tagName || "").toLowerCase();
  if (tag !== "tab-group") return false;
  if (node.isZenFolder) return false;
  if (node.classList?.contains?.("zen-folder") || node.hasAttribute?.("zen-folder")) return false;
  if (node.hasAttribute?.("split-view-group")) return false;
  if (isSidebarCopy(node)) return false;
  return true;
};

export const getDomParentGroup = (group) => {
  if (!group?.parentElement?.closest) return null;
  const parent = group.parentElement.closest("tab-group");
  if (!parent || parent === group || !isPlainTabGroup(parent)) return null;
  return parent;
};

export const getGroupParentId = (group, savedParents = null) => {
  if (!group) return null;
  const domParent = getDomParentGroup(group);
  if (domParent?.id) return domParent.id;
  const attrId = group.getAttribute?.(PARENT_ATTR) || group.getAttribute?.("data-zao-parent-id");
  if (attrId) return attrId;
  if (group.group?.id && group.group !== group && isPlainTabGroup(group.group)) {
    return group.group.id;
  }
  if (savedParents && group.id && typeof savedParents[group.id] === "string") {
    return savedParents[group.id];
  }
  return null;
};

/**
 * Detect whether nesting `child` under `parent` would form a cycle (self,
 * direct ancestor, DOM containment, or transitive cycle in persisted parent maps).
 */
export const wouldCreateParentCycle = (
  child,
  parent,
  { getGroupById = null, savedParents = null } = {},
) => {
  if (!child || !parent) return true;
  if (child === parent) return true;
  if (child.id && parent.id && child.id === parent.id) return true;
  if (typeof child.contains === "function" && child.contains(parent)) return true;

  const childId = child.id || null;
  const visitedNodes = new Set();
  const visitedIds = new Set();
  if (childId) visitedIds.add(childId);

  let current = parent;
  while (current) {
    if (current === child) return true;
    if (childId && current.id === childId) return true;
    if (visitedNodes.has(current)) return true;
    visitedNodes.add(current);
    if (current.id) visitedIds.add(current.id);

    const domParent = getDomParentGroup(current);
    if (domParent) {
      current = domParent;
      continue;
    }

    const parentId = getGroupParentId(current, savedParents);
    if (!parentId) break;
    if (childId && parentId === childId) return true;
    if (visitedIds.has(parentId)) return true;

    const resolved = typeof getGroupById === "function" ? getGroupById(parentId) : null;
    if (resolved) {
      current = resolved;
      continue;
    }

    // Continue walking purely through savedParents if the DOM node isn't live yet.
    let cursorId = parentId;
    while (cursorId) {
      if (childId && cursorId === childId) return true;
      if (visitedIds.has(cursorId)) return true;
      visitedIds.add(cursorId);
      cursorId = savedParents && typeof savedParents[cursorId] === "string"
        ? savedParents[cursorId]
        : null;
    }
    break;
  }

  return false;
};

export const ensureGroupContainer = (group, doc = group?.ownerDocument || globalThis.document) => {
  if (!group) return null;
  let container =
    group.groupContainer ||
    group.querySelector?.(":scope > .tab-group-container") ||
    null;
  if (!container && doc) {
    container = typeof doc.createElement === "function" ? doc.createElement("div") : null;
    if (container) {
      container.className = "tab-group-container";
      group.appendChild?.(container);
    }
  }
  if (container && doc && !container.querySelector?.(":scope > .zen-tab-group-start")) {
    const start = typeof doc.createElement === "function" ? doc.createElement("div") : null;
    if (start) {
      start.className = "zen-tab-group-start";
      if (typeof container.prepend === "function") container.prepend(start);
      else container.insertBefore?.(start, container.firstChild || null);
    }
  }
  return container;
};

export const getGroupWorkspaceId = (group, win = globalThis.window) => {
  if (!group) return null;
  return (
    group.closest?.("zen-workspace")?.id ||
    group.getAttribute?.("zen-workspace-id") ||
    group.querySelector?.("tab[zen-workspace-id]")?.getAttribute?.("zen-workspace-id") ||
    win?.gZenWorkspaces?.activeWorkspace ||
    null
  );
};

export const isGroupInActiveWorkspace = (group, win = globalThis.window) => {
  try {
    if (!group?.isConnected) return false;
    const gzw = win?.gZenWorkspaces;
    if (!gzw) return true;

    const strip = gzw.activeWorkspaceStrip || gzw.activeWorkspaceElement;
    if (strip && typeof strip.contains === "function") {
      if (strip.contains(group)) return true;
    }

    const activeId = gzw.activeWorkspace;
    if (!activeId) return true;

    const wsEl = gzw.workspaceElement?.(activeId);
    if (wsEl && typeof wsEl.contains === "function") {
      return wsEl.contains(group);
    }

    const groupWs = group.closest?.("zen-workspace")?.id || group.getAttribute?.("zen-workspace-id");
    return !groupWs || groupWs === activeId;
  } catch {
    return true;
  }
};

const collectPlainGroups = (win) => {
  const doc = win?.document;
  if (!doc) return [];
  const seen = new Set();
  const list = [];
  const add = (node) => {
    if (!node || seen.has(node) || !isPlainTabGroup(node)) return;
    seen.add(node);
    list.push(node);
  };
  try {
    const tabGroups = win.gBrowser?.tabGroups;
    if (Array.isArray(tabGroups)) {
      for (const g of tabGroups) add(g);
    }
  } catch {}
  try {
    for (const g of doc.querySelectorAll?.(NORMAL_GROUP_SELECTOR) || []) add(g);
  } catch {}
  return list;
};

/**
 * Update `atg-ws-hidden` on plain tab groups so groups in inactive workspaces
 * stay hidden in real tab strips while Zen Library space-card copies stay clean.
 */
export const updateGroupVisibility = (win = globalThis.window) => {
  if (!win?.document) return { visible: 0, hidden: 0 };
  let visible = 0;
  let hidden = 0;
  try {
    const gzw = win.gZenWorkspaces;
    const activeStrip = gzw?.activeWorkspaceStrip || gzw?.activeWorkspaceElement || null;
    const activeWorkspaceId = gzw?.activeWorkspace || null;
    const activeIds = new Set();

    if (activeStrip?.querySelectorAll) {
      for (const g of activeStrip.querySelectorAll(NORMAL_GROUP_SELECTOR)) {
        if (g?.id) activeIds.add(g.id);
      }
    }

    for (const group of collectPlainGroups(win)) {
      if (group.hasAttribute?.("drag-image")) continue;
      // Legacy `hidden` prevents Zen Library from cloning space-card rows.
      if (group.hasAttribute?.("hidden")) {
        try { group.removeAttribute("hidden"); } catch {}
      }

      let inActive;
      if (activeIds.size > 0 && group.id) {
        inActive = activeIds.has(group.id);
      } else if (activeStrip && typeof activeStrip.contains === "function") {
        inActive = activeStrip.contains(group);
      } else if (activeWorkspaceId) {
        const ws = group.closest?.("zen-workspace")?.id || group.getAttribute?.("zen-workspace-id");
        inActive = !ws || ws === activeWorkspaceId;
      } else {
        inActive = true;
      }

      if (inActive) {
        group.removeAttribute?.(WS_HIDDEN_ATTR);
        visible++;
      } else {
        group.setAttribute?.(WS_HIDDEN_ATTR, "true");
        hidden++;
      }
    }
  } catch (e) {
    console.error(`${LOG} folder-sync updateGroupVisibility error:`, e);
  }
  return { visible, hidden };
};

// ─── Nesting & unnesting ─────────────────────────────────────────────────────

const resolveRootTabContainer = (group, win) => {
  const wsId = getGroupWorkspaceId(group, win);
  const wsEl = wsId ? win?.gZenWorkspaces?.workspaceElement?.(wsId) : null;
  return (
    wsEl?.tabsContainer ||
    group?.closest?.(".zen-workspace-normal-tabs-section") ||
    win?.gZenWorkspaces?.activeWorkspaceStrip ||
    win?.gBrowser?.tabContainer?.querySelector?.(".zen-workspace-normal-tabs-section") ||
    win?.gBrowser?.tabContainer ||
    null
  );
};

export const nestGroupUnder = (
  group,
  parentGroup,
  { win = globalThis.window, save = true, sync = true, savedParents = null } = {},
) => {
  try {
    if (!isPlainTabGroup(group) || !isPlainTabGroup(parentGroup)) return false;

    const getGroupById = (id) => {
      if (!id || !win?.document) return null;
      const el = win.document.getElementById?.(id);
      return isPlainTabGroup(el) ? el : null;
    };

    if (wouldCreateParentCycle(group, parentGroup, { getGroupById, savedParents })) {
      return false;
    }

    const parentContainer = ensureGroupContainer(parentGroup, win?.document || group.ownerDocument);
    if (!parentContainer) return false;

    const periphery = parentContainer.querySelector?.("#tabbrowser-arrowscrollbox-periphery") || null;
    const move = () => {
      parentContainer.insertBefore(group, periphery);
      if (parentGroup.id) group.setAttribute?.(PARENT_ATTR, parentGroup.id);
      const wsId = getGroupWorkspaceId(parentGroup, win) || getGroupWorkspaceId(group, win);
      if (wsId) {
        group.setAttribute?.("zen-workspace-id", wsId);
        for (const tab of group.querySelectorAll?.("tab") || []) {
          tab.setAttribute?.("zen-workspace-id", wsId);
        }
      }
    };

    if (typeof win?.gBrowser?.zenHandleTabMove === "function" && group.tabs?.length) {
      win.gBrowser.zenHandleTabMove(group, move);
    } else {
      move();
    }

    win?.gBrowser?.tabContainer?._invalidateCachedTabs?.();
    if (save && win) saveGroupState(win);
    if (sync && win && group.id && parentGroup.id) {
      syncFolderNestingToWindows(win, group.id, parentGroup.id);
    }
    try { win?.document?.querySelector?.("zen-library")?.update?.(true); } catch {}
    updateGroupVisibility(win);
    return true;
  } catch (e) {
    console.error(`${LOG} folder-sync nestGroupUnder error:`, e);
    return false;
  }
};

export const unnestGroup = (
  group,
  { win = globalThis.window, save = true, sync = true } = {},
) => {
  try {
    if (!isPlainTabGroup(group)) return false;
    const currentParent = getDomParentGroup(group);
    const rootContainer = resolveRootTabContainer(currentParent || group, win);
    if (!rootContainer) return false;

    const periphery = rootContainer.querySelector?.("#tabbrowser-arrowscrollbox-periphery") || null;
    const insertBefore =
      (currentParent && currentParent.parentElement === rootContainer ? currentParent.nextSibling : null) ||
      periphery ||
      null;

    const move = () => {
      rootContainer.insertBefore(group, insertBefore);
      group.removeAttribute?.(PARENT_ATTR);
    };

    if (typeof win?.gBrowser?.zenHandleTabMove === "function" && group.tabs?.length) {
      win.gBrowser.zenHandleTabMove(group, move);
    } else {
      move();
    }

    win?.gBrowser?.tabContainer?._invalidateCachedTabs?.();
    if (save && win) saveGroupState(win);
    if (sync && win && group.id) {
      syncFolderNestingToWindows(win, group.id, null);
    }
    try { win?.document?.querySelector?.("zen-library")?.update?.(true); } catch {}
    updateGroupVisibility(win);
    return true;
  } catch (e) {
    console.error(`${LOG} folder-sync unnestGroup error:`, e);
    return false;
  }
};

// ─── Cross-window sync helpers ───────────────────────────────────────────────

export const getOtherSyncedWindows = (sourceWin = globalThis.window) => {
  const result = [];
  const wm = globalThis.Services?.wm;
  if (!sourceWin || !wm?.getEnumerator) return result;
  const sync = sourceWin.gZenWindowSync || null;
  try {
    const enumerator = wm.getEnumerator("navigator:browser");
    while (enumerator.hasMoreElements()) {
      const win = enumerator.getNext();
      if (
        !win ||
        win === sourceWin ||
        win.closed ||
        win._zenClosingWindow ||
        win.gZenWorkspaces?.privateWindowOrDisabled ||
        win.document?.documentElement?.hasAttribute?.("zen-unsynced-window")
      ) {
        continue;
      }
      if (sync && win.gZenWindowSync && win.gZenWindowSync !== sync) continue;
      result.push(win);
    }
  } catch (e) {
    console.warn(`${LOG} folder-sync window enumeration failed:`, e);
  }
  return result;
};

const runGuardedInWindow = (targetWin, fn) => {
  if (!targetWin || targetWin.closed || APPLYING_WINDOWS.has(targetWin)) return;
  APPLYING_WINDOWS.add(targetWin);
  const sync = targetWin.gZenWindowSync;
  const prevApplying = sync?.__zaoApplyingFrom;
  if (sync) sync.__zaoApplyingFrom = targetWin;
  try {
    fn(targetWin);
  } catch (e) {
    console.error(`${LOG} folder-sync cross-window apply failed:`, e);
  } finally {
    if (sync) sync.__zaoApplyingFrom = prevApplying;
    APPLYING_WINDOWS.delete(targetWin);
  }
};

export const isSyncApplying = (win) =>
  Boolean(win && (APPLYING_WINDOWS.has(win) || (win.gZenWindowSync?.__zaoApplyingFrom && win.gZenWindowSync.__zaoApplyingFrom !== win)));

export const syncFolderRenameToWindows = (sourceWin, groupId, newLabel) => {
  if (!sourceWin || !groupId || isSyncApplying(sourceWin)) return;
  const shown = newLabel || "\u200b";
  for (const win of getOtherSyncedWindows(sourceWin)) {
    runGuardedInWindow(win, () => {
      const mirrored = win.document?.getElementById?.(groupId);
      if (!isPlainTabGroup(mirrored)) return;
      if ((mirrored.label || "") !== newLabel) {
        try { mirrored.label = newLabel; } catch { mirrored.setAttribute?.("label", newLabel); }
      }
      const labelEl = mirrored.querySelector?.(":scope > .tab-group-label-container .tab-group-label");
      if (labelEl && labelEl.textContent !== shown) labelEl.textContent = shown;
      saveGroupState(win);
    });
  }
};

export const syncFolderColorToWindows = (sourceWin, groupId, color) => {
  if (!sourceWin || !groupId || isSyncApplying(sourceWin)) return;
  for (const win of getOtherSyncedWindows(sourceWin)) {
    runGuardedInWindow(win, () => {
      const mirrored = win.document?.getElementById?.(groupId);
      if (!isPlainTabGroup(mirrored)) return;
      win._zaoFolderEngine?.applySyncedColor?.(mirrored, color);
    });
  }
};

export const syncFolderEmojiToWindows = (sourceWin, groupId, emoji) => {
  if (!sourceWin || !groupId || isSyncApplying(sourceWin)) return;
  for (const win of getOtherSyncedWindows(sourceWin)) {
    runGuardedInWindow(win, () => {
      const mirrored = win.document?.getElementById?.(groupId);
      if (!isPlainTabGroup(mirrored)) return;
      win._zaoFolderEngine?.applySyncedEmoji?.(mirrored, emoji);
    });
  }
};

export const syncFolderNestingToWindows = (sourceWin, groupId, parentId) => {
  if (!sourceWin || !groupId || isSyncApplying(sourceWin)) return;
  for (const win of getOtherSyncedWindows(sourceWin)) {
    runGuardedInWindow(win, () => {
      const mirrored = win.document?.getElementById?.(groupId);
      if (!isPlainTabGroup(mirrored)) return;
      if (parentId) {
        const parent = win.document?.getElementById?.(parentId);
        if (isPlainTabGroup(parent)) {
          nestGroupUnder(mirrored, parent, { win, save: true, sync: false });
        }
      } else {
        unnestGroup(mirrored, { win, save: true, sync: false });
      }
    });
  }
};

export const syncFolderRemovalToWindows = (sourceWin, groupId) => {
  if (!sourceWin || !groupId || isSyncApplying(sourceWin)) return;
  for (const win of getOtherSyncedWindows(sourceWin)) {
    runGuardedInWindow(win, () => {
      win._zaoFolderEngine?.removePersistedFolderMeta?.(groupId);
    });
  }
};

// ─── Shared ZenWindowSync patching (reference-counted across windows) ────────

const patchSharedWindowSync = (win) => {
  const sync = win?.gZenWindowSync;
  if (!sync) return null;

  let record = SHARED_SYNC_PATCHES.get(sync);
  if (record) {
    record.refCount += 1;
    return record;
  }

  record = {
    sync,
    refCount: 1,
    origCreate: typeof sync.on_TabGroupCreate === "function" ? sync.on_TabGroupCreate : null,
    origRemoved: typeof sync.on_TabGroupRemoved === "function" ? sync.on_TabGroupRemoved : null,
    origMove: typeof sync.on_TabMove === "function" ? sync.on_TabMove : null,
  };

  if (record.origCreate) {
    const original = record.origCreate;
    sync.on_TabGroupCreate = function (aEvent) {
      const group = aEvent?.target;
      const sourceWindow = group?.documentGlobal || group?.ownerDocument?.defaultView;
      const isPlain =
        isPlainTabGroup(group) &&
        !group.alreadySynced &&
        Boolean(group.id) &&
        Boolean(sourceWindow?.gBrowser);
      if (!isPlain) return original.call(this, aEvent);

      const tabs = Array.from(group.tabs || []).filter((tab) => !tab.hasAttribute?.("zen-empty-tab"));
      if (tabs.length === 0) return original.call(this, aEvent);

      for (const otherWin of getOtherSyncedWindows(sourceWindow)) {
        if (otherWin.document?.getElementById?.(group.id)) continue;
        const winTabs = tabs
          .map((tab) => otherWin.document?.getElementById?.(tab.id))
          .filter((tab) => tab && otherWin.gBrowser?.isTab?.(tab));
        if (winTabs.length === 0) continue;

        runGuardedInWindow(otherWin, () => {
          const mirrored = otherWin.gBrowser.addTabGroup(winTabs, {
            id: group.id,
            label: group.label || "",
            color: group.color,
            insertBefore: winTabs[0],
          });
          if (!mirrored) return;
          mirrored.alreadySynced = true;
          const wsId = group.getAttribute?.("zen-workspace-id");
          if (wsId) mirrored.setAttribute?.("zen-workspace-id", wsId);
          if (group.collapsed) {
            try { mirrored.collapsed = true; } catch {}
          }
          const parentId = getGroupParentId(group);
          if (parentId) {
            const parentMirror = otherWin.document?.getElementById?.(parentId);
            if (isPlainTabGroup(parentMirror)) {
              nestGroupUnder(mirrored, parentMirror, { win: otherWin, save: false, sync: false });
            }
          }
          const emoji = group.getAttribute?.("data-zao-folder-emoji");
          if (emoji) otherWin._zaoFolderEngine?.applySyncedEmoji?.(mirrored, emoji);
          saveGroupState(otherWin);
        });
      }
      return undefined;
    };
  }

  if (record.origMove) {
    const originalMove = record.origMove;
    sync.on_TabMove = function (aEvent) {
      const previous = this.__zaoApplyingFrom;
      this.__zaoApplyingFrom = aEvent?.target?.documentGlobal || previous;
      try {
        return originalMove.call(this, aEvent);
      } finally {
        this.__zaoApplyingFrom = previous;
      }
    };
  }

  if (record.origRemoved) {
    const originalRemoved = record.origRemoved;
    sync.on_TabGroupRemoved = function (aEvent) {
      const group = aEvent?.target;
      const sourceWindow = group?.documentGlobal || group?.ownerDocument?.defaultView;
      if (isPlainTabGroup(group) && group.id && sourceWindow?.document) {
        const sourceDoc = sourceWindow.document;
        const posInSource = (tab) => sourceDoc.getElementById?.(tab.id)?._tPos ?? Number.MAX_SAFE_INTEGER;
        for (const otherWin of getOtherSyncedWindows(sourceWindow)) {
          runGuardedInWindow(otherWin, () => {
            const doc = otherWin.document;
            const mirrored = doc?.getElementById?.(group.id);
            if (!isPlainTabGroup(mirrored)) return;
            const leftInside = Array.from(mirrored.tabs || [])
              .filter((tab) => otherWin.gBrowser?.isTab?.(tab) && !tab.hasAttribute?.("zen-empty-tab"))
              .sort((a, b) => posInSource(a) - posInSource(b));
            for (const tab of leftInside) {
              let anchor = null;
              const sourceTab = sourceDoc.getElementById?.(tab.id);
              for (let prev = sourceTab?.previousElementSibling; prev; prev = prev.previousElementSibling) {
                if (!prev.id) continue;
                const copy = doc.getElementById?.(prev.id);
                if (copy && copy !== mirrored && !mirrored.contains?.(copy)) {
                  anchor = copy;
                  break;
                }
              }
              try {
                if (typeof otherWin.gBrowser?.zenHandleTabMove === "function") {
                  otherWin.gBrowser.zenHandleTabMove(tab, () => {
                    if (anchor) anchor.after(tab);
                    else mirrored.before(tab);
                  });
                } else if (anchor) {
                  anchor.after(tab);
                } else {
                  mirrored.before(tab);
                }
              } catch (e) {
                console.warn(`${LOG} folder-sync ungroup mirror failed:`, e);
              }
            }
          });
        }
      }
      return originalRemoved.call(this, aEvent);
    };
  }

  SHARED_SYNC_PATCHES.set(sync, record);
  return record;
};

const unpatchSharedWindowSync = (record) => {
  if (!record) return;
  record.refCount = Math.max(0, record.refCount - 1);
  if (record.refCount > 0) return;
  const { sync, origCreate, origRemoved, origMove } = record;
  try {
    if (origCreate) sync.on_TabGroupCreate = origCreate;
    if (origRemoved) sync.on_TabGroupRemoved = origRemoved;
    if (origMove) sync.on_TabMove = origMove;
    delete sync.__zaoApplyingFrom;
  } catch {}
  SHARED_SYNC_PATCHES.delete(sync);
};

// ─── Per-window lifecycle ────────────────────────────────────────────────────

export const setupFolderSync = (win = globalThis.window) => {
  if (!win?.document || WINDOW_SYNC_STATE.has(win)) return;

  const state = {
    listeners: [],
    visTimer: null,
    visRaf: null,
    reconcileTimer: null,
    sharedPatch: null,
    origGetAllTabGroups: null,
    disposed: false,
  };
  WINDOW_SYNC_STATE.set(win, state);

  const setTimer = typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
  const clearTimer = typeof win.clearTimeout === "function" ? win.clearTimeout.bind(win) : clearTimeout;

  const scheduleVisibility = () => {
    if (state.disposed || win.closed) return;
    if (state.visTimer != null) return;
    const run = () => {
      state.visTimer = null;
      state.visRaf = null;
      if (state.disposed || win.closed) return;
      updateGroupVisibility(win);
    };
    if (typeof win.requestAnimationFrame === "function") {
      state.visRaf = win.requestAnimationFrame(() => {
        state.visRaf = null;
        if (state.disposed || win.closed) return;
        state.visTimer = setTimer(run, 40);
      });
    } else {
      state.visTimer = setTimer(run, 40);
    }
  };

  const scheduleLabelReconcile = () => {
    if (state.disposed || win.closed || isSyncApplying(win)) return;
    if (state.reconcileTimer != null) clearTimer(state.reconcileTimer);
    state.reconcileTimer = setTimer(() => {
      state.reconcileTimer = null;
      if (state.disposed || win.closed || isSyncApplying(win)) return;
      for (const group of collectPlainGroups(win)) {
        if (!group.id) continue;
        syncFolderRenameToWindows(win, group.id, group.label || "");
      }
    }, 300);
  };

  const listen = (target, type, handler, capture = false) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, capture);
    state.listeners.push([target, type, handler, capture]);
  };

  // Patch shared ZenWindowSync for multi-window plain tab-group creation/removal.
  state.sharedPatch = patchSharedWindowSync(win);

  // Deduplicate gBrowser.getAllTabGroups so native menus never list duplicate
  // copies from other synced windows.
  if (typeof win.gBrowser?.getAllTabGroups === "function" && !win.gBrowser.__zaoAllGroupsPatched) {
    const orig = win.gBrowser.getAllTabGroups;
    state.origGetAllTabGroups = orig;
    win.gBrowser.__zaoAllGroupsPatched = true;
    win.gBrowser.getAllTabGroups = function (...args) {
      const all = orig.apply(this, args) || [];
      const localIds = new Set(Array.from(this.tabGroups || []).map((g) => g?.id).filter(Boolean));
      const seen = new Set();
      return all.filter((group) => {
        if (!group) return false;
        if (group.documentGlobal && group.documentGlobal !== win && localIds.has(group.id)) {
          return false;
        }
        if (group.id) {
          if (seen.has(group.id)) return false;
          seen.add(group.id);
        }
        return true;
      });
    };
  }

  for (const evt of ["ZenWorkspaceChange", "TabGroupCreate", "TabGroupMoved", "TabMove"]) {
    listen(win, evt, scheduleVisibility, true);
  }
  listen(win, "TabGroupUpdate", scheduleLabelReconcile, true);
  listen(win, "TabGroupRemoved", (e) => {
    const g = e?.target;
    if (isPlainTabGroup(g) && g.id) syncFolderRemovalToWindows(win, g.id);
    scheduleVisibility();
  }, true);

  scheduleVisibility();
  console.log(`${LOG} folder-sync initialized`);
};

export const teardownFolderSync = (win = globalThis.window) => {
  const state = WINDOW_SYNC_STATE.get(win);
  if (!state) return;
  state.disposed = true;
  WINDOW_SYNC_STATE.delete(win);

  const clearTimer = typeof win?.clearTimeout === "function" ? win.clearTimeout.bind(win) : clearTimeout;
  if (state.visTimer != null) clearTimer(state.visTimer);
  if (state.reconcileTimer != null) clearTimer(state.reconcileTimer);
  if (state.visRaf != null && typeof win?.cancelAnimationFrame === "function") {
    try { win.cancelAnimationFrame(state.visRaf); } catch {}
  }

  for (const [target, type, handler, capture] of state.listeners) {
    try { target.removeEventListener(type, handler, capture); } catch {}
  }
  state.listeners.length = 0;

  if (state.origGetAllTabGroups && win?.gBrowser) {
    try {
      win.gBrowser.getAllTabGroups = state.origGetAllTabGroups;
      delete win.gBrowser.__zaoAllGroupsPatched;
    } catch {}
  }

  unpatchSharedWindowSync(state.sharedPatch);
};
