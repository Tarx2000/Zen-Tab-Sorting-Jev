import { captureNewGroupAppearance } from "./group-appearance.mjs";
// Zen Tab Sorting — Pass 1: deterministic specificity-ranked rule → group matching.
// Pure logic over rules + tab info; applyPass1 mutates the DOM via gBrowser APIs.

import { LOG } from "./config.mjs";
import { findExistingGroup, expandIfCollapsed, collapseGroup, applyGroupColor, findSafeInsertAnchor } from "./groups.mjs";
import { normalizeDomainPattern, normalizeUrlPattern } from "./rules.mjs";

const normalizeHost = (hostname) => {
  if (!hostname) return "";
  return normalizeDomainPattern(String(hostname)).replace(/^\*\./, "");
};

// Match a hostname against a single rule-domain pattern (case-insensitive, normalized).
//   "host.com"    matches the bare host AND any subdomain
//   "*.host.com"  matches subdomains only (NOT the bare host)
export const matchesDomain = (hostname, pattern) => {
  const host = normalizeHost(hostname);
  const pat = normalizeDomainPattern(pattern);
  if (!host || !pat) return false;
  if (pat.startsWith("*.")) {
    const base = pat.slice(2);
    return base.length > 0 && host.endsWith("." + base);
  }
  return host === pat || host.endsWith("." + pat);
};

// Safe glob matcher (only `*` wildcard, linear/bounded regex without ReDoS).
const globToRegex = (glob) => {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
};

const extractNormalizedHostPath = (tabInfo) => {
  const rawUrl = String(tabInfo?.url || "").trim();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      let path = parsed.pathname.replace(/\/{2,}/g, "/");
      if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
      return `${host}${path}`;
    } catch {
      const stripped = normalizeUrlPattern(rawUrl);
      if (stripped) return stripped;
    }
  }
  return normalizeHost(tabInfo?.hostname);
};

// Match a URL pattern like "github.com/org/*" against a tab's normalized host + path.
export const matchesUrlPattern = (tabInfo, pattern) => {
  const normPat = normalizeUrlPattern(pattern);
  if (!normPat) return false;
  const candidate = extractNormalizedHostPath(tabInfo);
  if (!candidate) return false;
  if (normPat.includes("*")) {
    return globToRegex(normPat).test(candidate);
  }
  // Exact or path-prefix match (e.g., "github.com/org" matches "github.com/org" and "github.com/org/repo").
  const lowerCand = candidate.toLowerCase();
  const lowerPat = normPat.toLowerCase();
  if (lowerCand === lowerPat) return true;
  if (lowerPat.includes("/")) {
    return lowerCand.startsWith(lowerPat + "/");
  }
  return lowerCand === lowerPat || lowerCand.startsWith(lowerPat + "/");
};

// Match a title pattern (case-insensitive substring or `*` glob).
export const matchesTitlePattern = (title, pattern) => {
  const rawTitle = String(title || "").trim();
  const pat = String(pattern || "").trim();
  if (!rawTitle || !pat) return false;
  if (pat.includes("*")) {
    return globToRegex(pat).test(rawTitle);
  }
  return rawTitle.toLowerCase().includes(pat.toLowerCase());
};

const tabMatchesContainers = (tabInfo, containers) => {
  if (!Array.isArray(containers) || containers.length === 0) return true;
  const tabContainers = [
    tabInfo?.containerLabel,
    tabInfo?.container,
    tabInfo?.userContextId != null ? String(tabInfo.userContextId) : "",
  ]
    .map((v) => String(v || "").trim().toLowerCase())
    .filter(Boolean);
  if (tabContainers.length === 0) return false;
  return containers.some((c) => tabContainers.includes(String(c || "").trim().toLowerCase()));
};

// Specificity tiers (higher wins; ties broken by detailLength then rule array order):
//   500 — URL path pattern match (`urlPatterns`)
//   400 — Exact host match (`hostname === pattern`)
//   300 — Wildcard subdomain match (`*.sub.domain.com`)
//   200 — Parent domain match (`domain.com` matching `sub.domain.com`)
//   150 — Title pattern match (`titlePatterns`)
//   100 — Container-only match (`containers`)
// Container constraint adds a +10 specificity bonus when combined with another matcher.
const scoreRuleForTab = (tabInfo, rule) => {
  if (!rule || !rule.name) return null;

  const hasContainers = Array.isArray(rule.containers) && rule.containers.length > 0;
  if (hasContainers && !tabMatchesContainers(tabInfo, rule.containers)) {
    return null;
  }

  const containerBonus = hasContainers ? 10 : 0;
  let bestTier = 0;
  let bestDetail = 0;

  // 1. URL path patterns (highest specificity)
  if (Array.isArray(rule.urlPatterns)) {
    for (const pat of rule.urlPatterns) {
      if (matchesUrlPattern(tabInfo, pat)) {
        const cleanLen = normalizeUrlPattern(pat).replace(/\*/g, "").length;
        if (500 > bestTier || (500 === bestTier && cleanLen > bestDetail)) {
          bestTier = 500;
          bestDetail = cleanLen;
        }
      }
    }
  }

  // 2-4. Domain patterns: exact host > *.subdomain > parent domain
  const host = normalizeHost(tabInfo?.hostname);
  if (host && Array.isArray(rule.domains)) {
    for (const rawDomain of rule.domains) {
      const pat = normalizeDomainPattern(rawDomain);
      if (!pat) continue;
      if (pat.startsWith("*.")) {
        const base = pat.slice(2);
        if (base && host.endsWith("." + base)) {
          const score = 300;
          const detail = base.length;
          if (score > bestTier || (score === bestTier && detail > bestDetail)) {
            bestTier = score;
            bestDetail = detail;
          }
        }
      } else if (host === pat) {
        const score = 400;
        const detail = pat.length;
        if (score > bestTier || (score === bestTier && detail > bestDetail)) {
          bestTier = score;
          bestDetail = detail;
        }
      } else if (host.endsWith("." + pat)) {
        const score = 200;
        const detail = pat.length;
        if (score > bestTier || (score === bestTier && detail > bestDetail)) {
          bestTier = score;
          bestDetail = detail;
        }
      }
    }
  }

  // 5. Title patterns
  if (Array.isArray(rule.titlePatterns)) {
    for (const pat of rule.titlePatterns) {
      if (matchesTitlePattern(tabInfo?.title, pat)) {
        const cleanLen = String(pat).replace(/\*/g, "").trim().length;
        if (150 > bestTier || (150 === bestTier && cleanLen > bestDetail)) {
          bestTier = 150;
          bestDetail = cleanLen;
        }
      }
    }
  }

  // 6. Container-only rule (no domains, urlPatterns, or titlePatterns configured)
  const hasOtherMatchers =
    (Array.isArray(rule.domains) && rule.domains.length > 0) ||
    (Array.isArray(rule.urlPatterns) && rule.urlPatterns.length > 0) ||
    (Array.isArray(rule.titlePatterns) && rule.titlePatterns.length > 0);

  if (bestTier === 0) {
    if (hasContainers && !hasOtherMatchers) {
      return { tier: 100, detail: 1 };
    }
    return null;
  }

  return { tier: bestTier + containerBonus, detail: bestDetail };
};

// Specificity-ranked rule selection:
//   URL path pattern > exact host > *.subdomain > parent domain > title pattern > container > rule order.
export const findGroupForTab = (tabInfo, rules) => {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  let winner = null;
  let winnerScore = null;

  for (const rule of rules) {
    const score = scoreRuleForTab(tabInfo, rule);
    if (!score) continue;
    if (
      !winnerScore ||
      score.tier > winnerScore.tier ||
      (score.tier === winnerScore.tier && score.detail > winnerScore.detail)
    ) {
      winner = rule.name;
      winnerScore = score;
    }
  }
  return winner;
};

const normGroupName = (name) => String(name || "").trim().toLowerCase();

/**
 * Plan what to do with each eligible tab based on the current rules. PURE — no DOM
 * mutation. `applyPass1` consumes the byGroup bucket to actually move tabs.
 *
 * @param {Array} tabs   — output of `getEligibleTabs().tabs`
 * @param {Array} rules  — output of `loadRules()`
 * @returns {{
 *   assignments,    // tabs with .group set (target rule name) or null
 *   byGroup,        // Map<groupName, items[]> — tabs to MOVE into the named group
 *   unmatched,      // items[] — no rule matches; left wherever they are
 *   alreadyCorrect, // items[] — matched and already in the right group; no-op
 * }}
 */
export const runPass1 = (tabs, rules) => {
  const assignments = tabs.map((t) => ({ ...t, group: findGroupForTab(t, rules) }));
  const byGroup = new Map();
  const unmatched = [];
  const alreadyCorrect = [];
  for (const a of assignments) {
    if (!a.group) {
      unmatched.push(a);
    } else if (normGroupName(a.group) === normGroupName(a.currentGroup)) {
      alreadyCorrect.push(a);
    } else {
      if (!byGroup.has(a.group)) byGroup.set(a.group, []);
      byGroup.get(a.group).push(a);
    }
  }
  return { assignments, byGroup, unmatched, alreadyCorrect };
};

/**
 * Execute the moves planned by `runPass1`. Creates new tab-groups when needed,
 * reuses existing ones, and applies per-rule colors after placement.
 *
 * @param {Map<string, Array>} byGroup
 * @param {string} workspaceId
 * @param {Array} rules
 * @param {object} [options]
 * @param {boolean} [options.deferCollapse=false]
 * @returns {{ movedToExisting, createdGroups, movedToNew, errors[] }} counts + per-group error messages.
 */
export const applyPass1 = (byGroup, workspaceId, rules, options = {}) => {
  const deferCollapse = Boolean(options?.deferCollapse);
  let movedToExisting = 0;
  let createdGroups = 0;
  let movedToNew = 0;
  const errors = [];

  const colorByLowerName = new Map(
    (rules || [])
      .filter((r) => r?.name && r?.color)
      .map((r) => [normGroupName(r.name), r.color]),
  );

  for (const [groupName, items] of byGroup) {
    const targetLower = normGroupName(groupName);
    const groupColor = colorByLowerName.get(targetLower);

    // Resolve each item's tab info to its live DOM node (`_tab`) and re-check the
    // current group from the DOM. We re-check (rather than trusting the `currentGroup`
    // field set by runPass1) because the DOM may have changed between planning and
    // applying — e.g. the user dragged a tab, or the consolidate/dissolve passes ran.
    const tabsForGroup = items
      .map((item) => item._tab)
      .filter((t) => {
        if (!t?.isConnected) return false;
        const currentGroupName = t.closest("tab-group")?.getAttribute("label");
        return normGroupName(currentGroupName) !== targetLower;
      });

    if (tabsForGroup.length === 0) continue;

    const existing = findExistingGroup(groupName, workspaceId);

    if (existing?.isConnected) {
      console.log(`${LOG} reusing existing group "${groupName}" (${tabsForGroup.length} tab(s) to move in)`);
      try {
        // Remember if the group was collapsed BEFORE we touched it. If so,
        // we re-collapse after adding the new tabs so the user's collapse
        // state isn't lost AND the new tabs get properly aria-hidden'd
        // via the property setter on collapse.
        const wasCollapsed = expandIfCollapsed(existing);
        for (const tab of tabsForGroup) {
          if (!tab.isConnected) continue;
          if (tab.closest("tab-group") === existing) continue;
          gBrowser.moveTabToExistingGroup(tab, existing);
          movedToExisting++;
        }
        if (groupColor) applyGroupColor(existing, groupColor);
        if (wasCollapsed) {
          if (deferCollapse) {
            const groupRef = existing;
            setTimeout(() => collapseGroup(groupRef), 0);
          } else {
            collapseGroup(existing);
          }
        }
      } catch (e) {
        console.error(`${LOG} error moving tabs into "${groupName}":`, e);
        errors.push({ group: groupName, error: e.message });
      }
    } else {
      console.log(`${LOG} creating new group "${groupName}" (${tabsForGroup.length} tab(s))`);
      try {
        const newGroup = gBrowser.addTabGroup(tabsForGroup, {
          label: groupName,
          // Anchor at a DOM position OUTSIDE any enclosing tab-group; otherwise
          // Zen creates the new group as a child of the old one (nesting bug).
          insertBefore: findSafeInsertAnchor(),
        });
        if (newGroup) {
          captureNewGroupAppearance(newGroup);
          createdGroups++;
          movedToNew += tabsForGroup.length;
          if (groupColor) applyGroupColor(newGroup, groupColor);
        } else {
          console.warn(`${LOG} addTabGroup returned no element for "${groupName}"`);
          errors.push({ group: groupName, error: "addTabGroup returned null" });
        }
      } catch (e) {
        console.error(`${LOG} error creating group "${groupName}":`, e);
        errors.push({ group: groupName, error: e.message });
      }
    }
  }

  return { movedToExisting, createdGroups, movedToNew, errors };
};
