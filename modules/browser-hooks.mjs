// Zen Tab Sorting — browser-context event hooks.
//
// Per-window state is stored in a WeakMap<Window, State> so multi-window
// sessions remain strictly isolated and never leak across closed windows.
//
// Hooks in this file:
//   TabContextMenu      — explicit "Add <host> to Rule…" submenu
//   TabGroupContextMenu — explicit "Dissolve group" entry on normal tab-groups
//   TabGroupCreate      — re-apply rule colors when Zen creates/restores groups
//   CollapsedMigration  — one-time migration from legacy collapsed pref into group-state.mjs
//   MinimalStylePref    — re-run syncAllGroupColors when the user toggles minimal-style

import { CONFIG, LOG, BUILD_VERSION, isZenColorName } from "./config.mjs";
import { getTabUrl, getHostname } from "./tabs.mjs";
import { NORMAL_GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";
import {
  readRulesPref,
  writeRulesPref,
  readSkipDomainsPref,
  writeSkipDomainsPref,
  readCollapsedGroupsPref,
  writeCollapsedGroupsPref,
  isMinimalStyle,
} from "./rules.mjs";
import { applyGroupColor, syncAllGroupColors, moveTabsToTop, directGroupTabs } from "./groups.mjs";
import { saveGroupState } from "./group-state.mjs";
import { t, getLocale } from "./i18n.mjs";
import {
  openMoveToFolderPopover,
  closeMoveToFolderPopover,
  isTabMovableToFolder,
} from "./move-to-folder.mjs";

const WINDOW_STATE = new WeakMap();

const getWindowState = (win = globalThis.window) => {
  if (!win) return null;
  let state = WINDOW_STATE.get(win);
  if (!state) {
    state = {
      contextMenu: null,
      groupContextMenu: null,
      tabGroupCreate: null,
      collapseMigration: null,
      minimalStyleObserver: null,
    };
    WINDOW_STATE.set(win, state);
  }
  return state;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const applyToRule = (tab, groupName, group) => {
  const hostname = getHostname(getTabUrl(tab));
  if (!hostname) return;

  const rules = readRulesPref({ keepIncomplete: true }) || [];
  const rule = rules.find((r) => r.name === groupName);

  if (rule) {
    if (rule.domains.includes(hostname)) {
      console.log(`${LOG} context-menu: "${hostname}" already in "${groupName}"`);
      return;
    }
    rule.domains.push(hostname);
    writeRulesPref(rules);
    console.log(`${LOG} context-menu: added "${hostname}" to existing rule "${groupName}"`);
  } else {
    const newRule = { name: groupName, domains: [hostname] };
    const groupColor = group?.color;
    if (isZenColorName(groupColor)) newRule.color = groupColor;
    rules.push(newRule);
    writeRulesPref(rules);
    console.log(
      `${LOG} context-menu: created new rule "${groupName}" with "${hostname}"` +
        (newRule.color ? ` (color: ${newRule.color})` : ""),
    );
  }
};

// ─── Tab right-click: "Add <host> to Rule…" ─────────────────────────────────

const PARENT_MENU_ID = "zen-tab-sorting-add-to-rule-menu";
const MOVE_TO_FOLDER_MENU_ID = "zen-tab-sorting-move-to-folder-menu";
const MOVE_TO_FOLDER_ITEM_ID = "zen-tab-sorting-move-to-folder-item";

const findContextMenu = (doc) =>
  doc?.getElementById?.("tabContextMenu") ||
  doc?.getElementById?.("zenTabContextMenu") ||
  null;

const getTabHostname = (tab) => {
  if (!tab) return null;
  try { return getHostname(getTabUrl(tab)); } catch { return null; }
};

const resolveMovableTargetTabs = (win, contextTab) => {
  if (!contextTab) return [];
  let selected = [];
  try {
    selected = Array.isArray(win?.gBrowser?.selectedTabs) ? win.gBrowser.selectedTabs : [];
  } catch {
    selected = [];
  }
  const source = selected.length > 1 && selected.includes(contextTab) ? selected : [contextTab];
  return source.filter(isTabMovableToFolder);
};

const formatMoveToFolderLabel = (count, win) => {
  if (count <= 1) return t("menu.moveToFolder", null, win);
  return getLocale(win) === "de"
    ? `${count} Tabs in Ordner verschieben …`
    : `Move ${count} tabs to Folder…`;
};

export const setupTabContextMenu = (win = globalThis.window) => {
  const state = getWindowState(win);
  const doc = win?.document;
  if (!state || !doc || state.contextMenu) return;

  const menu = findContextMenu(doc);
  if (!menu) {
    console.warn(`${LOG} tab context menu not found — context menu integration skipped`);
    return;
  }

  // Remove stale elements if re-initializing after a dev reload.
  doc.getElementById(PARENT_MENU_ID)?.remove?.();
  doc.getElementById(MOVE_TO_FOLDER_MENU_ID)?.remove?.();
  doc.getElementById(MOVE_TO_FOLDER_ITEM_ID)?.remove?.();

  const parent = doc.createXULElement("menu");
  parent.id = PARENT_MENU_ID;
  parent.setAttribute("label", t("menu.addToRule", null, win));
  parent.setAttribute("hidden", "true");

  const popup = doc.createXULElement("menupopup");
  parent.appendChild(popup);
  menu.appendChild(parent);

  // "Move to Folder…" entry opening the searchable Quick-Pick Popover (Q3 & Q8).
  const moveItem = doc.createXULElement("menuitem");
  moveItem.id = MOVE_TO_FOLDER_ITEM_ID;
  moveItem.setAttribute("label", t("menu.moveToFolder", null, win));
  moveItem.setAttribute("hidden", "true");
  menu.appendChild(moveItem);

  let currentTab = null;
  let currentHostname = null;
  let currentTargetTabs = [];
  let lastAnchorPoint = null;

  const onContextPoint = (e) => {
    if (typeof e.clientX === "number" && typeof e.clientY === "number") {
      lastAnchorPoint = { x: e.clientX, y: e.clientY };
    }
  };

  const onOuterShowing = (e) => {
    if (e.target !== menu) return;
    currentTab = win.TabContextMenu?.contextTab || win.gBrowser?.selectedTab || null;
    currentHostname = getTabHostname(currentTab);

    if (!currentTab || !currentHostname) {
      parent.hidden = true;
    } else {
      parent.hidden = false;
      parent.setAttribute("label", t("menu.addHostToRule", { host: currentHostname }, win));
    }

    currentTargetTabs = resolveMovableTargetTabs(win, currentTab);
    const canMove = currentTargetTabs.length > 0;
    moveItem.hidden = !canMove;
    if (canMove) {
      moveItem.setAttribute("label", formatMoveToFolderLabel(currentTargetTabs.length, win));
    }
  };

  const onOuterHidden = (e) => {
    if (e.target !== menu) return;
    // Release tab DOM references after command dispatch completes.
    (win.setTimeout || setTimeout)(() => {
      currentTab = null;
      currentHostname = null;
      currentTargetTabs = [];
    }, 0);
  };

  const onSubmenuShowing = () => {
    while (popup.firstChild) popup.firstChild.remove();
    const allRules = readRulesPref({ keepIncomplete: true }) || [];
    const rules = allRules.filter((r) => r.name && r.name.length > 0);
    const skipList = readSkipDomainsPref() || [];
    if (rules.length === 0) {
      const placeholder = doc.createXULElement("menuitem");
      placeholder.setAttribute("label", t("menu.noRulesYet", null, win));
      placeholder.setAttribute("disabled", "true");
      popup.appendChild(placeholder);
    } else {
      for (const rule of rules) {
        const item = doc.createXULElement("menuitem");
        const inRule = currentHostname && rule.domains.includes(currentHostname);
        item.setAttribute("label", inRule ? `✓ ${rule.name}` : rule.name);
        if (inRule) item.setAttribute("disabled", "true");
        item.dataset.zaoRuleName = rule.name;
        popup.appendChild(item);
      }
    }

    popup.appendChild(doc.createXULElement("menuseparator"));
    const skipItem = doc.createXULElement("menuitem");
    const inSkip = currentHostname && skipList.includes(currentHostname);
    skipItem.setAttribute("label", t(inSkip ? "menu.skipChecked" : "menu.skip", null, win));
    if (inSkip) skipItem.setAttribute("disabled", "true");
    skipItem.dataset.zaoSkip = "true";
    popup.appendChild(skipItem);
  };

  const onCommand = (e) => {
    const item = e.target;
    if (!currentTab || !currentHostname) return;
    if (item?.dataset?.zaoSkip === "true") {
      const skipList = readSkipDomainsPref() || [];
      if (skipList.includes(currentHostname)) return;
      skipList.push(currentHostname);
      writeSkipDomainsPref(skipList);
      console.log(`${LOG} context-menu: added "${currentHostname}" to skip-domains`);
      return;
    }
    const ruleName = item?.dataset?.zaoRuleName;
    if (!ruleName) return;
    const groupEl = currentTab.closest?.(NORMAL_GROUP_SELECTOR);
    applyToRule(currentTab, ruleName, groupEl);
  };

  const onMoveCommand = () => {
    const targets = currentTargetTabs.length
      ? currentTargetTabs.slice()
      : resolveMovableTargetTabs(win, win.TabContextMenu?.contextTab || win.gBrowser?.selectedTab);
    if (targets.length === 0) return;
    const anchor = lastAnchorPoint || targets[0];
    openMoveToFolderPopover(win, targets, anchor);
  };

  menu.addEventListener("popupshowing", onOuterShowing);
  menu.addEventListener("popuphidden", onOuterHidden);
  popup.addEventListener("popupshowing", onSubmenuShowing);
  popup.addEventListener("command", onCommand);
  moveItem.addEventListener("command", onMoveCommand);
  doc.addEventListener("contextmenu", onContextPoint, true);

  state.contextMenu = {
    menu,
    doc,
    parent,
    popup,
    moveItem,
    onOuterShowing,
    onOuterHidden,
    onSubmenuShowing,
    onCommand,
    onMoveCommand,
    onContextPoint,
  };
  console.log(`${LOG} tab context menus installed (build ${BUILD_VERSION})`);
};

export const teardownTabContextMenu = (win = globalThis.window) => {
  closeMoveToFolderPopover(win);
  const state = WINDOW_STATE.get(win);
  const ctx = state?.contextMenu;
  if (!ctx) return;
  try { ctx.menu.removeEventListener("popupshowing", ctx.onOuterShowing); } catch {}
  try { ctx.menu.removeEventListener("popuphidden", ctx.onOuterHidden); } catch {}
  try { ctx.popup.removeEventListener("popupshowing", ctx.onSubmenuShowing); } catch {}
  try { ctx.popup.removeEventListener("command", ctx.onCommand); } catch {}
  try { ctx.moveItem.removeEventListener("command", ctx.onMoveCommand); } catch {}
  try { ctx.doc.removeEventListener("contextmenu", ctx.onContextPoint, true); } catch {}
  if (ctx.parent?.isConnected) try { ctx.parent.remove(); } catch {}
  if (ctx.moveItem?.isConnected) try { ctx.moveItem.remove(); } catch {}
  state.contextMenu = null;
};

// ─── Tab-group right-click: "Dissolve group" ─────────────────────────────────

const TOOLBAR_CONTEXT_MENU_ID = "toolbar-context-menu";

const dissolveTabGroup = (win, group) => {
  if (!group?.isConnected || win?.closed) return;
  const workspaceId = group.closest?.("zen-workspace")?.id ||
    group.getAttribute?.("zen-workspace-id") ||
    win.gZenWorkspaces?.activeWorkspace;
  if (!workspaceId) {
    console.warn(`${LOG} dissolveTabGroup: no workspace resolved`);
    return;
  }
  const tabs = directGroupTabs(group, workspaceId);
  if (tabs.length === 0) {
    if (!group.querySelector("tab")) {
      try { group.remove(); } catch {}
    }
    return;
  }
  const groupName = group.getAttribute?.("label") || t("menu.unnamedGroup", null, win);
  const moved = moveTabsToTop(tabs, workspaceId);
  console.log(`${LOG} dissolved group "${groupName}" — ejected ${moved} tab(s) to top of workspace`);
  const groupRef = typeof WeakRef === "function" ? new WeakRef(group) : { deref: () => group };
  (win.setTimeout || setTimeout)(() => {
    if (win.closed) return;
    const liveGroup = groupRef.deref();
    if (liveGroup?.isConnected && !liveGroup.querySelector("tab")) {
      try { liveGroup.remove(); } catch {}
    }
  }, 50);
};

export const setupTabGroupContextMenu = (win = globalThis.window) => {
  const state = getWindowState(win);
  const doc = win?.document;
  if (!state || !doc || state.groupContextMenu) return;

  const menu = doc.getElementById(TOOLBAR_CONTEXT_MENU_ID);
  if (!menu) {
    console.warn(`${LOG} #${TOOLBAR_CONTEXT_MENU_ID} not found — Dissolve group menuitem not installed`);
    return;
  }

  menu.querySelector?.("#zen-tab-sorting-dissolve-group")?.remove?.();
  menu.querySelector?.("#zen-tab-sorting-dissolve-separator")?.remove?.();

  const separator = doc.createXULElement("menuseparator");
  separator.id = "zen-tab-sorting-dissolve-separator";
  separator.setAttribute("hidden", "true");

  const item = doc.createXULElement("menuitem");
  item.id = "zen-tab-sorting-dissolve-group";
  item.setAttribute("label", t("menu.dissolveGroup", null, win));
  item.setAttribute("hidden", "true");

  menu.prepend(separator);
  menu.prepend(item);

  let pendingGroupRef = null;
  const getPendingGroup = () => {
    const group = pendingGroupRef?.deref?.() || null;
    return group?.isConnected ? group : null;
  };

  const onContextMenuCapture = (e) => {
    const targetEl = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
    const group = targetEl?.closest?.(NORMAL_GROUP_SELECTOR) || null;
    pendingGroupRef = group && !isSidebarCopy(group)
      ? (typeof WeakRef === "function" ? new WeakRef(group) : { deref: () => group })
      : null;
  };

  const onMenuShowing = (e) => {
    if (e.target !== menu) return;
    const group = getPendingGroup();
    const show = Boolean(group);
    item.hidden = !show;
    separator.hidden = !show;
    if (show) {
      const name = group.getAttribute?.("label") || t("menu.unnamedGroup", null, win);
      item.setAttribute("label", t("menu.dissolveNamedGroup", { name }, win));
    }
  };

  const onMenuHidden = (e) => {
    if (e.target !== menu) return;
    pendingGroupRef = null;
  };

  const onMenuItemCommand = () => {
    const group = getPendingGroup();
    pendingGroupRef = null;
    if (!group) {
      console.warn(`${LOG} dissolve clicked but no target group captured`);
      return;
    }
    dissolveTabGroup(win, group);
  };

  menu.addEventListener("popupshowing", onMenuShowing);
  menu.addEventListener("popuphidden", onMenuHidden);
  item.addEventListener("command", onMenuItemCommand);
  doc.addEventListener("contextmenu", onContextMenuCapture, true);

  state.groupContextMenu = {
    menu,
    doc,
    item,
    separator,
    onContextMenuCapture,
    onMenuShowing,
    onMenuHidden,
    onMenuItemCommand,
  };
  console.log(`${LOG} #${TOOLBAR_CONTEXT_MENU_ID}: 'Dissolve group' menuitem installed`);
};

export const teardownTabGroupContextMenu = (win = globalThis.window) => {
  const state = WINDOW_STATE.get(win);
  const ctx = state?.groupContextMenu;
  if (!ctx) return;
  try { ctx.menu.removeEventListener("popupshowing", ctx.onMenuShowing); } catch {}
  try { ctx.menu.removeEventListener("popuphidden", ctx.onMenuHidden); } catch {}
  try { ctx.item.removeEventListener("command", ctx.onMenuItemCommand); } catch {}
  try { ctx.doc.removeEventListener("contextmenu", ctx.onContextMenuCapture, true); } catch {}
  if (ctx.item?.isConnected) try { ctx.item.remove(); } catch {}
  if (ctx.separator?.isConnected) try { ctx.separator.remove(); } catch {}
  state.groupContextMenu = null;
};

// ─── TabGroupCreate color hook ───────────────────────────────────────────────

const applyTabGroupRuleColor = (win, group) => {
  try {
    if (!group?.isConnected || isSidebarCopy(group) || group.hasAttribute?.("split-view-group")) return;
    const label = (group.getAttribute?.("label") || "").trim();
    if (!label) return;

    const rules = readRulesPref() || [];
    const rule = rules.find((r) => String(r?.name || "").trim() === label);
    if (rule?.color) {
      // Defer one tick so Zen's own color setup completes before we override.
      (win.setTimeout || setTimeout)(() => {
        if (!win.closed && group.isConnected) applyGroupColor(group, rule.color);
      }, 0);
    }
  } catch (e) {
    console.error(`${LOG} applyTabGroupRuleColor error:`, e);
  }
};

export const setupTabGroupCreateHook = (win = globalThis.window, { applyExisting = true } = {}) => {
  const state = getWindowState(win);
  const tabContainer = win?.gBrowser?.tabContainer;
  if (!state || !tabContainer || state.tabGroupCreate) return;

  const handler = (event) => applyTabGroupRuleColor(win, event.target);
  tabContainer.addEventListener("TabGroupCreate", handler);
  state.tabGroupCreate = { tabContainer, handler };

  if (applyExisting) {
    const existing = win.document?.querySelectorAll?.(NORMAL_GROUP_SELECTOR) || [];
    if (existing.length > 0) {
      console.log(`${LOG} TabGroupCreate hook: applying rule colors to ${existing.length} pre-existing tab-group(s)`);
      existing.forEach((group) => applyTabGroupRuleColor(win, group));
    }
  }
  console.log(`${LOG} TabGroupCreate hook installed`);
};

export const teardownTabGroupCreateHook = (win = globalThis.window) => {
  const state = WINDOW_STATE.get(win);
  const ctx = state?.tabGroupCreate;
  if (!ctx) return;
  try { ctx.tabContainer.removeEventListener("TabGroupCreate", ctx.handler); } catch {}
  state.tabGroupCreate = null;
};

// ─── Legacy collapsed-groups one-time migration into group-state.mjs ─────────
//
// `group-state.mjs` is now the single authority for group collapse persistence
// via per-window SessionStore values. This hook performs a one-time migration
// of any legacy COLLAPSED_GROUPS_PREF entries after group-state restoration
// completes (no dual-pref race, no per-group MutationObserver churn).

const collapseKey = (group) =>
  `id:${group.id || `${group.getAttribute("zen-workspace-id")}:${group.getAttribute("label")}`}`;

export const setupCollapsedStatePersistence = (win = globalThis.window) => {
  const state = getWindowState(win);
  if (!state || state.collapseMigration) return;

  const token = { cancelled: false };
  state.collapseMigration = token;

  const legacySet = readCollapsedGroupsPref();
  if (!legacySet || legacySet.size === 0) return;

  const waitReady = win._zaoGroupState?.ready || Promise.resolve();
  Promise.resolve(waitReady)
    .then(() => {
      if (token.cancelled || win.closed || !win.document) return;
      const currentLegacy = readCollapsedGroupsPref();
      if (!currentLegacy || currentLegacy.size === 0) return;

      let migrated = 0;
      for (const group of win.document.querySelectorAll(NORMAL_GROUP_SELECTOR)) {
        if (!group?.isConnected || isSidebarCopy(group)) continue;
        const label = group.getAttribute?.("label");
        if (!label) continue;
        if (currentLegacy.has(collapseKey(group)) || currentLegacy.has(label)) {
          try {
            if (!group.collapsed) group.collapsed = true;
            migrated++;
          } catch {}
        }
      }
      if (migrated > 0) saveGroupState(win);
      // Clear legacy pref so group-state.mjs remains the sole source of truth.
      writeCollapsedGroupsPref(new Set());
      console.log(`${LOG} migrated ${migrated} legacy collapsed group(s) into window group-state`);
    })
    .catch((e) => {
      console.warn(`${LOG} legacy collapse migration skipped:`, e);
    });
};

export const teardownCollapsedStatePersistence = (win = globalThis.window) => {
  const state = WINDOW_STATE.get(win);
  if (!state?.collapseMigration) return;
  state.collapseMigration.cancelled = true;
  state.collapseMigration = null;
};

// ─── Pref observers ──────────────────────────────────────────────────────────

export const setupMinimalStylePrefObserver = (win = globalThis.window) => {
  const state = getWindowState(win);
  if (!state || state.minimalStyleObserver) return;

  const observer = {
    observe(_subject, topic, data) {
      if (topic !== "nsPref:changed" || data !== CONFIG.MINIMAL_STYLE_PREF) return;
      if (win.closed) return;
      try {
        const rules = readRulesPref() || [];
        const touched = syncAllGroupColors(null, rules);
        console.log(
          `${LOG} minimal-style toggled → resynced ${touched} group(s) across all workspaces (minimal=${isMinimalStyle()})`,
        );
      } catch (e) {
        console.error(`${LOG} minimal-style pref observer error:`, e);
      }
    },
  };
  Services.prefs.addObserver(CONFIG.MINIMAL_STYLE_PREF, observer);
  state.minimalStyleObserver = observer;
  console.log(`${LOG} minimal-style pref observer installed`);
};

export const teardownMinimalStylePrefObserver = (win = globalThis.window) => {
  const state = WINDOW_STATE.get(win);
  if (!state?.minimalStyleObserver) return;
  try {
    Services.prefs.removeObserver(CONFIG.MINIMAL_STYLE_PREF, state.minimalStyleObserver);
  } catch (e) {
    console.warn(`${LOG} failed to remove minimal-style pref observer:`, e);
  }
  state.minimalStyleObserver = null;
};
