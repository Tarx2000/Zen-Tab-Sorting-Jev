// Zen Tab Sorting — tab-group manipulation: find/create/dissolve/consolidate,
// color application (named via Zen API; hex via CSS variable overrides), and the
// sort-ungrouped-to-top pass.

import { CONFIG, LOG, isZenColorName, isValidHex, isUnsetLabel } from "./config.mjs";
import { isMinimalStyle } from "./rules.mjs";
import { getTabTitle, getTabUrl, getHostname } from "./tabs.mjs";
import { NORMAL_GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";

const escapeAttrValue = (value) => {
  const str = String(value ?? "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(str);
  }
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
};

export const isManagedGroup = (groupEl) =>
  groupEl?.getAttribute?.("data-zao-managed") === "true";

export const markManagedGroup = (groupEl) => {
  if (groupEl?.setAttribute) groupEl.setAttribute("data-zao-managed", "true");
  return groupEl;
};

/**
 * Resolve a workspace's `<zen-workspace>` element across active and inactive Spaces.
 */
export const resolveWorkspaceElement = (workspaceId) => {
  const gzw = globalThis.window?.gZenWorkspaces;
  if (!gzw) return null;
  if (workspaceId) {
    const resolved = gzw.workspaceElement?.(workspaceId);
    if (resolved?.isConnected) return resolved;
    if (gzw.activeWorkspace === workspaceId && gzw.activeWorkspaceElement?.isConnected) {
      return gzw.activeWorkspaceElement;
    }
    if (resolved) return resolved;
    if (gzw.activeWorkspace === workspaceId) return gzw.activeWorkspaceElement || null;
  }
  // Fallback for lightweight unit-test fixtures that only mock activeWorkspaceElement.
  return gzw.activeWorkspaceElement || null;
};

const runWithTabMove = (target, fn) => {
  if (typeof globalThis.gBrowser?.zenHandleTabMove === "function" && target) {
    return globalThis.gBrowser.zenHandleTabMove(target, fn);
  }
  return fn();
};

/**
 * Direct, eligible tabs belonging to `groupEl` (excludes nested child groups,
 * split-view groups, placeholders, glance, essential, pinned, and sidebar copies).
 */
export const directGroupTabs = (groupEl, workspaceId = null) => {
  if (!groupEl?.querySelectorAll) return [];
  return Array.from(groupEl.querySelectorAll("tab")).filter((tab) => {
    if (!tab?.isConnected || isSidebarCopy(tab)) return false;
    if (tab.closest?.("tab-group") !== groupEl) return false;
    if (tab.pinned) return false;
    if (tab.hasAttribute?.("zen-empty-tab")) return false;
    if (tab.hasAttribute?.("zen-glance-tab")) return false;
    if (tab.hasAttribute?.("zen-essential")) return false;
    if (workspaceId) {
      const tabWs = tab.getAttribute?.("zen-workspace-id");
      if (tabWs && tabWs !== workspaceId) return false;
    }
    return true;
  });
};

const collectWorkspaceGroups = (workspaceId) => {
  if (typeof document === "undefined") return [];
  const candidates = new Set();

  if (!workspaceId) {
    try {
      for (const el of document.querySelectorAll(NORMAL_GROUP_SELECTOR)) {
        if (el?.isConnected && !isSidebarCopy(el)) candidates.add(el);
      }
    } catch {}
    return [...candidates];
  }

  const escapedWs = escapeAttrValue(workspaceId);
  const wsEl = resolveWorkspaceElement(workspaceId);
  const wsTabsContainer = wsEl?.tabsContainer || wsEl;

  if (wsTabsContainer?.querySelectorAll) {
    try {
      for (const el of wsTabsContainer.querySelectorAll(NORMAL_GROUP_SELECTOR)) {
        if (el?.isConnected && !isSidebarCopy(el)) candidates.add(el);
      }
    } catch {}
  }

  if (wsEl?.pinnedTabsContainer?.querySelectorAll) {
    try {
      for (const el of wsEl.pinnedTabsContainer.querySelectorAll(NORMAL_GROUP_SELECTOR)) {
        if (el?.isConnected && !isSidebarCopy(el)) candidates.add(el);
      }
    } catch {}
  }

  try {
    for (const el of document.querySelectorAll(`${NORMAL_GROUP_SELECTOR}[zen-workspace-id="${escapedWs}"]`)) {
      if (el?.isConnected && !isSidebarCopy(el)) candidates.add(el);
    }
  } catch {}

  try {
    for (const el of document.querySelectorAll(`${NORMAL_GROUP_SELECTOR}:has(tab[zen-workspace-id="${escapedWs}"])`)) {
      if (el?.isConnected && !isSidebarCopy(el)) candidates.add(el);
    }
  } catch {}

  if (candidates.size === 0) {
    try {
      for (const el of document.querySelectorAll(NORMAL_GROUP_SELECTOR)) {
        if (!el?.isConnected || isSidebarCopy(el)) continue;
        const groupWs = el.getAttribute?.("zen-workspace-id");
        if (groupWs === workspaceId) {
          candidates.add(el);
        } else if (wsEl?.contains?.(el) || el.closest?.("zen-workspace")?.id === workspaceId) {
          candidates.add(el);
        } else if (el.querySelector?.(`tab[zen-workspace-id="${escapedWs}"]`)) {
          candidates.add(el);
        }
      }
    } catch {}
  }

  return [...candidates];
};

/**
 * Snapshot all existing `<tab-group>` elements in the workspace, along
 * with the tabs currently inside each group. Used by JEV (Stage 1) as live
 * target categories + context anchors so no pre-saved domain rules are needed.
 *
 * Preserves user-created empty folders as valid target categories.
 *
 * @param {string} workspaceId
 * @returns {Array<{ name: string, domains: string[], tabs: Array<{ title: string, hostname: string, url: string }> }>}
 */
export const getWorkspaceExistingGroups = (workspaceId) => {
  if (!workspaceId || typeof document === "undefined") return [];
  const groupsByName = new Map();
  const candidates = collectWorkspaceGroups(workspaceId);

  for (const groupEl of candidates) {
    if (!groupEl?.isConnected || isSidebarCopy(groupEl)) continue;
    const rawLabel = groupEl.getAttribute?.("label") || "";
    const name = rawLabel.trim();
    if (isUnsetLabel(name)) continue;

    const tabEls = directGroupTabs(groupEl, workspaceId);

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
// Tries direct attribute match first (normalized with .trim()), then workspace
// candidates with exact .trim() match, and finally a case-insensitive fallback.
export const findExistingGroup = (name, workspaceId) => {
  const targetName = String(name || "").trim();
  if (!targetName || !workspaceId || typeof document === "undefined") return null;

  const escapedName = escapeAttrValue(targetName);
  const escapedWs = escapeAttrValue(workspaceId);
  try {
    const direct = document.querySelector?.(
      `${NORMAL_GROUP_SELECTOR}[label="${escapedName}"][zen-workspace-id="${escapedWs}"]`,
    );
    if (direct?.isConnected && !isSidebarCopy(direct)) return direct;

    const wsEl = resolveWorkspaceElement(workspaceId);

    const matchesWorkspace = (candidate) => {
      const candidateWs = candidate.getAttribute?.("zen-workspace-id");
      if (candidateWs && candidateWs !== workspaceId) return false;
      if (candidateWs === workspaceId) return true;
      if (candidate.querySelector?.(`tab[zen-workspace-id="${escapedWs}"]`)) return true;
      if (!candidate.querySelector?.("tab")) {
        if (candidate.closest?.("zen-workspace")?.id === workspaceId || wsEl?.contains?.(candidate)) {
          return true;
        }
      }
      return false;
    };

    const exactCandidates = document.querySelectorAll?.(`${NORMAL_GROUP_SELECTOR}[label="${escapedName}"]`) || [];
    for (const candidate of exactCandidates) {
      if (!candidate?.isConnected || isSidebarCopy(candidate)) continue;
      if (matchesWorkspace(candidate)) return candidate;
    }

    // Trimmed exact and case-insensitive fallback across workspace groups.
    const targetLower = targetName.toLowerCase();
    let ciFallback = null;
    for (const candidate of collectWorkspaceGroups(workspaceId)) {
      const label = (candidate.getAttribute?.("label") || "").trim();
      if (!label) continue;
      if (label === targetName) return candidate;
      if (!ciFallback && label.toLowerCase() === targetLower) ciFallback = candidate;
    }
    return ciFallback;
  } catch (e) {
    console.error(`${LOG} findExistingGroup error for "${targetName}":`, e);
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

// Apply a color to a Zen tab-group. Three paths:
//   - Named Zen color: use Zen's native `group.color = name` setter so light/dark
//     variants are picked up via --tab-group-color-{name}*.
//   - Hex: override the CSS custom properties directly, using light-dark() so
//     both Light Mode and Dark Mode keep crisp contrast (Zia/ATG compatible).
//   - Null / falsy / invalid: clear inline --tab-group-color* overrides.
export const applyGroupColor = (groupEl, color) => {
  if (!groupEl?.isConnected) return;

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
    const invert = `light-dark(color-mix(in srgb, ${color} ${CONFIG.HEX_INVERT_MIX_PERCENT}%, white), color-mix(in srgb, ${color} ${CONFIG.HEX_INVERT_MIX_PERCENT}%, black))`;
    const pale   = `light-dark(color-mix(in srgb, ${color} ${CONFIG.HEX_PALE_MIX_PERCENT}%, white), color-mix(in srgb, ${color} ${CONFIG.HEX_PALE_MIX_PERCENT}%, black))`;
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
 * Walk every rule-named tab-group (including empty groups) and either apply its
 * rule.color or toggle the `.zao-minimal` class so groups look like part of the chrome.
 *
 * @param {string|null} workspaceId — when null, walks every normal tab-group
 *                      across all workspaces.
 * @param {Array<{ name, color }>} rules
 * @returns {number} Count of groups styled
 */
export const syncAllGroupColors = (workspaceId, rules) => {
  if (typeof document === "undefined") return 0;
  const minimal = isMinimalStyle();
  const ruleByName = new Map();
  const ruleByLower = new Map();
  for (const r of rules || []) {
    const trimmed = String(r?.name || "").trim();
    if (!trimmed) continue;
    ruleByName.set(trimmed, r);
    const lower = trimmed.toLowerCase();
    if (!ruleByLower.has(lower)) ruleByLower.set(lower, r);
  }

  const groups = collectWorkspaceGroups(workspaceId);
  let styled = 0;
  for (const groupEl of groups) {
    if (!groupEl?.isConnected || isSidebarCopy(groupEl)) continue;
    const label = (groupEl.getAttribute?.("label") || "").trim();
    const rule = ruleByName.get(label) || ruleByLower.get(label.toLowerCase());

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
  const tabsContainer = resolveWorkspaceElement(workspaceId)?.tabsContainer;
  if (!tabsContainer) {
    console.log(`${LOG} moveTabsToTop: tabsContainer not found for workspace ${workspaceId}`);
    return 0;
  }

  const ungroupApi = typeof globalThis.gBrowser?.ungroupTab === "function"
    ? globalThis.gBrowser.ungroupTab.bind(globalThis.gBrowser)
    : null;
  let cursor = null;
  let moved = 0;

  for (const tab of tabs) {
    if (!tab?.isConnected) continue;
    try {
      if (ungroupApi && tab.closest?.("tab-group")) {
        try { ungroupApi(tab); } catch (e) {
          console.warn(`${LOG} moveTabsToTop: ungroupTab failed for tab, continuing with DOM move:`, e);
        }
      }
      runWithTabMove(tab, () => {
        const before = cursor === null ? tabsContainer.firstChild : cursor.nextSibling;
        if (before !== tab) {
          tabsContainer.insertBefore(tab, before || null);
        }
      });
      cursor = tab;
      moved++;
    } catch (e) {
      console.error(`${LOG} moveTabsToTop: failed:`, e);
    }
  }
  return moved;
};

// After Pass 1, push any remaining ungrouped tab in the workspace to the top of the
// workspace's tab list (preserving relative DOM order). True DOM no-op when already positioned.
export const moveUngroupedToTop = (workspaceId) => {
  if (!workspaceId) return 0;
  const tabsContainer = resolveWorkspaceElement(workspaceId)?.tabsContainer;
  if (!tabsContainer) return 0;

  const ungrouped = [];
  for (const child of tabsContainer.children) {
    if (child.tagName?.toLowerCase() !== "tab") continue;
    if (
      child.isConnected &&
      !isSidebarCopy(child) &&
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
      const expectedBefore = cursor === null ? tabsContainer.firstChild : cursor.nextSibling;
      // True DOM no-op when already in exact target position.
      if (expectedBefore !== tab) {
        runWithTabMove(tab, () => {
          if (cursor === null) {
            tabsContainer.insertBefore(tab, tabsContainer.firstChild);
          } else if (cursor.nextSibling) {
            tabsContainer.insertBefore(tab, cursor.nextSibling);
          } else {
            tabsContainer.appendChild(tab);
          }
        });
        moved++;
      }
      cursor = tab;
    } catch (e) {
      console.error(`${LOG} error moving ungrouped tab to top:`, e);
    }
  }
  return moved;
};

/**
 * Move every tab out of any tab-group whose label isn't in the current rule set
 * to the top of the workspace's tab list, then remove the now-empty group.
 * Protects user-created empty folders (non-managed groups with no tabs).
 *
 * @returns {{ dissolved, ungrouped }}
 */
export const dissolveStaleGroups = (workspaceId, rules) => {
  if (!workspaceId) return { dissolved: 0, ungrouped: 0 };

  const ruleNames = new Set((rules || []).map((r) => String(r?.name || "").trim()));
  const tabsContainer = resolveWorkspaceElement(workspaceId)?.tabsContainer;
  if (!tabsContainer) {
    console.warn(`${LOG} dissolveStaleGroups: workspace tabsContainer not found`);
    return { dissolved: 0, ungrouped: 0 };
  }

  const groups = collectWorkspaceGroups(workspaceId);

  let dissolved = 0;
  let ungrouped = 0;
  let cursor = null;

  for (const groupEl of groups) {
    if (!groupEl.isConnected || isSidebarCopy(groupEl)) continue;
    const label = (groupEl.getAttribute?.("label") || "").trim();
    if (!label || ruleNames.has(label)) continue;

    const tabsInGroup = directGroupTabs(groupEl, workspaceId);
    // Protect user-created empty folders.
    if (tabsInGroup.length === 0 && !isManagedGroup(groupEl)) continue;

    const ungroupApi = typeof globalThis.gBrowser?.ungroupTab === "function"
      ? globalThis.gBrowser.ungroupTab.bind(globalThis.gBrowser)
      : null;

    for (const tab of tabsInGroup) {
      if (!tab.isConnected) continue;
      try {
        if (ungroupApi) {
          try { ungroupApi(tab); } catch (e) {
            console.warn(`${LOG} dissolveStaleGroups: ungroupTab failed, continuing with DOM move:`, e);
          }
        }
        runWithTabMove(tab, () => {
          const before = cursor === null ? tabsContainer.firstChild : cursor.nextSibling;
          if (before !== tab) {
            tabsContainer.insertBefore(tab, before || null);
          }
        });
        cursor = tab;
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
 * @param {string} [workspaceId]
 * @returns {Element|null}
 */
export const findSafeInsertAnchor = (workspaceId = null) => {
  const tabsContainer = resolveWorkspaceElement(workspaceId)?.tabsContainer;
  return tabsContainer?.firstChild || null;
};

// Dissolve any empty AI/mod-managed tab-group in the workspace.
// User-created empty folders (without data-zao-managed="true") are protected.
export const dissolveEmptyGroups = (workspaceId = globalThis.window?.gZenWorkspaces?.activeWorkspace) => {
  if (typeof document === "undefined") return 0;
  const scope = resolveWorkspaceElement(workspaceId);
  if (!scope) return 0;
  let removed = 0;
  for (const groupEl of scope.querySelectorAll(NORMAL_GROUP_SELECTOR)) {
    if (!groupEl?.isConnected || isSidebarCopy(groupEl)) continue;
    if (!isManagedGroup(groupEl)) continue;
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
 * Merge tab-groups in the workspace that share a trimmed label (including empty groups).
 * First DOM-order occurrence is the "canonical" winner; tabs from later duplicates
 * move into it, empty duplicates are removed, and the canonical group's collapsed
 * state is restored.
 */
export const consolidateDuplicateGroups = (workspaceId) => {
  if (!workspaceId) return { mergedLabels: 0, tabsMoved: 0 };

  const groups = collectWorkspaceGroups(workspaceId);
  const byLabel = new Map();
  for (const groupEl of groups) {
    if (!groupEl.isConnected || isSidebarCopy(groupEl)) continue;
    const label = (groupEl.getAttribute?.("label") || "").trim();
    if (!label || isUnsetLabel(label)) continue;
    const key = label.toLowerCase();
    if (!byLabel.has(key)) byLabel.set(key, { label, groupEls: [] });
    byLabel.get(key).groupEls.push(groupEl);
  }

  let mergedLabels = 0;
  let totalTabsMoved = 0;

  for (const { label, groupEls } of byLabel.values()) {
    if (groupEls.length < 2) continue;

    const canonical = groupEls[0];
    const wasCollapsed = expandIfCollapsed(canonical);
    let movedThisLabel = 0;

    for (let i = 1; i < groupEls.length; i++) {
      const dup = groupEls[i];
      if (!dup.isConnected || isSidebarCopy(dup)) continue;

      const dupTabs = directGroupTabs(dup, workspaceId);
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

    if (wasCollapsed) collapseGroup(canonical);

    mergedLabels++;
    totalTabsMoved += movedThisLabel;
    console.log(`${LOG} consolidated ${groupEls.length} "${label}" groups → 1 (moved ${movedThisLabel} tab(s))`);
  }

  return { mergedLabels, tabsMoved: totalTabsMoved };
};
