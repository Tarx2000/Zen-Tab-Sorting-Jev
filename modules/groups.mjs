// Zen Tab Sorting — tab-group manipulation: find/create/dissolve/consolidate,
// color application (named via Zen API; hex via CSS variable overrides), and the
// sort-ungrouped-to-top pass.

import { CONFIG, LOG, isZenColorName, isValidHex, isUnsetLabel } from "./config.mjs";
import { isMinimalStyle } from "./rules.mjs";
import { getTabTitle, getTabUrl, getHostname } from "./tabs.mjs";

/**
 * Snapshot all existing `<tab-group>` elements in the active workspace, along
 * with the tabs currently inside each group. Used by JEV (Stage 1) as live
 * target categories + context anchors so no pre-saved domain rules are needed.
 *
 * Preserves user-created empty folders as valid target categories.
 *
 * @param {string} workspaceId
 * @returns {Array<{ name: string, domains: string[], tabs: Array<{ title: string, hostname: string, url: string }> }>}\n */
export const getWorkspaceExistingGroups = (workspaceId) => {
  if (!workspaceId || typeof document === "undefined") return [];
  const groupsByName = new Map();
  const activeWorkspaceEl = window.gZenWorkspaces?.activeWorkspaceElement;
  const activeTabsContainer = activeWorkspaceEl?.tabsContainer || activeWorkspaceEl;

  const candidates = new Set();

  if (activeTabsContainer?.querySelectorAll) {
    try {
      for (const el of activeTabsContainer.querySelectorAll("tab-group")) {
        if (el?.isConnected) candidates.add(el);
      }
    } catch {}
  }

  try {
    for (const el of document.querySelectorAll(`tab-group[zen-workspace-id="${workspaceId}"]`)) {
      if (el?.isConnected) candidates.add(el);
    }
  } catch {}

  try {
    for (const el of document.querySelectorAll(`tab-group:has(tab[zen-workspace-id="${workspaceId}"])`)) {
      if (el?.isConnected) candidates.add(el);
    }
  } catch {}

  if (candidates.size === 0) {
    try {
      for (const el of document.querySelectorAll("tab-group")) {
        if (!el?.isConnected) continue;
        const groupWs = el.getAttribute("zen-workspace-id");
        if (groupWs === workspaceId) {
          candidates.add(el);
        } else if (activeWorkspaceEl?.contains(el)) {
          candidates.add(el);
        } else if (el.querySelector(`tab[zen-workspace-id="${workspaceId}"]`)) {
          candidates.add(el);
        }
      }
    } catch {}
  }

  for (const groupEl of candidates) {
    if (!groupEl?.isConnected) continue;
    const rawLabel = groupEl.getAttribute("label") || "";
    const name = rawLabel.trim();
    if (isUnsetLabel(name)) continue;

    let tabEls = Array.from(
      groupEl.querySelectorAll(`tab[zen-workspace-id="${workspaceId}"]`),
    );

    if (
      tabEls.length === 0 &&
      (activeWorkspaceEl?.contains(groupEl) || groupEl.getAttribute("zen-workspace-id") === workspaceId)
    ) {
      tabEls = Array.from(groupEl.querySelectorAll("tab"));
    }

    if (!groupsByName.has(name)) {
      groupsByName.set(name, { name, domains: [], tabs: [] });
    }
    const entry = groupsByName.get(name);
    const domainSet = new Set(entry.domains);

    for (const tabEl of tabEls) {
      if (!tabEl?.isConnected) continue;
      const url = getTabUrl(tabEl);
      const hostname = getHostname(url);
      const title = getTabTitle(tabEl) || "(untitled)";
      if (hostname) domainSet.add(hostname);
      entry.tabs.push({ title, hostname, url });
    }
    entry.domains = [...domainSet];
  }

  return [...groupsByName.values()];
};

// Find an existing tab-group with the given label in the given workspace.
// Tries direct attribute match first (which doesn't always work because Zen doesn't
// reliably set zen-workspace-id on the tab-group itself), then falls back to label-only
// + verifying a child tab is in the workspace.
export const findExistingGroup = (name, workspaceId) => {
  if (!name || !workspaceId) return null;
  // Escape backslashes and double-quotes so the name is safe to drop into a CSS
  // attribute selector like `[label="<name>"]`.
  const escapedName = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const direct = document.querySelector(
      `tab-group[label="${escapedName}"][zen-workspace-id="${workspaceId}"]`
    );
    if (direct?.isConnected) return direct;

    const candidates = document.querySelectorAll(`tab-group[label="${escapedName}"]`);
    for (const candidate of candidates) {
      if (!candidate.isConnected) continue;
      if (candidate.querySelector(`tab[zen-workspace-id="${workspaceId}"]`)) {
        return candidate;
      }
    }
    return null;
  } catch (e) {
    console.error(`${LOG} findExistingGroup error for "${name}":`, e);
    return null;
  }
};

// Zen toggles the `collapsed` attribute as an HTML boolean: present (with
// empty-string value) = collapsed, absent = expanded. The previous check
// of `=== "true"` never matched and silently no-op'd. We also use the
// property setter when available, because Firefox's MozTabbrowserTabGroup
// setter both flips the attribute AND clears `aria-hidden` on inner tabs —
// crucial for our collapse CSS rule which keys off aria-hidden.
//
// Returns true if the group WAS collapsed (caller can decide to re-collapse
// after its work is done so newly-added tabs join the collapse properly).
export const expandIfCollapsed = (groupEl) => {
  if (!groupEl?.isConnected) return false;
  if (!groupEl.hasAttribute("collapsed")) return false;
  let didFlip = false;
  try { groupEl.collapsed = false; didFlip = true; } catch {}
  if (!didFlip) {
    try { groupEl.removeAttribute("collapsed"); } catch {}
    // Property setter wasn't available; manually clear aria-hidden so the
    // newly-visible tabs don't stay invisibly hidden by our CSS rule.
    for (const tab of groupEl.querySelectorAll("tab[aria-hidden]")) {
      try { tab.removeAttribute("aria-hidden"); } catch {}
    }
  }
  const labelEl = groupEl.querySelector(".tab-group-label");
  if (labelEl) labelEl.setAttribute("aria-expanded", "true");
  return true;
};

// Inverse of expandIfCollapsed — set collapsed back on. Uses the property
// setter so Firefox properly re-applies aria-hidden to ALL current tabs
// (including any that were added while the group was expanded).
export const collapseGroup = (groupEl) => {
  if (!groupEl?.isConnected) return;
  let didFlip = false;
  try { groupEl.collapsed = true; didFlip = true; } catch {}
  if (!didFlip) {
    try { groupEl.setAttribute("collapsed", ""); } catch {}
    // Fallback aria-hidden if property setter wasn't available
    for (const tab of groupEl.querySelectorAll("tab")) {
      if (!tab.hasAttribute("selected")) {
        try { tab.setAttribute("aria-hidden", "true"); } catch {}
      }
    }
  }
};

// Apply a color to a Zen tab-group. Two paths:
//   - Named Zen color: use Zen's native `group.color = name` setter so light/dark
//     variants are picked up via --tab-group-color-{name}*.
//   - Hex: override the CSS custom properties directly, deriving lighter "invert"
//     and "pale" variants so the collapsed-state CSS keeps readable contrast.
export const applyGroupColor = (groupEl, color) => {
  if (!groupEl?.isConnected || !color) return;

  if (isZenColorName(color)) {
    try {
      groupEl.style.removeProperty("--tab-group-color");
      groupEl.style.removeProperty("--tab-group-color-invert");
      groupEl.style.removeProperty("--tab-group-color-pale");
      groupEl.style.removeProperty("--tab-group-line-color");
      groupEl.color = color;
      console.debug(`${LOG} colored "${groupEl.getAttribute("label")}" → ${color} (named)`);
    } catch (e) {
      console.error(`${LOG} group.color setter failed:`, e);
    }
    return;
  }

  if (isValidHex(color)) {
    const invert = colorMix(color, "#ffffff", 25);
    const pale   = colorMix(color, "#ffffff", 80);
    try {
      groupEl.style.setProperty("--tab-group-color", color, "important");
      groupEl.style.setProperty("--tab-group-color-invert", invert, "important");
      groupEl.style.setProperty("--tab-group-color-pale", pale, "important");
      groupEl.style.setProperty("--tab-group-line-color", color, "important");
      console.debug(`${LOG} colored "${groupEl.getAttribute("label")}" → ${color} (hex override)`);
    } catch (e) {
      console.error(`${LOG} hex style override failed:`, e);
    }
    return;
  }

  try {
    groupEl.style.removeProperty("--tab-group-color");
    groupEl.style.removeProperty("--tab-group-color-invert");
    groupEl.style.removeProperty("--tab-group-color-pale");
    groupEl.style.removeProperty("--tab-group-line-color");
  } catch {}
};

/**
 * Walk every rule-named tab-group and either apply its rule.color or toggle the
 * `.zao-minimal` class so groups look like part of the chrome.
 *
 * @param {string|null} workspaceId — when null, walks every rule-named
 *                      tab-group across all workspaces (rules are global, so
 *                      styling follows suit on look-and-feel changes).
 * @param {Array<{ name, color }>} rules
 * @returns {number} Count of groups styled
 */
export const syncAllGroupColors = (workspaceId, rules) => {
  if (typeof document === "undefined") return 0;
  const minimal = isMinimalStyle();
  const ruleByName = new Map(rules.map((r) => [r.name, r]));

  const selector = workspaceId
    ? `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
    : `tab-group`;

  let styled = 0;
  for (const groupEl of document.querySelectorAll(selector)) {
    if (!groupEl?.isConnected) continue;
    const label = groupEl.getAttribute("label");
    const rule = ruleByName.get(label);

    if (minimal) {
      groupEl.classList.add("zao-minimal");
      applyGroupColor(groupEl, null);
    } else {
      groupEl.classList.remove("zao-minimal");
      if (rule && rule.color) {
        applyGroupColor(groupEl, rule.color);
      } else {
        applyGroupColor(groupEl, null);
      }
    }
    styled++;
  }
  return styled;
};

// ─── Native-API Helpers ──────────────────────────────────────────────────────
//
// In Zen Browser, tab groups must always be modified through `gBrowser.*` APIs
// whenever possible:
//   - `gBrowser.addTabGroup(tabs, { label, color }, anchor)`
//   - `gBrowser.moveTabToExistingGroup(tab, group)`
//   - `gBrowser.ungroupTab(tab)`
//
// Moving tabs solely via DOM reparenting (`tabsContainer.insertBefore`) breaks
// Zen's internal group index, leaves groups in inconsistent state, and causes
// tabs to bounce back to their previous group on the next user action.

/**
 * Move an array of tabs to the top of the workspace's tab list, ungrouping
 * any of them that were inside a group.
 *
 * @param {Element[]} tabs — DOM <tab> elements
 * @param {string} workspaceId
 * @returns {number} Count of tabs moved
 */
export const moveTabsToTop = (tabs, workspaceId) => {
  if (!Array.isArray(tabs) || tabs.length === 0 || !workspaceId) return 0;
  const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
  if (!tabsContainer) {
    console.log(`${LOG} moveTabsToTop: tabsContainer not found on activeWorkspaceElement`);
    return 0;
  }

  // Zen: `gBrowser.ungroupTab` keeps Zen's group state in sync. Call it before
  // DOM reparenting.
  const ungroupApi = typeof gBrowser?.ungroupTab === "function" ? gBrowser.ungroupTab.bind(gBrowser) : null;
  const topAnchor = tabsContainer.firstChild;
  let moved = 0;
  for (const tab of tabs) {
    if (!tab?.isConnected) continue;
    try {
      if (ungroupApi && tab.closest("tab-group")) {
        try { ungroupApi(tab); } catch (e) {
          console.warn(`${LOG} moveTabsToTop: ungroupTab failed for tab, continuing with DOM move:`, e);
        }
      }
      if (topAnchor && topAnchor.isConnected) {
        tabsContainer.insertBefore(tab, topAnchor);
      } else {
        tabsContainer.insertBefore(tab, tabsContainer.firstChild);
      }
      moved++;
    } catch (e) {
      console.error(`${LOG} moveTabsToTop: failed:`, e);
    }
  }
  return moved;
};

// After Pass 1, push any remaining ungrouped tab in the workspace to the top of the
// workspace's tab list (preserving relative DOM order).
export const moveUngroupedToTop = (workspaceId) => {
  if (!workspaceId) return 0;
  const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
  if (!tabsContainer) return 0;

  const ungrouped = [];
  for (const child of tabsContainer.children) {
    if (child.tagName?.toLowerCase() !== "tab") continue;
    if (
      child.isConnected &&
      child.getAttribute("zen-workspace-id") === workspaceId &&
      !child.pinned &&
      !child.hasAttribute("zen-empty-tab") &&
      !child.hasAttribute("zen-glance-tab") &&
      !child.hasAttribute("zen-essential")
    ) {
      ungrouped.push(child);
    }
  }
  if (ungrouped.length === 0) return 0;

  let cursor = null;
  let moved = 0;
  for (const tab of ungrouped) {
    try {
      if (cursor === null) {
        tabsContainer.insertBefore(tab, tabsContainer.firstChild);
      } else if (cursor.nextSibling) {
        tabsContainer.insertBefore(tab, cursor.nextSibling);
      } else {
        tabsContainer.appendChild(tab);
      }
      cursor = tab;
      moved++;
    } catch (e) {
      console.error(`${LOG} error moving ungrouped tab to top:`, e);
    }
  }
  return moved;
};

/**
 * Move every tab out of any tab-group whose label isn't in the current rule set
 * to the top of the workspace's tab list, then remove the now-empty group.
 * Runs BEFORE Pass 1 so Pass 1 sees clean state and can regroup the freed tabs.
 *
 * @returns {{ dissolved, ungrouped }} where:
 *   dissolved — number of stale groups whose <tab-group> element was removed
 *   ungrouped — number of tabs that were moved out of stale groups (NOT a count of
 *               previously-ungrouped tabs in the workspace)
 */
export const dissolveStaleGroups = (workspaceId, rules) => {
  if (!workspaceId) return { dissolved: 0, ungrouped: 0 };

  const ruleNames = new Set(rules.map((r) => r.name));
  const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
  if (!tabsContainer) {
    console.warn(`${LOG} dissolveStaleGroups: workspace tabsContainer not found`);
    return { dissolved: 0, ungrouped: 0 };
  }

  const groups = document.querySelectorAll(
    `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
  );

  let dissolved = 0;
  let ungrouped = 0;
  // Snapshot of the workspace's first child BEFORE we start moving tabs in.
  // Inserting before this same anchor on every iteration places the freed tabs
  // at the top of the list in the order we discovered them.
  const topAnchor = tabsContainer.firstChild;

  for (const groupEl of groups) {
    if (!groupEl.isConnected) continue;
    const label = groupEl.getAttribute("label");
    if (!label || ruleNames.has(label)) continue;

    const tabsInGroup = Array.from(
      groupEl.querySelectorAll(`tab[zen-workspace-id="${workspaceId}"]`)
    );

    // Tell Zen the tabs are leaving their group via the real API before
    // DOM-reparenting, so Zen's tab-group bookkeeping stays in sync.
    const ungroupApi = typeof gBrowser?.ungroupTab === "function" ? gBrowser.ungroupTab.bind(gBrowser) : null;
    for (const tab of tabsInGroup) {
      if (!tab.isConnected) continue;
      try {
        if (ungroupApi) {
          try { ungroupApi(tab); } catch (e) {
            console.warn(`${LOG} dissolveStaleGroups: ungroupTab failed, continuing with DOM move:`, e);
          }
        }
        if (topAnchor && topAnchor.isConnected) {
          tabsContainer.insertBefore(tab, topAnchor);
        } else {
          tabsContainer.insertBefore(tab, tabsContainer.firstChild);
        }
        ungrouped++;
      } catch (e) {
        console.error(`${LOG} error ungrouping tab from stale group "${label}":`, e);
      }
    }

    if (groupEl.isConnected && !groupEl.querySelector("tab")) {
      try {
        groupEl.remove();
        dissolved++;
        console.log(`${LOG} dissolved stale group "${label}" (${tabsInGroup.length} tab(s) → top of list)`);
      } catch (e) {
        console.error(`${LOG} error removing stale group "${label}":`, e);
      }
    }
  }

  return { dissolved, ungrouped };
};

/**
 * Find a DOM-safe `insertBefore` anchor for gBrowser.addTabGroup.
 *
 * @returns {Element|null}
 */
export const findSafeInsertAnchor = () => {
  const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
  return tabsContainer?.firstChild || null;
};

// Dissolve any empty tab-group in the active workspace.
export const dissolveEmptyGroups = () => {
  if (typeof document === "undefined") return 0;
  let removed = 0;
  for (const groupEl of document.querySelectorAll("tab-group")) {
    if (!groupEl?.isConnected) continue;
    if (groupEl.querySelector("tab")) continue;
    const label = groupEl.getAttribute("label") || "(unnamed)";
    try {
      groupEl.remove();
      removed++;
      console.log(`${LOG} dissolved empty group "${label}"`);
    } catch (e) {
      console.error(`${LOG} error removing empty group "${label}":`, e);
    }
  }
  return removed;
};

/**
 * Merge tab-groups in the current workspace that share a label.
 * First DOM-order occurrence is the "canonical" winner; tabs from later duplicates
 * move into it, then the empty duplicate is removed.
 */
export const consolidateDuplicateGroups = (workspaceId) => {
  if (!workspaceId) return { mergedLabels: 0, tabsMoved: 0 };

  const groups = document.querySelectorAll(
    `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
  );

  const byLabel = new Map();
  for (const groupEl of groups) {
    if (!groupEl.isConnected) continue;
    const label = groupEl.getAttribute("label");
    if (!label) continue;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(groupEl);
  }

  let mergedLabels = 0;
  let totalTabsMoved = 0;

  for (const [label, groupEls] of byLabel) {
    if (groupEls.length < 2) continue;

    const canonical = groupEls[0];
    expandIfCollapsed(canonical);
    let movedThisLabel = 0;

    for (let i = 1; i < groupEls.length; i++) {
      const dup = groupEls[i];
      if (!dup.isConnected) continue;

      const dupTabs = Array.from(
        dup.querySelectorAll(`tab[zen-workspace-id="${workspaceId}"]`)
      );
      for (const tab of dupTabs) {
        if (!tab.isConnected) continue;
        try {
          gBrowser.moveTabToExistingGroup(tab, canonical);
          movedThisLabel++;
        } catch (e) {
          console.error(`${LOG} error merging tab into "${label}":`, e);
        }
      }

      if (dup.isConnected && !dup.querySelector("tab")) {
        try { dup.remove(); } catch (e) {
          console.error(`${LOG} error removing empty duplicate "${label}":`, e);
        }
      }
    }

    mergedLabels++;
    totalTabsMoved += movedThisLabel;
    console.log(`${LOG} consolidated ${groupEls.length} "${label}" groups → 1 (moved ${movedThisLabel} tab(s))`);
  }

  return { mergedLabels, tabsMoved: totalTabsMoved };
};
