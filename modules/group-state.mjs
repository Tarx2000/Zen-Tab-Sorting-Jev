// Firefox persists normal group IDs but Zen can drop their Space/parent metadata.
// Window values keep this repair scoped to the same window across session restore.
import { GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";

const KEY = "zen-tab-sorting-groups-v1";
const groupsInWindow = (win) => win.gZenWorkspaces.getWorkspaces().flatMap((space) => {
  const element = win.gZenWorkspaces.workspaceElement(space.uuid);
  return [...(element?.querySelectorAll("tab-group:not([split-view-group])") || [])].filter((group) => !isSidebarCopy(group));
});
const itemsIn = (container) => [...container.children].filter((node) => node.matches(`tab, ${GROUP_SELECTOR}`) && !isSidebarCopy(node));

export const saveGroupState = (win) => {
  const state = win?._zaoGroupState;
  if (!state || state.restoring) return true;
  try {
    const records = groupsInWindow(win).filter((group) => group.id).map((group) => ({
      id: group.id,
      workspaceId: group.closest("zen-workspace")?.id || group.getAttribute("zen-workspace-id"),
      parentId: group.group?.id || null,
      index: itemsIn(group.parentElement).indexOf(group),
      collapsed: Boolean(group.collapsed),
    }));
    const setter = state.store.setCustomWindowValue || state.store.setWindowValue;
    setter.call(state.store, win, KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
};

export const setupGroupState = (win) => {
  if (win._zaoGroupState) return;
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  let saved = [];
  const state = { store: SessionStore, restoring: true, started: false, timer: null, retry: null, startupTimer: null, closed: false };
  state.ready = new Promise((resolve) => { state.resolveReady = resolve; });
  win._zaoGroupState = state;
  let deadline;
  const restore = () => {
    if (state.closed) return;
    const groups = new Map(groupsInWindow(win).map((group) => [group.id, group]));
    // A parent always goes first. Ignore corrupt/cyclic saved relationships.
    const depth = (record) => {
      let current = record;
      const visited = new Set([record.id]);
      let level = 0;
      while (current.parentId) {
        if (visited.has(current.parentId)) return 1000;
        visited.add(current.parentId);
        current = saved.find((candidate) => candidate.id === current.parentId);
        if (!current) break;
        level++;
      }
      return level;
    };
    const collapsed = new Map();
    for (const record of [...saved].sort((a, b) => depth(a) - depth(b) || a.index - b.index)) {
      const group = groups.get(record.id);
      const space = win.gZenWorkspaces.workspaceElement(record.workspaceId);
      if (!group || !space || depth(record) >= 1000) continue;
      const parent = record.parentId ? groups.get(record.parentId) || win.document.getElementById(record.parentId) : null;
      if (record.parentId && (!parent || isSidebarCopy(parent) || group.contains(parent) || parent.closest("zen-workspace")?.id !== record.workspaceId)) continue;
      const container = parent?.groupContainer || space.tabsContainer;
      if (!container) continue;
      const tabs = [...group.querySelectorAll("tab")];
      const update = () => {
        group.setAttribute("zen-workspace-id", record.workspaceId);
        for (const tab of tabs) tab.setAttribute("zen-workspace-id", record.workspaceId);
        if (group.parentElement !== container) {
          const siblings = itemsIn(container).filter((node) => node !== group);
          const before = siblings[Math.max(0, record.index)] ||
            [...container.children].find((node) => node.matches("#tabbrowser-arrowscrollbox-periphery, .pinned-tabs-container-separator")) || null;
          container.insertBefore(group, before);
        }
      };
      const relocating = group.parentElement !== container;
      try {
        if (relocating && group.tabs.length && win.gBrowser.zenHandleTabMove) win.gBrowser.zenHandleTabMove(group, update);
        else update();
        collapsed.set(group, record.collapsed);
      } catch { /* An unrestorable native group must not block other groups. */ }
    }
    // Reparenting a child can auto-expand its native parent. Restore collapse
    // only after the complete hierarchy has been rebuilt.
    for (const [group, value] of collapsed) if (group.collapsed !== value) group.collapsed = value;
    win.gBrowser.tabContainer._invalidateCachedTabs();
    const allFound = saved.every((record) => groups.has(record.id));
    if (!allFound && Date.now() < deadline) {
      state.retry = win.setTimeout(restore, 150);
      return;
    }
    state.restoring = false;
    saved = [];
    saveGroupState(win);
    state.resolveReady();
  };
  const schedule = () => {
    if (state.closed || state.restoring) return;
    win.clearTimeout(state.timer);
    state.timer = win.setTimeout(() => saveGroupState(win), 150);
  };
  const onReady = () => {
    if (state.restoring && state.started) {
      win.clearTimeout(state.retry);
      state.retry = win.setTimeout(restore, 0);
    }
  };
  const onClose = () => { if (!state.restoring) saveGroupState(win); };
  const observer = new win.MutationObserver((mutations) => {
    if (mutations.some((mutation) => !isSidebarCopy(mutation.target))) schedule();
  });
  observer.observe(win.gBrowser.tabContainer, { subtree: true, childList: true, attributes: true, attributeFilter: ["collapsed", "zen-workspace-id"] });
  const events = ["TabMove", "TabGroupMoved", "TabGroupCreate", "TabGroupRemoved", "ZenWorkspaceChange"];
  for (const name of events) win.addEventListener(name, schedule);
  win.addEventListener("SSWindowStateReady", onReady);
  win.addEventListener("beforeunload", onClose);
  Object.assign(state, { observer, events, schedule, onReady, onClose });
  // In a headed window Sine can run before SessionStore attaches restored
  // custom window values. Reading/saving sooner would overwrite the old tree
  // with the temporarily flattened startup DOM.
  const nativeReady = Promise.allSettled([
    SessionStore.promiseAllWindowsRestored,
    win.gZenStartup?.promiseInitialized,
    win.gZenWorkspaces.promiseInitialized,
  ]);
  const timeout = new Promise((resolve) => { state.startupTimer = win.setTimeout(resolve, 5000); });
  Promise.race([nativeReady, timeout]).then(() => {
    win.clearTimeout(state.startupTimer);
    if (state.closed) return;
    try {
      const getter = SessionStore.getCustomWindowValue || SessionStore.getWindowValue;
      const parsed = JSON.parse(getter.call(SessionStore, win, KEY) || "[]");
      if (Array.isArray(parsed)) saved = parsed.filter((record) => record && typeof record.id === "string" && typeof record.workspaceId === "string" &&
        (record.parentId === null || typeof record.parentId === "string") && Number.isInteger(record.index) && record.index >= 0 && typeof record.collapsed === "boolean");
    } catch { /* A fresh window has no saved value. */ }
    state.started = true;
    deadline = Date.now() + 5000;
    state.retry = win.setTimeout(restore, 0);
  });
};

export const teardownGroupState = (win) => {
  const state = win?._zaoGroupState;
  if (!state) return;
  saveGroupState(win);
  state.closed = true;
  state.resolveReady();
  win.clearTimeout(state.timer);
  win.clearTimeout(state.retry);
  win.clearTimeout(state.startupTimer);
  state.observer.disconnect();
  for (const name of state.events) win.removeEventListener(name, state.schedule);
  win.removeEventListener("SSWindowStateReady", state.onReady);
  win.removeEventListener("beforeunload", state.onClose);
  delete win._zaoGroupState;
};
