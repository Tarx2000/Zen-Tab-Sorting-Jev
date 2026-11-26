// Zen Tab Sorting — Searchable "Move to Folder…" Quick-Pick Popover (Q3 & Q8).
//
// Opens from #tabContextMenu for either a single right-clicked tab or all
// multi-selected tabs. Provides live search, full keyboard navigation,
// inline "+ New Folder…" creation, and a smart "Save as rule" checkbox that
// auto-selects domain vs. URL path pattern for multi-topic platforms.

import { LOG, HTML_NS, bgForName, isZenColorName, isValidHex } from "./config.mjs";
import { getTabUrl } from "./tabs.mjs";
import { NORMAL_GROUP_SELECTOR, isSidebarCopy } from "./sidebar-elements.mjs";
import {
  directGroupTabs,
  expandIfCollapsed,
  collapseGroup,
  findSafeInsertAnchor,
  resolveWorkspaceElement,
} from "./groups.mjs";
import { captureNewGroupAppearance } from "./group-appearance.mjs";
import { saveGroupState } from "./group-state.mjs";
import {
  readRulesPref,
  writeRulesPref,
  normalizeDomainPattern,
  normalizeUrlPattern,
} from "./rules.mjs";
import { getLocale } from "./i18n.mjs";

const SPLIT_VIEW_SELECTOR = "tab-group[split-view-group], tab-split-view-wrapper";
const POPOVER_CLASS = "zao-move-folder-popover";
const ACTIVE_POPOVERS = new WeakMap();

const LOCALIZED = {
  en: {
    titleSingle: "Move to Folder",
    titleMulti: "Move {count} tabs to Folder",
    searchPlaceholder: "Search or create folder…",
    searchAria: "Filter folders",
    newFolder: "+ New Folder…",
    createNamed: "+ Create \"{name}\"",
    newFolderPlaceholder: "New folder name…",
    noFolders: "No matching folders",
    saveAsRule: "Save as rule",
    alreadyHere: "Current",
    escHint: "ESC",
    morePatterns: "+{n} more",
  },
  de: {
    titleSingle: "In Ordner verschieben",
    titleMulti: "{count} Tabs in Ordner verschieben",
    searchPlaceholder: "Ordner suchen oder erstellen …",
    searchAria: "Ordner filtern",
    newFolder: "+ Neuer Ordner …",
    createNamed: "+ „{name}“ erstellen",
    newFolderPlaceholder: "Neuer Ordnername …",
    noFolders: "Keine passenden Ordner",
    saveAsRule: "Als Regel merken",
    alreadyHere: "Aktuell",
    escHint: "ESC",
    morePatterns: "+{n} weitere",
  },
};

const msg = (key, params = null, win = globalThis.window) => {
  const locale = getLocale(win);
  const template = LOCALIZED[locale]?.[key] ?? LOCALIZED.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) =>
    Object.hasOwn(params, k) && params[k] != null ? String(params[k]) : m,
  );
};

// ─── Q8 Smart Domain-vs-Path Rule Suggestion ─────────────────────────────────

export const MULTI_TOPIC_PLATFORMS = Object.freeze([
  "github.com",
  "docs.google.com",
  "youtube.com",
  "reddit.com",
  "notion.so",
  "medium.com",
  "substack.com",
  "wikipedia.org",
]);

const GITHUB_NON_REPO_ROOTS = new Set([
  "settings",
  "notifications",
  "explore",
  "issues",
  "pulls",
  "marketplace",
  "sponsors",
  "topics",
  "search",
  "features",
  "pricing",
  "enterprise",
  "login",
  "signup",
  "orgs",
  "users",
]);

/**
 * Returns the matched multi-topic platform base domain (e.g. "github.com",
 * "wikipedia.org") if `hostname` belongs to a known multi-topic platform,
 * or `null` for standard single-topic sites.
 */
export const isMultiTopicHost = (hostname) => {
  const host = normalizeDomainPattern(hostname).replace(/^\*\./, "");
  if (!host) return null;
  for (const platform of MULTI_TOPIC_PLATFORMS) {
    if (host === platform || host.endsWith("." + platform)) {
      return platform;
    }
  }
  return null;
};

const cleanPathSegments = (pathname) =>
  String(pathname || "")
    .split("/")
    .map((seg) => seg.trim())
    .filter(Boolean);

/**
 * Inspect a tab URL and propose the most useful rule pattern:
 * - Standard sites -> normalized domain (e.g. `{ kind: "domain", pattern: "figma.com" }`)
 * - Multi-topic platforms -> specific URL path pattern (e.g. `github.com/org/repo*`,
 *   `reddit.com/r/rust*`, `docs.google.com/document/d/<id>*`, `en.wikipedia.org/wiki/<topic>*`)
 *   or publication subdomain for Substack (`author.substack.com`).
 *
 * Returns `null` for non-HTTP(S) or invalid URLs.
 */
export const suggestRulePattern = (rawUrl) => {
  const str = String(rawUrl || "").trim();
  if (!str) return null;

  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const host = normalizeDomainPattern(parsed.hostname).replace(/^\*\./, "");
  if (!host) return null;

  const platform = isMultiTopicHost(host);
  if (!platform) {
    return { kind: "domain", pattern: host, host, isMultiTopic: false };
  }

  const segments = cleanPathSegments(parsed.pathname);

  // Substack publications live on `<pub>.substack.com`, where the subdomain itself
  // is the topic boundary; `substack.com/@author/...` uses the path.
  if (platform === "substack.com") {
    if (host !== "substack.com") {
      return { kind: "domain", pattern: host, host, isMultiTopic: true };
    }
    if (segments.length >= 1) {
      const pattern = normalizeUrlPattern(`${host}/${segments[0]}*`);
      return { kind: "urlPattern", pattern, host, isMultiTopic: true };
    }
    return { kind: "domain", pattern: host, host, isMultiTopic: true };
  }

  if (segments.length === 0) {
    return { kind: "domain", pattern: host, host, isMultiTopic: true };
  }

  if (platform === "github.com") {
    const first = segments[0];
    const firstLower = first.toLowerCase();
    if (segments.length >= 2 && !GITHUB_NON_REPO_ROOTS.has(firstLower)) {
      const pattern = normalizeUrlPattern(`${host}/${first}/${segments[1]}*`);
      return { kind: "urlPattern", pattern, host, isMultiTopic: true };
    }
    const pattern = normalizeUrlPattern(`${host}/${first}*`);
    return { kind: "urlPattern", pattern, host, isMultiTopic: true };
  }

  if (platform === "docs.google.com") {
    // e.g. /document/d/<docId>/edit -> docs.google.com/document/d/<docId>*
    if (segments.length >= 3 && segments[1].toLowerCase() === "d") {
      const pattern = normalizeUrlPattern(`${host}/${segments[0]}/d/${segments[2]}*`);
      return { kind: "urlPattern", pattern, host, isMultiTopic: true };
    }
    const pattern = normalizeUrlPattern(`${host}/${segments[0]}*`);
    return { kind: "urlPattern", pattern, host, isMultiTopic: true };
  }

  if (platform === "reddit.com") {
    const prefix = segments[0].toLowerCase();
    if ((prefix === "r" || prefix === "u" || prefix === "user") && segments.length >= 2) {
      const pattern = normalizeUrlPattern(`${host}/${prefix}/${segments[1]}*`);
      return { kind: "urlPattern", pattern, host, isMultiTopic: true };
    }
    const pattern = normalizeUrlPattern(`${host}/${segments[0]}*`);
    return { kind: "urlPattern", pattern, host, isMultiTopic: true };
  }

  if (platform === "youtube.com") {
    const first = segments[0];
    const firstLower = first.toLowerCase();
    if (first.startsWith("@")) {
      const pattern = normalizeUrlPattern(`${host}/${first}*`);
      return { kind: "urlPattern", pattern, host, isMultiTopic: true };
    }
    if ((firstLower === "channel" || firstLower === "c" || firstLower === "user") && segments.length >= 2) {
      const pattern = normalizeUrlPattern(`${host}/${firstLower}/${segments[1]}*`);
      return { kind: "urlPattern", pattern, host, isMultiTopic: true };
    }
    const pattern = normalizeUrlPattern(`${host}/${first}*`);
    return { kind: "urlPattern", pattern, host, isMultiTopic: true };
  }

  if (platform === "wikipedia.org") {
    if (segments[0].toLowerCase() === "wiki" && segments.length >= 2) {
      const pattern = normalizeUrlPattern(`${host}/wiki/${segments[1]}*`);
      return { kind: "urlPattern", pattern, host, isMultiTopic: true };
    }
    const pattern = normalizeUrlPattern(`${host}/${segments[0]}*`);
    return { kind: "urlPattern", pattern, host, isMultiTopic: true };
  }

  // notion.so, medium.com, etc.: first path segment identifies workspace/publication/author.
  const pattern = normalizeUrlPattern(`${host}/${segments[0]}*`);
  return { kind: "urlPattern", pattern, host, isMultiTopic: true };
};

/**
 * Compute deduplicated rule suggestions for one or more tab objects/elements.
 */
export const suggestRuleForTabs = (tabs, { urlExtractor = getTabUrl } = {}) => {
  const list = Array.isArray(tabs) ? tabs : tabs ? [tabs] : [];
  const seen = new Set();
  const suggestions = [];

  for (const tab of list) {
    const rawUrl = typeof tab === "string"
      ? tab
      : (tab?.url && typeof tab.url === "string" ? tab.url : urlExtractor(tab));
    const suggestion = suggestRulePattern(rawUrl);
    if (!suggestion) continue;
    const key = `${suggestion.kind}:${suggestion.pattern.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(suggestion);
  }

  return {
    primary: suggestions[0] || null,
    all: suggestions,
  };
};

/**
 * Persist suggested domain / urlPattern entries into the target folder's rule
 * in `rules.mjs` (creating the rule if none exists yet).
 */
export const saveRuleSuggestionToFolder = (folderName, suggestions, { color = null } = {}) => {
  const name = String(folderName || "").trim();
  const list = Array.isArray(suggestions) ? suggestions : suggestions ? [suggestions] : [];
  if (!name || list.length === 0) return { rule: null, addedCount: 0 };

  const rules = readRulesPref({ keepIncomplete: true }) || [];
  const lower = name.toLowerCase();
  let rule = rules.find((r) => String(r?.name || "").trim().toLowerCase() === lower);

  if (!rule) {
    rule = { name, domains: [] };
    if (color && (isZenColorName(color) || isValidHex(color))) {
      rule.color = color;
    }
    rules.push(rule);
  }

  let addedCount = 0;
  for (const s of list) {
    if (!s?.pattern) continue;
    if (s.kind === "urlPattern") {
      if (!Array.isArray(rule.urlPatterns)) rule.urlPatterns = [];
      const norm = normalizeUrlPattern(s.pattern);
      if (norm && !rule.urlPatterns.some((p) => p.toLowerCase() === norm.toLowerCase())) {
        rule.urlPatterns.push(norm);
        addedCount++;
      }
    } else {
      if (!Array.isArray(rule.domains)) rule.domains = [];
      const norm = normalizeDomainPattern(s.pattern);
      if (norm && !rule.domains.some((d) => d.toLowerCase() === norm.toLowerCase())) {
        rule.domains.push(norm);
        addedCount++;
      }
    }
  }

  if (addedCount > 0) {
    writeRulesPref(rules);
    console.log(`${LOG} move-to-folder: saved ${addedCount} rule pattern(s) for "${name}"`);
  }

  return { rule, addedCount };
};

// ─── Pure folder search & ranking ────────────────────────────────────────────

const fuzzySubsequenceScore = (text, query) => {
  let qi = 0;
  let consecutive = 0;
  let bonus = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      qi++;
      consecutive++;
      bonus += consecutive;
    } else {
      consecutive = 0;
    }
  }
  return qi === query.length ? bonus : 0;
};

/**
 * Filter and rank folder items for the Quick-Pick popover.
 * Empty query preserves DOM/tree order; non-empty query ranks:
 * exact > prefix > word-boundary > substring > ordered fuzzy subsequence.
 */
export const filterAndRankFolders = (folders, query) => {
  const list = Array.isArray(folders) ? folders : [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list.slice();

  const scored = [];
  list.forEach((folder, idx) => {
    const label = String(folder?.label || "").trim().toLowerCase();
    if (!label) return;

    let tier = 0;
    let detail = 0;
    if (label === q) {
      tier = 4;
      detail = 1000;
    } else if (label.startsWith(q)) {
      tier = 3;
      detail = 1000 - label.length;
    } else {
      const words = label.split(/[\s\-_/]+/).filter(Boolean);
      if (words.some((w) => w.startsWith(q))) {
        tier = 2;
        detail = 1000 - label.indexOf(q);
      } else if (label.includes(q)) {
        tier = 1;
        detail = 1000 - label.indexOf(q);
      } else {
        const fuzzy = fuzzySubsequenceScore(label, q);
        if (fuzzy > 0) {
          tier = 0.5;
          detail = fuzzy;
        }
      }
    }

    if (tier > 0) {
      scored.push({ folder, tier, detail, idx });
    }
  });

  scored.sort((a, b) => b.tier - a.tier || b.detail - a.detail || a.idx - b.idx);
  return scored.map((entry) => entry.folder);
};

// ─── Browser helpers ─────────────────────────────────────────────────────────

export const isTabMovableToFolder = (tab) =>
  Boolean(
    tab?.isConnected &&
    !tab.pinned &&
    !tab.hasAttribute?.("zen-essential") &&
    !tab.hasAttribute?.("zen-glance-tab") &&
    !tab.hasAttribute?.("zen-empty-tab") &&
    !tab.closest?.(SPLIT_VIEW_SELECTOR),
  );

const folderNestingDepth = (groupEl) => {
  let depth = 0;
  let cur = groupEl?.parentElement?.closest?.(NORMAL_GROUP_SELECTOR);
  const seen = new Set([groupEl]);
  while (cur && !seen.has(cur) && depth < 6) {
    seen.add(cur);
    depth++;
    cur = cur.parentElement?.closest?.(NORMAL_GROUP_SELECTOR);
  }
  return depth;
};

const readGroupSwatchColor = (groupEl) => {
  if (!groupEl) return "";
  const inline = groupEl.style?.getPropertyValue?.("--tab-group-color")?.trim();
  if (inline && isValidHex(inline)) return inline;
  const code = groupEl.color || groupEl.getAttribute?.("color") || "";
  if (isZenColorName(code)) return bgForName(code);
  if (isValidHex(code)) return code;
  return "var(--zen-primary-color, AccentColor)";
};

const collectActiveWorkspaceFolders = (win, workspaceId, targetTabs) => {
  const doc = win?.document;
  if (!doc || !workspaceId) return [];
  const wsEl = resolveWorkspaceElement(workspaceId);
  const scope = wsEl || doc;

  const targetGroups = new Set(
    targetTabs.map((t) => t.closest?.(NORMAL_GROUP_SELECTOR)).filter(Boolean),
  );

  const folders = [];
  const seen = new Set();
  for (const el of scope.querySelectorAll(NORMAL_GROUP_SELECTOR)) {
    if (!el?.isConnected || isSidebarCopy(el) || seen.has(el)) continue;
    const groupWs = el.closest?.("zen-workspace")?.id || el.getAttribute?.("zen-workspace-id");
    if (groupWs && groupWs !== workspaceId) continue;
    const label = (el.getAttribute?.("label") || el.label || "").trim();
    if (!label || label === "\u200b") continue;
    seen.add(el);
    const allInThisGroup = targetTabs.length > 0 && targetGroups.size === 1 && targetGroups.has(el);
    folders.push({
      id: el.id || `folder_${folders.length}`,
      label,
      count: directGroupTabs(el, workspaceId).length,
      color: readGroupSwatchColor(el),
      rawColor: el.color || el.style?.getPropertyValue?.("--tab-group-color")?.trim() || null,
      emoji: el.getAttribute?.("data-zao-folder-emoji") || "",
      depth: folderNestingDepth(el),
      isCurrent: allInThisGroup,
      groupEl: el,
    });
  }
  return folders;
};

const moveTabsIntoExistingFolder = (win, tabs, targetGroup) => {
  if (!targetGroup?.isConnected || !tabs.length) return 0;
  const movable = tabs.filter((t) => t?.isConnected && t.closest?.(NORMAL_GROUP_SELECTOR) !== targetGroup);
  if (movable.length === 0) return 0;

  const wasCollapsed = expandIfCollapsed(targetGroup);
  let moved = 0;
  try {
    for (const tab of movable) {
      if (!tab.isConnected) continue;
      win.gBrowser?.moveTabToExistingGroup?.(tab, targetGroup);
      moved++;
    }
    if (wasCollapsed) {
      (win.setTimeout || setTimeout)(() => {
        if (!win.closed && targetGroup.isConnected) collapseGroup(targetGroup);
      }, 0);
    }
    saveGroupState(win);
    win._zaoFolderEngine?.refreshGroup?.(targetGroup);
  } catch (e) {
    console.error(`${LOG} move-to-folder failed:`, e);
  }
  return moved;
};

const createFolderForTabs = (win, tabs, label, workspaceId) => {
  const trimmed = String(label || "").trim();
  if (!trimmed || !tabs.length) return null;
  try {
    const newGroup = win.gBrowser?.addTabGroup?.(tabs, {
      label: trimmed,
      insertBefore: findSafeInsertAnchor(workspaceId),
    });
    if (newGroup) {
      captureNewGroupAppearance(newGroup);
      saveGroupState(win);
      win._zaoFolderEngine?.refreshGroup?.(newGroup);
    }
    return newGroup || null;
  } catch (e) {
    console.error(`${LOG} move-to-folder create failed:`, e);
    return null;
  }
};

// ─── Quick-Pick Popover UI ───────────────────────────────────────────────────

export const closeMoveToFolderPopover = (win = globalThis.window) => {
  const active = ACTIVE_POPOVERS.get(win);
  if (active) {
    active.close();
    return;
  }
  try {
    win?.document?.querySelectorAll?.(`.${POPOVER_CLASS}`)?.forEach((el) => {
      if (typeof el._zaoClose === "function") el._zaoClose();
      else el.remove();
    });
  } catch {}
};

const createHtml = (doc, tag, className = "") => {
  const el = typeof doc.createElementNS === "function"
    ? doc.createElementNS(HTML_NS, tag)
    : doc.createElement(tag);
  if (className) el.className = className;
  return el;
};

const resolveAnchorPoint = (win, anchor) => {
  if (anchor && typeof anchor.x === "number" && typeof anchor.y === "number") {
    return { left: anchor.x, top: anchor.y, bottom: anchor.y, right: anchor.x };
  }
  if (anchor && typeof anchor.getBoundingClientRect === "function") {
    const r = anchor.getBoundingClientRect();
    if (r && (r.width > 0 || r.height > 0 || r.left > 0 || r.top > 0)) {
      return { left: r.right + 6, top: r.top, bottom: r.bottom, right: r.right };
    }
  }
  return {
    left: Math.round((win.innerWidth || 800) * 0.25),
    top: Math.round((win.innerHeight || 600) * 0.25),
    bottom: Math.round((win.innerHeight || 600) * 0.25),
    right: Math.round((win.innerWidth || 800) * 0.25),
  };
};

/**
 * Open the searchable "Move to Folder…" Quick-Pick Popover anchored near the
 * clicked tab or cursor position.
 *
 * @param {Window} win
 * @param {Element|Element[]} targetTabs
 * @param {Element|{x:number,y:number}|null} [anchor]
 */
export const openMoveToFolderPopover = (win = globalThis.window, targetTabs = [], anchor = null) => {
  const doc = win?.document;
  if (!doc) return null;

  closeMoveToFolderPopover(win);

  const rawTabs = Array.isArray(targetTabs) ? targetTabs : targetTabs ? [targetTabs] : [];
  const tabs = rawTabs.filter(isTabMovableToFolder);
  if (tabs.length === 0) return null;

  const workspaceId =
    tabs[0].getAttribute?.("zen-workspace-id") ||
    win.gZenWorkspaces?.activeWorkspace ||
    null;
  const allFolders = collectActiveWorkspaceFolders(win, workspaceId, tabs);
  const { primary: primaryRule, all: allRuleSuggestions } = suggestRuleForTabs(tabs);

  const pop = createHtml(doc, "div", POPOVER_CLASS);
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-modal", "false");
  pop.setAttribute(
    "aria-label",
    tabs.length > 1
      ? msg("titleMulti", { count: tabs.length }, win)
      : msg("titleSingle", null, win),
  );

  // Header
  const header = createHtml(doc, "div", "zao-mf-header");
  const title = createHtml(doc, "span", "zao-mf-title");
  title.textContent =
    tabs.length > 1
      ? msg("titleMulti", { count: tabs.length }, win)
      : msg("titleSingle", null, win);
  const escBadge = createHtml(doc, "kbd", "zao-mf-kbd");
  escBadge.textContent = msg("escHint", null, win);
  header.append(title, escBadge);
  pop.appendChild(header);

  // Search box
  const searchWrap = createHtml(doc, "div", "zao-mf-search-wrap");
  const searchInput = createHtml(doc, "input", "zao-mf-search");
  searchInput.type = "search";
  searchInput.placeholder = msg("searchPlaceholder", null, win);
  searchInput.setAttribute("aria-label", msg("searchAria", null, win));
  searchInput.setAttribute("autocomplete", "off");
  searchInput.spellcheck = false;
  searchWrap.appendChild(searchInput);
  pop.appendChild(searchWrap);

  // List container
  const listEl = createHtml(doc, "div", "zao-mf-list");
  listEl.setAttribute("role", "listbox");
  pop.appendChild(listEl);

  // Inline create-folder row (revealed when clicking "+ New Folder…" with empty query)
  const createRow = createHtml(doc, "div", "zao-mf-create-row");
  createRow.hidden = true;
  const createInput = createHtml(doc, "input", "zao-mf-create-input");
  createInput.type = "text";
  createInput.placeholder = msg("newFolderPlaceholder", null, win);
  createInput.setAttribute("autocomplete", "off");
  const createSubmit = createHtml(doc, "button", "zao-mf-create-btn");
  createSubmit.type = "button";
  createSubmit.textContent = "↵";
  createRow.append(createInput, createSubmit);
  pop.appendChild(createRow);

  // Q8 Smart "Save as rule" footer
  let saveRuleCheckbox = null;
  if (primaryRule) {
    const footer = createHtml(doc, "div", "zao-mf-footer");
    const ruleLabel = createHtml(doc, "label", "zao-mf-rule-row");
    saveRuleCheckbox = createHtml(doc, "input", "zao-mf-rule-checkbox");
    saveRuleCheckbox.type = "checkbox";
    saveRuleCheckbox.checked = false;

    const ruleText = createHtml(doc, "span", "zao-mf-rule-label");
    ruleText.textContent = msg("saveAsRule", null, win);

    const preview = createHtml(doc, "code", "zao-mf-rule-preview");
    const extraCount = allRuleSuggestions.length - 1;
    preview.textContent = extraCount > 0
      ? `${primaryRule.pattern} (${msg("morePatterns", { n: extraCount }, win)})`
      : primaryRule.pattern;
    preview.title = allRuleSuggestions.map((s) => s.pattern).join(", ");

    ruleLabel.append(saveRuleCheckbox, ruleText, preview);
    footer.appendChild(ruleLabel);
    pop.appendChild(footer);
  }

  let closed = false;
  let attachTimer = null;
  let visibleEntries = [];
  let activeIndex = 0;

  const setActiveIndex = (idx) => {
    if (visibleEntries.length === 0) {
      activeIndex = -1;
      return;
    }
    const len = visibleEntries.length;
    activeIndex = ((idx % len) + len) % len;
    visibleEntries.forEach((entry, i) => {
      const isSelected = i === activeIndex;
      entry.row.classList.toggle("zao-mf-item-active", isSelected);
      entry.row.setAttribute("aria-selected", isSelected ? "true" : "false");
      if (isSelected) {
        try { entry.row.scrollIntoView?.({ block: "nearest" }); } catch {}
      }
    });
  };

  const maybeSaveRule = (folderName, color = null) => {
    if (saveRuleCheckbox?.checked && allRuleSuggestions.length > 0) {
      saveRuleSuggestionToFolder(folderName, allRuleSuggestions, { color });
    }
  };

  const executeExistingFolder = (folder) => {
    if (closed) return;
    moveTabsIntoExistingFolder(win, tabs, folder.groupEl);
    maybeSaveRule(folder.label, folder.rawColor);
    close();
  };

  const executeCreateFolder = (name) => {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      createRow.hidden = false;
      createInput.focus();
      return;
    }
    const created = createFolderForTabs(win, tabs, trimmed, workspaceId);
    if (created) {
      maybeSaveRule(trimmed, created.color || null);
    }
    close();
  };

  const renderList = () => {
    const query = searchInput.value.trim();
    const filtered = filterAndRankFolders(allFolders, query);
    const hasExactMatch = query
      ? allFolders.some((f) => f.label.toLowerCase() === query.toLowerCase())
      : false;

    while (listEl.firstChild) listEl.firstChild.remove();
    visibleEntries = [];

    if (filtered.length === 0 && !query) {
      const empty = createHtml(doc, "div", "zao-mf-empty");
      empty.textContent = msg("noFolders", null, win);
      listEl.appendChild(empty);
    } else {
      for (const folder of filtered) {
        const row = createHtml(doc, "button", "zao-mf-item");
        row.type = "button";
        row.setAttribute("role", "option");
        if (folder.isCurrent) row.classList.add("zao-mf-item-current");
        if (!query && folder.depth > 0) {
          row.classList.add("zao-mf-item-nested");
          row.style.setProperty("--zao-mf-depth", String(folder.depth));
        }

        const leading = createHtml(doc, "span", "zao-mf-leading");
        if (folder.emoji) {
          leading.classList.add("zao-mf-emoji");
          leading.textContent = folder.emoji;
        } else {
          const swatch = createHtml(doc, "span", "zao-mf-swatch");
          swatch.style.background = folder.color;
          leading.appendChild(swatch);
        }

        const labelSpan = createHtml(doc, "span", "zao-mf-name");
        labelSpan.textContent = folder.label;

        const meta = createHtml(doc, "span", "zao-mf-meta");
        meta.textContent = folder.isCurrent
          ? `✓ ${folder.count}`
          : String(folder.count);

        row.append(leading, labelSpan, meta);
        row.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          executeExistingFolder(folder);
        });
        row.addEventListener("mouseenter", () => {
          const idx = visibleEntries.findIndex((entry) => entry.row === row);
          if (idx !== -1) setActiveIndex(idx);
        });

        listEl.appendChild(row);
        visibleEntries.push({ kind: "folder", folder, row });
      }
    }

    // "+ New Folder…" / "+ Create "<query>"" action row
    if (!hasExactMatch) {
      const newRow = createHtml(doc, "button", "zao-mf-item zao-mf-item-new");
      newRow.type = "button";
      newRow.setAttribute("role", "option");
      const labelSpan = createHtml(doc, "span", "zao-mf-name");
      labelSpan.textContent = query
        ? msg("createNamed", { name: query }, win)
        : msg("newFolder", null, win);
      newRow.appendChild(labelSpan);
      newRow.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (query) {
          executeCreateFolder(query);
        } else {
          createRow.hidden = false;
          createInput.focus();
        }
      });
      newRow.addEventListener("mouseenter", () => {
        const idx = visibleEntries.findIndex((entry) => entry.row === newRow);
        if (idx !== -1) setActiveIndex(idx);
      });
      listEl.appendChild(newRow);
      visibleEntries.push({ kind: "create", query, row: newRow });
    }

    setActiveIndex(0);
  };

  searchInput.addEventListener("input", () => {
    if (!createRow.hidden && searchInput.value.trim()) {
      createRow.hidden = true;
    }
    renderList();
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex(activeIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const entry = visibleEntries[activeIndex];
      if (!entry) return;
      if (entry.kind === "folder") executeExistingFolder(entry.folder);
      else if (entry.query) executeCreateFolder(entry.query);
      else {
        createRow.hidden = false;
        createInput.focus();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  createInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      executeCreateFolder(createInput.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      createRow.hidden = true;
      searchInput.focus();
    }
  });

  createSubmit.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    executeCreateFolder(createInput.value);
  });

  const onOutsideMouseDown = (e) => {
    if (!pop.contains(e.target)) close();
  };

  const onGlobalKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const onWindowBlur = () => close();

  const positionPopover = () => {
    const pt = resolveAnchorPoint(win, anchor || tabs[0]);
    const rect = pop.getBoundingClientRect?.() || { width: 280, height: 320 };
    const w = rect.width || 280;
    const h = rect.height || 320;
    const pad = 10;
    const maxLeft = Math.max(pad, (win.innerWidth || 1024) - w - pad);
    const maxTop = Math.max(pad, (win.innerHeight || 768) - h - pad);
    const left = Math.min(Math.max(pad, pt.left), maxLeft);
    const top = Math.min(Math.max(pad, pt.top), maxTop);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (attachTimer != null) {
      (win.clearTimeout || clearTimeout)(attachTimer);
      attachTimer = null;
    }
    try { doc.removeEventListener("mousedown", onOutsideMouseDown, true); } catch {}
    try { doc.removeEventListener("keydown", onGlobalKeydown, true); } catch {}
    try { win.removeEventListener("blur", onWindowBlur); } catch {}
    try { win.removeEventListener("resize", positionPopover); } catch {}
    if (ACTIVE_POPOVERS.get(win)?.pop === pop) ACTIVE_POPOVERS.delete(win);
    try { pop.remove(); } catch {}
  };

  pop._zaoClose = close;
  const host = doc.body || doc.documentElement;
  host.appendChild(pop);
  renderList();
  positionPopover();

  const handle = { pop, close };
  ACTIVE_POPOVERS.set(win, handle);

  attachTimer = (win.setTimeout || setTimeout)(() => {
    attachTimer = null;
    if (closed) return;
    doc.addEventListener("mousedown", onOutsideMouseDown, true);
    doc.addEventListener("keydown", onGlobalKeydown, true);
    win.addEventListener("blur", onWindowBlur);
    win.addEventListener("resize", positionPopover, { passive: true });
    try { searchInput.focus({ preventScroll: true }); } catch { searchInput.focus?.(); }
  }, 0);

  return handle;
};
