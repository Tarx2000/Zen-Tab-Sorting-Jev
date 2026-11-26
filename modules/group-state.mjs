// Firefox persists normal group IDs but Zen can drop their Space/parent metadata.
// Window values keep this repair scoped to the same window across session restore.
import { GROUP_SELECTOR, NORMAL_GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";
import { savedGroupColorStrength, applyGroupColorStrength } from "./group-appearance.mjs";

const KEY = "zen-tab-sorting-groups-v1";
const UNRESOLVED_TTL_MS = 24 * 60 * 60 * 1000;
const STABLE_TICKS_REQUIRED = 2;

const getWorkspacesSafe = (win) => {
  try {
    const spaces = win?.gZenWorkspaces?.getWorkspaces?.();
    return Array.isArray(spaces) ? spaces : [];
  } catch {
    return [];
  }
};

const groupsInWindow = (win) => getWorkspacesSafe(win).flatMap((space) => {
  const element = win.gZenWorkspaces?.workspaceElement?.(space.uuid);
  return [...(element?.querySelectorAll?.(NORMAL_GROUP_SELECTOR) || [])].filter((group) => !isSidebarCopy(group));
});

const itemsIn = (container) => {
  if (!container?.children) return [];
  return [...container.children].filter((node) => node.matches?.(`tab, ${GROUP_SELECTOR}`) && !isSidebarCopy(node));
};

const isRelevantMutation = (mutation) => {
  const target = mutation?.target;
  if (!target || isSidebarCopy(target)) return false;

  if (mutation.type === "attributes") {
    return Boolean(target.matches?.(`${GROUP_SELECTOR}, zen-workspace`));
  }

  if (mutation.type === "childList") {
    if (
      target.matches?.(`zen-workspace, .zen-workspace-tabs-section, ${GROUP_SELECTOR}`) ||
      target.classList?.contains?.("tab-group-container")
    ) {
      return true;
    }
    const checkNodes = (nodes) => {
      for (const node of nodes || []) {
        if (node?.nodeType !== 1 || isSidebarCopy(node)) continue;
        if (node.matches?.(GROUP_SELECTOR) || node.querySelector?.(GROUP_SELECTOR)) return true;
      }
      return false;
    };
    return checkNodes(mutation.addedNodes) || checkNodes(mutation.removedNodes);
  }

  return false;
};

export const saveGroupState = (win) => {
  const state = win?._zaoGroupState;
  if (!state || state.restoring) return true;
  try {
    const itemsByContainer = new Map();
    const getItems = (container) => {
      if (!container) return [];
      let cached = itemsByContainer.get(container);
      if (!cached) {
        cached = itemsIn(container);
        itemsByContainer.set(container, cached);
      }
      return cached;
    };

    const liveIds = new Set();
    const records = groupsInWindow(win)
      .filter((group) => group.id)
      .map((group) => {
        liveIds.add(group.id);
        const spaceEl = group.closest?.("zen-workspace");
        const workspaceId = spaceEl?.id || group.getAttribute("zen-workspace-id");
        return {
          id: group.id,
          workspaceId,
          parentId: group.group?.id || null,
          index: Math.max(0, getItems(group.parentElement).indexOf(group)),
          collapsed: Boolean(group.collapsed),
          pinned: Boolean(spaceEl?.pinnedTabsContainer?.contains?.(group)),
          colorStrength: savedGroupColorStrength(group),
        };
      });

    // Retain recently unresolved saved records (bounded by TTL) so slow session
    // restores never permanently lose group metadata on timeout.
    const now = Date.now();
    if (Array.isArray(state.unresolvedRecords) && state.unresolvedRecords.length > 0) {
      state.unresolvedRecords = state.unresolvedRecords.filter(
        (record) => !liveIds.has(record.id) && (!record.unresolvedUntil || record.unresolvedUntil > now),
      );
      for (const pending of state.unresolvedRecords) {
        records.push(pending);
      }
    }

    const serialized = JSON.stringify(records);
    if (serialized === state.lastSavedJson) return true;

    const setter = state.store.setCustomWindowValue || state.store.setWindowValue;
    setter.call(state.store, win, KEY, serialized);
    state.lastSavedJson = serialized;
    return true;
  } catch {
    return false;
  }
};

export const setupGroupState = (win) => {
  if (win._zaoGroupState) return;
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  let saved = [];
  const state = {
    store: SessionStore,
    restoring: true,
    started: false,
    ssReady: false,
    lastFoundCount: -1,
    stableTicks: 0,
    lastSavedJson: null,
    unresolvedRecords: [],
    timer: null,
    retry: null,
    startupTimer: null,
    closed: false,
  };
  state.ready = new Promise((resolve) => { state.resolveReady = resolve; });
  win._zaoGroupState = state;
  let deadline;

  const restore = () => {
    if (state.closed) {
      state.restoring = false;
      state.resolveReady();
      return;
    }

    let willRetry = false;
    try {
      const groups = new Map(groupsInWindow(win).map((group) => [group.id, group]));
      const byId = new Map(saved.map((record) => [record.id, record]));
      const depthMemo = new Map();

      // A parent always goes first. Ignore corrupt/cyclic saved relationships.
      const depth = (record) => {
        if (depthMemo.has(record.id)) return depthMemo.get(record.id);
        let current = record;
        const visited = new Set([record.id]);
        let level = 0;
        while (current.parentId) {
          if (visited.has(current.parentId)) {
            depthMemo.set(record.id, 1000);
            return 1000;
          }
          if (depthMemo.has(current.parentId)) {
            const parentDepth = depthMemo.get(current.parentId);
            const total = parentDepth >= 1000 ? 1000 : level + 1 + parentDepth;
            depthMemo.set(record.id, total);
            return total;
          }
          visited.add(current.parentId);
          current = byId.get(current.parentId);
          if (!current) break;
          level++;
        }
        depthMemo.set(record.id, level);
        return level;
      };

      const collapsed = new Map();
      for (const record of [...saved].sort((a, b) => depth(a) - depth(b) || a.index - b.index)) {
        const group = groups.get(record.id);
        const space = win.gZenWorkspaces?.workspaceElement?.(record.workspaceId);
        if (!group || !space || depth(record) >= 1000) continue;
        const parent = record.parentId
          ? groups.get(record.parentId) || win.document.getElementById(record.parentId)
          : null;
        if (
          record.parentId &&
          (!parent || isSidebarCopy(parent) || group.contains(parent) || parent.closest?.("zen-workspace")?.id !== record.workspaceId)
        ) {
          continue;
        }
        const container = parent
          ? parent.groupContainer
          : (record.pinned && space.pinnedTabsContainer) || space.tabsContainer;
        if (!container) continue;

        const tabs = [...group.querySelectorAll("tab")];
        const currentSiblings = itemsIn(container);
        const siblingsWithoutGroup = currentSiblings.filter((node) => node !== group);
        const targetIndex = Math.min(Math.max(0, record.index), siblingsWithoutGroup.length);
        const currentIndex = currentSiblings.indexOf(group);
        const relocating = group.parentElement !== container;
        const needsPositionFix = relocating || currentIndex !== targetIndex;

        const update = () => {
          group.setAttribute("zen-workspace-id", record.workspaceId);
          for (const tab of tabs) tab.setAttribute("zen-workspace-id", record.workspaceId);
          if (needsPositionFix) {
            const siblings = itemsIn(container).filter((node) => node !== group);
            const clampedIndex = Math.min(Math.max(0, record.index), siblings.length);
            const before = siblings[clampedIndex] ||
              [...container.children].find((node) => node.matches?.("#tabbrowser-arrowscrollbox-periphery, .pinned-tabs-container-separator")) ||
              null;
            if (before !== group) container.insertBefore(group, before);
          }
        };

        try {
          if (needsPositionFix && group.tabs?.length && win.gBrowser?.zenHandleTabMove) {
            win.gBrowser.zenHandleTabMove(group, update);
          } else {
            update();
          }
          if (Number.isFinite(record.colorStrength)) applyGroupColorStrength(group, record.colorStrength);
          collapsed.set(group, record.collapsed);
        } catch { /* An unrestorable native group must not block other groups. */ }
      }

      // Reparenting a child can auto-expand its native parent. Restore collapse
      // only after the complete hierarchy has been rebuilt.
      for (const [group, value] of collapsed) {
        try {
          if (group.collapsed !== value) group.collapsed = value;
        } catch { /* Individual collapse failure must not abort restore finalization. */ }
      }

      win.gBrowser?.tabContainer?._invalidateCachedTabs?.();

      const foundCount = saved.reduce((count, record) => count + (groups.has(record.id) ? 1 : 0), 0);
      if (foundCount === state.lastFoundCount) state.stableTicks += 1;
      else {
        state.lastFoundCount = foundCount;
        state.stableTicks = 0;
      }

      const allFound = foundCount === saved.length;
      const settledAfterReady = state.ssReady && state.stableTicks >= STABLE_TICKS_REQUIRED;
      if (!allFound && !settledAfterReady && Date.now() < deadline) {
        willRetry = true;
        state.retry = win.setTimeout(restore, 150);
        return;
      }

      // Preserve any still-unresolved saved records with a bounded TTL instead of
      // overwriting them when startup times out or settles early.
      const now = Date.now();
      state.unresolvedRecords = saved
        .filter((record) => !groups.has(record.id))
        .map((record) => ({
          ...record,
          unresolvedUntil: record.unresolvedUntil || now + UNRESOLVED_TTL_MS,
        }))
        .filter((record) => record.unresolvedUntil > now);
      saved = [];
    } finally {
      if (!willRetry) {
        state.restoring = false;
        saveGroupState(win);
        state.resolveReady();
      }
    }
  };

  const schedule = () => {
    if (state.closed || state.restoring) return;
    win.clearTimeout(state.timer);
    state.timer = win.setTimeout(() => saveGroupState(win), 150);
  };
  const onReady = () => {
    state.ssReady = true;
    if (state.restoring && state.started) {
      win.clearTimeout(state.retry);
      state.retry = win.setTimeout(restore, 0);
    }
  };
  const onClose = () => { if (!state.restoring) saveGroupState(win); };
  const observer = new win.MutationObserver((mutations) => {
    if (mutations.some(isRelevantMutation)) schedule();
  });
  observer.observe(win.gBrowser.tabContainer, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["collapsed", "zen-workspace-id", "data-zao-color-strength"],
  });
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
    win.gZenWorkspaces?.promiseInitialized,
  ]);
  const timeout = new Promise((resolve) => { state.startupTimer = win.setTimeout(resolve, 5000); });
  Promise.race([nativeReady, timeout]).then(() => {
    win.clearTimeout(state.startupTimer);
    if (state.closed) {
      state.restoring = false;
      state.resolveReady();
      return;
    }
    try {
      const getter = SessionStore.getCustomWindowValue || SessionStore.getWindowValue;
      const raw = getter.call(SessionStore, win, KEY) || "[]";
      const parsed = JSON.parse(raw);
      const now = Date.now();
      if (Array.isArray(parsed)) {
        saved = parsed.filter(
          (record) =>
            record &&
            typeof record.id === "string" &&
            typeof record.workspaceId === "string" &&
            (record.parentId === null || typeof record.parentId === "string") &&
            Number.isInteger(record.index) &&
            record.index >= 0 &&
            typeof record.collapsed === "boolean" &&
            (!record.unresolvedUntil || record.unresolvedUntil > now),
        );
      }
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
  state.restoring = false;
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
