import { getTabTitle, getTabUrl, getHostname } from "./tabs.mjs";
import { matchesDomain } from "./pass1.mjs";
import { GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";

const excluded = (tab) => tab.hasAttribute("zen-essential") || tab.hasAttribute("zen-glance-tab");
const placeholder = (tab) => tab.hasAttribute("zen-empty-tab");
const tabInfo = (tab) => {
  const url = getTabUrl(tab);
  return { title: getTabTitle(tab), hostname: getHostname(url), url, _tab: tab };
};
const membersOf = (node) => node.matches("tab") ? [node] : [...node.querySelectorAll("tab")];

export const snapshotWorkspaceUnits = (win, skipPatterns = []) => {
  const manager = win.gZenWorkspaces;
  // gBrowser.tabs is scoped to the active Space in Zen. allStoredTabs covers
  // this window's inactive Spaces as well; never silently skip their members.
  const liveTabs = new Set([...(manager.allStoredTabs || win.gBrowser.tabs)].filter((tab) => !isSidebarCopy(tab)));
  const units = [];
  const skipped = [];
  const workspaces = manager.getWorkspaces().flatMap((space) => {
    const element = manager.workspaceElement(space.uuid);
    if (!element?.isConnected) return [];
    return [{ id: space.uuid, name: space.name || "", _element: element, examples: [] }];
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
      const members = membersOf(node);
      // Newer Firefox split wrappers are not expanded by older Zen allStoredTabs.
      if (node.matches("tab-split-view-wrapper")) for (const tab of node.tabs || []) {
        if (members.includes(tab) && !isSidebarCopy(tab)) liveTabs.add(tab);
      }
      if (node.matches("tab") && placeholder(node)) continue;
      if (members.some((tab) => !liveTabs.has(tab) || excluded(tab))) continue;
      if (members.some((tab) => tab.getAttribute("zen-workspace-id") !== space.id)) continue;
      const tabs = members.filter((tab) => !placeholder(tab)).map(tabInfo);
      const groups = node.matches(GROUP_SELECTOR) ? [node, ...node.querySelectorAll(GROUP_SELECTOR)] : [];
      const kind = node.isZenFolder ? "folder" :
        node.hasAttribute("split-view-group") || node.matches("tab-split-view-wrapper") ? "split-view" :
          node.matches("tab") ? "tab" : "group";
      const unit = {
        id: `unit_${units.length + skipped.length}`, kind,
        name: node.getAttribute("label") || (kind === "tab" ? tabs[0]?.title : "") || "Unbenannt",
        workspaceId: space.id, tabs, groupNames: groups.slice(1).map((group) => group.getAttribute("label") || ""),
        pinned: Boolean(node.pinned || node.isZenFolder || space._element.pinnedTabsContainer?.contains(node)),
        _node: node, _parent: node.parentElement, _tabs: members,
        _memberParents: members.map((tab) => tab.parentElement),
        _groups: groups.map((group) => ({ node: group, parent: group.parentElement, name: group.getAttribute("label") })),
      };
      // Skip a complete tree if even one real member is on the skip list.
      if (tabs.some((tab) => skipPatterns.some((pattern) => matchesDomain(tab.hostname, pattern)))) {
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
  const members = membersOf(node);
  if (members.length !== unit._tabs.length || members.some((tab, index) =>
    tab !== unit._tabs[index] || tab.parentElement !== unit._memberParents[index] ||
    tab.closing || excluded(tab) || tab.getAttribute("zen-workspace-id") !== unit.workspaceId)) return false;
  if (unit._groups.some(({ node: group, parent, name }) => !group.isConnected ||
    group.parentElement !== parent || group.getAttribute("label") !== name)) return false;
  if (unit.tabs.some((tab) => getTabUrl(tab._tab) !== tab.url)) return false;
  return node.matches("tab") || node.getAttribute("zen-workspace-id") === unit.workspaceId ||
    members.every((tab) => tab.getAttribute("zen-workspace-id") === unit.workspaceId);
};

const appendInSection = (container, node) => {
  const items = [...container.children].filter((child) => child !== node && child.matches(`tab, ${GROUP_SELECTOR}`) && !isSidebarCopy(child));
  const last = items.at(-1);
  if (last) container.insertBefore(node, last.nextSibling);
  else {
    const boundary = [...container.children].find((child) => child.matches(".pinned-tabs-container-separator, #tabbrowser-arrowscrollbox-periphery"));
    container.insertBefore(node, boundary || null);
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
  if (!workspaceUnitIsUnchanged(unit)) throw new Error("Element wurde während der Berechnung verändert");
  const target = manager.workspaceElement(targetId);
  if (!target?.isConnected || !manager.getWorkspaces().some((space) => space.uuid === targetId)) throw new Error("Ziel-Space existiert nicht mehr");
  const container = unit.pinned ? target.pinnedTabsContainer : target.tabsContainer;
  if (!container || typeof browser.zenHandleTabMove !== "function") throw new Error("Zen unterstützt diesen Transfer nicht");
  const node = unit._node;
  const previousNext = node.nextSibling;
  const oldIds = [node, ...unit._groups.map(({ node: group }) => group), ...unit._tabs]
    .map((element) => [element, element.getAttribute("zen-workspace-id")]);
  const mutate = () => {
    if (unit.kind === "folder") {
      if (typeof win.gZenFolders?.changeFolderToSpace !== "function") throw new Error("Zen-Ordnertransfer nicht verfügbar");
      // Native recursive folder bookkeeping, without a workspace switch.
      win.gZenFolders.changeFolderToSpace(node, targetId, { hasDndSwitch: true });
    }
    for (const { node: group } of unit._groups) group.setAttribute("zen-workspace-id", targetId);
    for (const tab of unit._tabs) tab.setAttribute("zen-workspace-id", targetId);
    appendInSection(container, node);
  };
  try {
    if (unit.kind === "tab") {
      manager.moveTabToWorkspace(node, targetId);
      // Zen's placement preference may insert at the top; incoming units append.
      browser.zenHandleTabMove(node, () => appendInSection(container, node));
    } else if (node.tabs?.length) {
      browser.zenHandleTabMove(node, mutate);
    } else {
      // The native wrapper indexes tabs[0] and cannot handle an empty group.
      mutate();
      browser.tabContainer._invalidateCachedTabs();
      node.dispatchEvent(new win.CustomEvent("TabGroupMoved", { bubbles: true }));
    }
    if (!workspaceUnitIsAtTarget(win, unit, targetId)) throw new Error("Zen hat den Transfer nicht vollständig ausgeführt");
  } catch (error) {
    if (!workspaceUnitIsAtTarget(win, unit, targetId)) {
      // A failed attempt must not leave a partially retagged folder tree.
      // This only restores this synchronous operation, never later user edits.
      for (const [element, id] of oldIds) {
        if (id === null) element.removeAttribute("zen-workspace-id");
        else element.setAttribute("zen-workspace-id", id);
      }
      unit._parent.insertBefore(node, previousNext?.parentNode === unit._parent ? previousNext : null);
      browser.tabContainer._invalidateCachedTabs();
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
