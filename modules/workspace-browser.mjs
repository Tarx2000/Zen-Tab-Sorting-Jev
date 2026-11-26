import { getTabTitle, getTabUrl, getHostname } from "./tabs.mjs";
import { matchesDomain } from "./pass1.mjs";
import { GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";
import { t } from "./i18n.mjs";

const isEssential = (tab) => tab.hasAttribute("zen-essential");
const isGlance = (tab) => tab.hasAttribute("zen-glance-tab");
const excluded = (tab) => isEssential(tab) || isGlance(tab);
const placeholder = (tab) => tab.hasAttribute("zen-empty-tab");
const readTabUserContextId = (tab) => {
  const raw = tab?.getAttribute?.("usercontextid") ?? tab?.userContextId ?? 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};
const tabInfo = (tab) => {
  const url = getTabUrl(tab);
  return {
    title: getTabTitle(tab),
    hostname: getHostname(url),
    url,
    userContextId: readTabUserContextId(tab),
    _tab: tab,
  };
};
const membersOf = (node) => node.matches("tab") ? [node] : [...node.querySelectorAll("tab")];

export const isWorkspaceContainerCompatible = (unit, space, { respectContainers = true } = {}) => {
  if (!respectContainers || !unit || !space) return true;
  // Staying in the unit's current Space is always valid.
  if (space.id === unit.workspaceId) return true;
  const spaceContainer = Number(space.containerTabId) || 0;
  // Unpinned Spaces (containerTabId === 0) accept any unit.
  if (spaceContainer === 0) return true;
  const unitContainers = Array.isArray(unit.userContextIds)
    ? unit.userContextIds
    : (Array.isArray(unit.tabs) && unit.tabs.length > 0
      ? [...new Set(unit.tabs.map((tab) => Number(tab?.userContextId) || 0))]
      : [Number(unit.originContainerTabId) || 0]);
  if (unitContainers.length === 0) return true;
  return unitContainers.every((id) => id === spaceContainer);
};

const isRealSectionItem = (node) =>
  node.matches?.(`tab, ${GROUP_SELECTOR}`) &&
  !node.hasAttribute?.("zen-empty-tab") &&
  !node.hasAttribute?.("zen-glance-tab") &&
  !isSidebarCopy(node);

const collectSplitWrappers = (node) => {
  const wrappers = [];
  if (node.matches?.("tab-split-view-wrapper")) wrappers.push(node);
  if (typeof node.querySelectorAll === "function") {
    for (const nested of node.querySelectorAll("tab-split-view-wrapper")) {
      wrappers.push(nested);
    }
  }
  return wrappers;
};

const getSplitViewWorkspaceSync = (win) => {
  const splitter = win?.gZenViewSplitter;
  if (!splitter) return { supported: true, sync: null };
  if (typeof splitter.moveSplitViewToWorkspace === "function") {
    return { supported: true, sync: (node, targetId) => splitter.moveSplitViewToWorkspace(node, targetId) };
  }
  if (typeof splitter.changeSplitViewToSpace === "function") {
    return { supported: true, sync: (node, targetId) => splitter.changeSplitViewToSpace(node, targetId) };
  }
  if (typeof splitter.syncWorkspaceForTabs === "function") {
    return { supported: true, sync: (_node, targetId, tabs) => splitter.syncWorkspaceForTabs(tabs, targetId) };
  }
  // Native zenHandleTabMove + zen-workspace-id retagging moves Split Views
  // cleanly across Spaces even when gZenViewSplitter has no dedicated method.
  return { supported: true, sync: null };
};

export const snapshotWorkspaceUnits = (win, skipPatterns = []) => {
  const manager = win.gZenWorkspaces;
  // gBrowser.tabs is scoped to the active Space in Zen. allStoredTabs covers
  // this window's inactive Spaces as well; never silently skip their members.
  const liveTabs = new Set([...(manager.allStoredTabs || win.gBrowser.tabs)].filter((tab) => !isSidebarCopy(tab)));
  const units = [];
  const skipped = [];
  const workspaces = (manager.getWorkspaces?.() || []).flatMap((space) => {
    const element = manager.workspaceElement(space.uuid);
    if (!element?.isConnected) return [];
    const rawContainer = Number(space.containerTabId);
    const containerTabId = Number.isInteger(rawContainer) && rawContainer > 0 ? rawContainer : 0;
    return [{ id: space.uuid, name: space.name || "", containerTabId, _element: element, examples: [] }];
  });
  for (const space of workspaces) {
    const containers = [space._element.pinnedTabsContainer, space._element.tabsContainer].filter(Boolean);
    const candidates = [];
    for (const container of containers) {
      // Walk direct children: a nested tree is owned by its topmost group.
      for (const node of container.children) {
        if (node.matches(`tab, ${GROUP_SELECTOR}`) && !isSidebarCopy(node)) candidates.push(node);
      }
    }
    for (const node of candidates) {
      if (node.matches("tab") && placeholder(node)) continue;
      const members = membersOf(node);
      // Expand liveTabs for both top-level and nested tab-split-view-wrapper nodes
      // inside groups/folders (older Zen allStoredTabs may omit split wrappers).
      for (const wrapper of collectSplitWrappers(node)) {
        for (const tab of wrapper.tabs || []) {
          if (members.includes(tab) && !isSidebarCopy(tab)) liveTabs.add(tab);
        }
      }
      // Filter placeholder tabs BEFORE liveTabs and zen-workspace-id checks.
      const realMembers = members.filter((tab) => !placeholder(tab));
      if (realMembers.some((tab) => !liveTabs.has(tab) || isEssential(tab))) continue;
      if (realMembers.some((tab) => tab.getAttribute("zen-workspace-id") !== space.id)) continue;

      const tabs = realMembers.map(tabInfo);
      const groups = node.matches(GROUP_SELECTOR) ? [node, ...node.querySelectorAll(GROUP_SELECTOR)] : [];
      const kind = node.isZenFolder ? "folder" :
        node.hasAttribute("split-view-group") || node.matches("tab-split-view-wrapper") ? "split-view" :
          node.matches("tab") ? "tab" : "group";
      const inPinnedContainer = Boolean(space._element.pinnedTabsContainer?.contains?.(node));
      const inRegularContainer = Boolean(space._element.tabsContainer?.contains?.(node));
      const userContextIds = [...new Set(tabs.map((tab) => tab.userContextId))];
      const unit = {
        id: `unit_${units.length + skipped.length}`,
        kind,
        name: node.getAttribute("label") || (kind === "tab" ? tabs[0]?.title : "") || "Unbenannt",
        workspaceId: space.id,
        originContainerTabId: space.containerTabId,
        userContextIds,
        tabs,
        groupNames: groups.slice(1).map((group) => group.getAttribute("label") || ""),
        pinned: inPinnedContainer || (!inRegularContainer && Boolean(node.pinned)),
        _node: node,
        _parent: node.parentElement,
        _tabs: realMembers,
        _memberParents: realMembers.map((tab) => tab.parentElement),
        _groups: groups.map((group) => ({
          node: group,
          parent: group.parentElement,
          name: group.getAttribute("label"),
          collapsed: Boolean(group.collapsed),
        })),
      };

      // Record Glance-blocked units in skipped rather than silently dropping them.
      if (realMembers.some(isGlance)) {
        unit.skipReason = "glance";
        skipped.push(unit);
        continue;
      }

      // Skip a complete tree if even one real member is on the skip list.
      if (tabs.some((tab) => skipPatterns.some((pattern) => matchesDomain(tab.hostname, pattern)))) {
        unit.skipReason = "skip-domain";
        skipped.push(unit);
      } else {
        units.push(unit);
        space.examples.push(...tabs);
      }
    }
  }
  return { workspaces, units, skipped };
};

export const workspaceUnitIsUnchanged = (unit) => {
  const node = unit._node;
  if (!node?.isConnected || node.parentElement !== unit._parent || isSidebarCopy(node)) return false;
  const members = membersOf(node).filter((tab) => !placeholder(tab));
  if (members.length !== unit._tabs.length || members.some((tab, index) =>
    tab !== unit._tabs[index] || tab.parentElement !== unit._memberParents[index] ||
    tab.closing || excluded(tab) || tab.getAttribute("zen-workspace-id") !== unit.workspaceId)) return false;
  if (unit._groups.some(({ node: group, parent, name }) => !group.isConnected ||
    group.parentElement !== parent || group.getAttribute("label") !== name)) return false;
  if (unit.tabs.some((tab) => getTabUrl(tab._tab) !== tab.url)) return false;
  return node.matches("tab") || node.getAttribute("zen-workspace-id") === unit.workspaceId ||
    members.every((tab) => tab.getAttribute("zen-workspace-id") === unit.workspaceId);
};

const isAlreadyLastInSection = (container, node) => {
  if (!container || node.parentElement !== container) return false;
  const items = [...container.children].filter((child) => isRealSectionItem(child));
  return items.at(-1) === node;
};

const appendInSection = (container, node) => {
  const items = [...container.children].filter((child) => child !== node && isRealSectionItem(child));
  const last = items.at(-1);
  if (last) {
    if (last.nextSibling !== node) container.insertBefore(node, last.nextSibling);
  } else {
    const boundary = [...container.children].find((child) =>
      child.matches?.(".pinned-tabs-container-separator, #tabbrowser-arrowscrollbox-periphery"),
    );
    if (boundary !== node) container.insertBefore(node, boundary || null);
  }
};

const restoreCollapsedStates = (states) => {
  for (const [group, wasCollapsed] of states) {
    try {
      if (group?.isConnected && Boolean(group.collapsed) !== wasCollapsed) {
        group.collapsed = wasCollapsed;
      }
    } catch {}
  }
};

export const workspaceUnitIsAtTarget = (win, unit, targetId) => {
  const space = win.gZenWorkspaces.workspaceElement(targetId);
  const container = unit.pinned ? space?.pinnedTabsContainer : space?.tabsContainer;
  return Boolean(container && unit._node.parentElement === container &&
    unit._tabs.every((tab) => tab.isConnected && tab.getAttribute("zen-workspace-id") === targetId) &&
    (!unit._groups.length || unit._groups.every(({ node }) => node.getAttribute("zen-workspace-id") === targetId)));
};

export const moveWorkspaceUnit = (win, unit, targetId) => {
  const manager = win.gZenWorkspaces;
  const browser = win.gBrowser;
  if (workspaceUnitIsAtTarget(win, unit, targetId)) return;
  if (!workspaceUnitIsUnchanged(unit)) throw new Error(t("error.elementChanged", null, win));
  const target = manager.workspaceElement(targetId);
  if (!target?.isConnected || !(manager.getWorkspaces?.() || []).some((space) => space.uuid === targetId)) {
    throw new Error(t("error.targetSpaceMissing", null, win));
  }
  const container = unit.pinned ? target.pinnedTabsContainer : target.tabsContainer;
  if (!container || typeof browser.zenHandleTabMove !== "function") {
    throw new Error(t("error.transferUnsupported", null, win));
  }

  const splitSync = unit.kind === "split-view" ? getSplitViewWorkspaceSync(win).sync : null;

  const node = unit._node;
  const previousNext = node.nextSibling;
  const collapsedSnapshot = unit._groups.map(({ node: group }) => [group, Boolean(group.collapsed)]);
  const oldIds = [node, ...unit._groups.map(({ node: group }) => group), ...unit._tabs]
    .map((element) => [element, element.getAttribute("zen-workspace-id")]);

  let nativeFolderMoved = false;
  let nativeTabMoved = false;

  const mutate = () => {
    if (unit.kind === "folder") {
      if (typeof win.gZenFolders?.changeFolderToSpace !== "function") {
        throw new Error(t("error.folderTransferUnavailable", null, win));
      }
      // Native recursive folder bookkeeping, without a workspace switch.
      win.gZenFolders.changeFolderToSpace(node, targetId, { hasDndSwitch: true });
      nativeFolderMoved = true;
    }
    for (const { node: group } of unit._groups) group.setAttribute("zen-workspace-id", targetId);
    for (const tab of unit._tabs) tab.setAttribute("zen-workspace-id", targetId);
    if (splitSync) {
      try { splitSync(node, targetId, unit._tabs); } catch {}
    }
    appendInSection(container, node);
  };

  try {
    if (unit.kind === "tab") {
      manager.moveTabToWorkspace(node, targetId);
      nativeTabMoved = true;
      // Avoid redundant double-move when Zen already placed the tab at the section end.
      if (!isAlreadyLastInSection(container, node)) {
        browser.zenHandleTabMove(node, () => appendInSection(container, node));
      }
    } else if (node.tabs?.length) {
      browser.zenHandleTabMove(node, mutate);
    } else {
      // The native wrapper indexes tabs[0] and cannot handle an empty group.
      mutate();
      browser.tabContainer._invalidateCachedTabs?.();
      node.dispatchEvent(new win.CustomEvent("TabGroupMoved", { bubbles: true }));
    }
    restoreCollapsedStates(collapsedSnapshot);
    if (!workspaceUnitIsAtTarget(win, unit, targetId)) {
      throw new Error(t("error.transferIncomplete", null, win));
    }
  } catch (error) {
    if (!workspaceUnitIsAtTarget(win, unit, targetId)) {
      // Real rollback via Zen APIs wrapped in try/catch so a partial transfer
      // never leaves corrupted folder/tab/workspace metadata behind.
      // Only invoke native Zen rollback APIs when the corresponding forward API call succeeded.
      try {
        if (nativeFolderMoved && unit.kind === "folder" && typeof win.gZenFolders?.changeFolderToSpace === "function") {
          try { win.gZenFolders.changeFolderToSpace(node, unit.workspaceId, { hasDndSwitch: true }); } catch {}
        } else if (nativeTabMoved && unit.kind === "tab" && typeof manager.moveTabToWorkspace === "function") {
          try { manager.moveTabToWorkspace(node, unit.workspaceId); } catch {}
        }
        for (const [element, id] of oldIds) {
          try {
            if (id === null) element.removeAttribute("zen-workspace-id");
            else element.setAttribute("zen-workspace-id", id);
          } catch {}
        }
        if (splitSync) {
          try { splitSync(node, unit.workspaceId, unit._tabs); } catch {}
        }
        const needsDomRestore =
          Boolean(unit._parent?.isConnected) &&
          (node.parentNode !== unit._parent ||
            (previousNext?.parentNode === unit._parent && node.nextSibling !== previousNext));
        if (needsDomRestore) {
          const restoreDom = () => {
            const anchor = previousNext?.parentNode === unit._parent ? previousNext : null;
            if (anchor !== node) unit._parent.insertBefore(node, anchor);
          };
          if (node.tabs?.length && typeof browser.zenHandleTabMove === "function") {
            try { browser.zenHandleTabMove(node, restoreDom); } catch { restoreDom(); }
          } else {
            restoreDom();
          }
        }
        restoreCollapsedStates(collapsedSnapshot);
        browser.tabContainer?._invalidateCachedTabs?.();
      } catch {}
      throw error;
    }
  }

  for (const [id, selected] of Object.entries(manager.lastSelectedWorkspaceTabs || {})) {
    if (id !== targetId && unit._tabs.includes(selected)) delete manager.lastSelectedWorkspaceTabs[id];
  }
  unit._parent.closest?.("zen-workspace")?.checkPinsExistence?.();
  target.checkPinsExistence?.();
  // Keep existing browser/container identities; never reopen the URLs.
  for (const tab of unit._tabs) {
    if (tab.linkedBrowser) Promise.resolve(browser.TabStateFlusher?.flush?.(tab.linkedBrowser)).catch(() => {});
  }
};

/**
 * Capture pre-mutation positions, workspace IDs, and collapse states for 1-click Undo.
 */
export const captureUndoSnapshot = (win, plannedMoves = []) => ({
  createdAt: Date.now(),
  entries: plannedMoves.map(({ unit, toWorkspaceId }) => ({
    id: unit.id,
    name: unit.name,
    kind: unit.kind,
    fromWorkspaceId: unit.workspaceId,
    toWorkspaceId,
    pinned: Boolean(unit.pinned),
    node: unit._node,
    parent: unit._parent,
    previousNext: unit._node?.nextSibling || null,
    tabs: [...(unit._tabs || [])],
    groups: (unit._groups || []).map(({ node: group }) => ({
      node: group,
      collapsed: Boolean(group?.collapsed),
    })),
  })),
});

/**
 * Restore a previously captured undo snapshot in reverse order using Zen APIs.
 */
export const restoreUndoSnapshot = (win, snapshot) => {
  const result = { restored: 0, failed: 0, errors: [] };
  if (!win || !snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
    return result;
  }

  const manager = win.gZenWorkspaces;
  const browser = win.gBrowser;
  if (!manager || !browser) return result;

  const touchedWorkspaces = new Set();
  const splitSupport = getSplitViewWorkspaceSync(win);

  // Restore in reverse move order so sibling anchors remain valid.
  for (let i = snapshot.entries.length - 1; i >= 0; i--) {
    const entry = snapshot.entries[i];
    const node = entry.node;
    const originSpace = manager.workspaceElement?.(entry.fromWorkspaceId);
    const originContainer = entry.parent?.isConnected
      ? entry.parent
      : (entry.pinned ? originSpace?.pinnedTabsContainer : originSpace?.tabsContainer);

    if (!node?.isConnected || !originSpace?.isConnected || !originContainer) {
      result.failed += 1;
      result.errors.push({ id: entry.id, name: entry.name, reason: t("error.targetSpaceMissing", null, win) });
      continue;
    }

    const collapsedSnapshot = entry.groups.map(({ node: group, collapsed }) => [group, collapsed]);
    const placeBack = () => {
      if (entry.kind === "folder" && typeof win.gZenFolders?.changeFolderToSpace === "function") {
        win.gZenFolders.changeFolderToSpace(node, entry.fromWorkspaceId, { hasDndSwitch: true });
      }
      for (const { node: group } of entry.groups) {
        if (group?.isConnected) group.setAttribute("zen-workspace-id", entry.fromWorkspaceId);
      }
      for (const tab of entry.tabs) {
        if (tab?.isConnected) tab.setAttribute("zen-workspace-id", entry.fromWorkspaceId);
      }
      if (entry.kind === "split-view" && splitSupport.sync) {
        try { splitSupport.sync(node, entry.fromWorkspaceId, entry.tabs); } catch {}
      }
      if (entry.previousNext?.parentNode === originContainer && entry.previousNext !== node) {
        originContainer.insertBefore(node, entry.previousNext);
      } else {
        appendInSection(originContainer, node);
      }
    };

    try {
      if (entry.kind === "tab") {
        manager.moveTabToWorkspace?.(node, entry.fromWorkspaceId);
        if (typeof browser.zenHandleTabMove === "function") {
          browser.zenHandleTabMove(node, placeBack);
        } else {
          placeBack();
        }
      } else if (node.tabs?.length && typeof browser.zenHandleTabMove === "function") {
        browser.zenHandleTabMove(node, placeBack);
      } else {
        placeBack();
        browser.tabContainer?._invalidateCachedTabs?.();
        node.dispatchEvent?.(new win.CustomEvent("TabGroupMoved", { bubbles: true }));
      }
      restoreCollapsedStates(collapsedSnapshot);
      touchedWorkspaces.add(entry.fromWorkspaceId);
      touchedWorkspaces.add(entry.toWorkspaceId);
      for (const tab of entry.tabs) {
        if (tab?.linkedBrowser) {
          Promise.resolve(browser.TabStateFlusher?.flush?.(tab.linkedBrowser)).catch(() => {});
        }
      }
      result.restored += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({ id: entry.id, name: entry.name, reason: error?.message || t("error.transferFailed", null, win) });
    }
  }

  try { browser.tabContainer?._invalidateCachedTabs?.(); } catch {}
  try { manager.updateTabsContainers?.(); } catch {}
  for (const wsId of touchedWorkspaces) {
    try { manager.workspaceElement?.(wsId)?.checkPinsExistence?.(); } catch {}
  }

  return result;
};
