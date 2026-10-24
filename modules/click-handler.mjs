// Zen Tab Sorting — tidy-button click orchestrator.
// Sequences: consolidate → load rules (optional) → enumerate tabs
//            → JEV Stage 1 (existing workspace groups) + Fallback-LLM Stage 2 (new groups)
//            → apply → ungrouped-to-top → sync colors.

import { CONFIG, LOG, BUILD_VERSION } from "./config.mjs";
import {
  loadRules,
  readSkipDomainsPref,
  isStrictRulesEnforced,
  isDomainRulesEnabled,
  getAIEngine,
  getAISortMode,
  getOllamaHost,
  getOllamaModel,
  getAINewGroupBehavior,
  getAIExistingBehavior,
} from "./rules.mjs";
import { getEligibleTabs, getTabUrl } from "./tabs.mjs";
import { animateSidebarChanges } from "./sort-animation.mjs";
import { withSortSession } from "./sort-session.mjs";
import { saveGroupState } from "./group-state.mjs";
import {
  consolidateDuplicateGroups,
  dissolveStaleGroups,
  dissolveEmptyGroups,
  getWorkspaceExistingGroups,
  moveTabsToTop,
  moveUngroupedToTop,
  syncAllGroupColors,
  collapseGroup,
} from "./groups.mjs";
import { runPass1, applyPass1, matchesDomain } from "./pass1.mjs";
import { runPass2, runPass2Fresh, applyPass2 } from "./ai.mjs";
import { checkOllamaReady, reportOllamaError, normalizeOllamaHost, runPass2Ollama, runPass2OllamaFresh, classifyExistingGroupsBatch } from "./ollama.mjs";
import {
  runPass2JevHybrid,
  runPass2Remote,
  runPass2RemoteFresh,
  classifyExistingGroupsRemoteBatch,
} from "./remote-provider.mjs";
import { showToast } from "./ui-toast.mjs";
import { showPreviewModal } from "./preview-modal.mjs";
import { recordDebugEvent } from "./debug-journal.mjs";
import { isFullAIMode, resolveEffectiveSortingMode, resolvePass2ApplyOptions, resolveSortingPlan } from "./sorting-mode.mjs";

console.log(`${LOG} click-handler.mjs loaded — v${BUILD_VERSION}`);

const actionFor = (currentGroup, targetGroup) => {
  if (!targetGroup) return "leave";
  if (targetGroup === currentGroup) return "stay";
  if (currentGroup) return "move";
  return "group";
};

const assignmentMapToPlan = (tabs, assignmentMap) => {
  const assignments = [];
  const skipped = [];
  for (let i = 0; i < tabs.length; i++) {
    const groupName = assignmentMap.get(i);
    if (groupName) assignments.push({ tabInfo: tabs[i], groupName });
    else skipped.push(tabs[i]);
  }
  return { assignments, skipped };
};

const organizeCurrentWorkspace = async () => {
  recordDebugEvent("START", "Zauberstab geklickt — starte Sortierung");

  const workspaceId = window.gZenWorkspaces?.activeWorkspace;
  if (!workspaceId) {
    recordDebugEvent("ERROR", "Kein aktiver Workspace gefunden (window.gZenWorkspaces?.activeWorkspace ist leer)");
    console.warn(`${LOG} no active workspace`);
    showToast("Kein aktiver Workspace gefunden.", { type: "warning" });
    return;
  }

  console.log(`${LOG} click START — v${BUILD_VERSION}`);
  const aiEngine = getAIEngine();
  recordDebugEvent("WORKSPACE", `Aktiver Workspace: "${workspaceId}", AI Engine: "${aiEngine}"`);
  const sortMode = resolveEffectiveSortingMode({ aiEngine, preferredMode: getAISortMode() });
  const fullAIMode = isFullAIMode(sortMode);
  const domainRulesEnabled = isDomainRulesEnabled();

  // 1. Merge any duplicate-name groups before lookups assume uniqueness.
  const mutations = [];
  mutations.push(() => consolidateDuplicateGroups(workspaceId));

  // 2. Load optional domain rules (empty by default when domain rules are disabled).
  const rules = await loadRules();

  // 3. Never dissolve existing workspace groups unless deterministic domain rules AND
  //    strict rule enforcement are explicitly enabled. Existing user/AI groups are
  //    preserved as anchor categories for JEV.
  if (!fullAIMode && domainRulesEnabled && isStrictRulesEnforced() && rules.length > 0) {
    mutations.push(() => dissolveStaleGroups(workspaceId, rules));
  } else {
    console.log(`${LOG} preserving existing workspace tab groups (domainRules=${domainRulesEnabled})`);
  }

  // 4. Enumerate eligible tabs.
  const allTabs = getEligibleTabs().tabs;
  const originalTabs = allTabs.map((info) => ({ node: info._tab, parent: info._tab.parentElement, url: info.url }));
  if (!fullAIMode && domainRulesEnabled && isStrictRulesEnforced() && rules.length > 0) {
    const names = new Set(rules.map((rule) => rule.name));
    for (const info of allTabs) if (info.currentGroup && !names.has(info.currentGroup)) info.currentGroup = null;
  }
  if (allTabs.length === 0) {
    recordDebugEvent("TABS", `Keine sortierbaren Tabs im Workspace "${workspaceId}" gefunden.`);
    console.log(`${LOG} no eligible tabs in workspace ${workspaceId}`);
    showToast("Keine sortierbaren Tabs im aktuellen Workspace gefunden.");
    return;
  }
  recordDebugEvent("TABS", `${allTabs.length} sortierbare Tabs gefunden`, {
    tabs: allTabs.map((t) => ({ title: t.title, hostname: t.hostname, group: t.currentGroup }))
  });

  // 4b. Handle skip-domains.
  const skipPatterns = readSkipDomainsPref();
  let tabs = allTabs;
  if (skipPatterns.length > 0) {
    const skipped = allTabs.filter((t) =>
      skipPatterns.some((p) => matchesDomain(t.hostname, p))
    );
    if (skipped.length > 0) {
      mutations.push(() => moveTabsToTop(skipped.map((s) => s._tab), workspaceId));
      const skippedSet = new Set(skipped);
      tabs = allTabs.filter((t) => !skippedSet.has(t));
    }
  }
  if (tabs.length === 0) {
    console.log(`${LOG} no non-skipped eligible tabs in workspace ${workspaceId}`);
    if (window.gZenWorkspaces.activeWorkspace === workspaceId) {
      await animateSidebarChanges(window, () => { for (const mutate of mutations) mutate(); });
    }
    return;
  }

  // 5. Pass 1 matching (only moves tabs if optional domain rules exist).
  const { assignments, byGroup, unmatched, alreadyCorrect } = runPass1(tabs, rules);

  const newGroupBehavior = aiEngine !== "off" ? getAINewGroupBehavior() : "";
  const isFreshMode = fullAIMode || newGroupBehavior === "fresh-categories";
  const isIdentifyOnly = newGroupBehavior === "identify-only";
  const isFreshLike = isFreshMode || isIdentifyOnly;

  console.groupCollapsed(
    `${LOG} Pass 1 — ${tabs.length} tabs · ${alreadyCorrect.length} already correct · ${byGroup.size} group(s) to update · ${unmatched.length} unmatched`
  );
  try {
    console.log("Per-tab assignments:");
    console.table(
      assignments.map(({ id, hostname, title, currentGroup, group }) => ({
        id,
        hostname,
        from: currentGroup || "—",
        to: group || "—",
        action: actionFor(currentGroup, group),
        title,
      }))
    );

    if (byGroup.size > 0) {
      console.log("Pending moves by group:");
      console.table(
        Array.from(byGroup.entries()).map(([name, items]) => ({
          target: name,
          count: items.length,
          from: items.map((t) => t.currentGroup || "—").join(", "),
          hosts: items.map((t) => t.hostname).join(", "),
        }))
      );
    }

    // 6. Apply Pass 1 moves (if any optional domain rules matched).
    const sortingPlan = resolveSortingPlan({ mode: sortMode, tabs, pass1: { byGroup, unmatched } });
    if (sortingPlan.shouldApplyPass1 && sortingPlan.pass1ByGroup.size > 0) {
      mutations.push(() => applyPass1(sortingPlan.pass1ByGroup, workspaceId, rules));

      if (domainRulesEnabled && isStrictRulesEnforced()) {
        const candidates = unmatched.filter((t) => t.currentGroup && t._tab?.isConnected);
        if (candidates.length > 0) {
          mutations.push(() => moveTabsToTop(candidates.map((t) => t._tab), workspaceId));
          for (const t of candidates) t.currentGroup = null;
        }
      }
    }

    // 7. Pass 2 (AI).
    // By default (non-fresh modes), only evaluate currently UNGROUPED tabs so tabs
    // already organized inside existing `<tab-group>` folders remain untouched and
    // serve as live context anchors for JEV.
    const rawPass2Candidates = isFreshLike ? tabs : sortingPlan.tabsForAI;
    const pass2Input = isFreshLike
      ? tabs
      : rawPass2Candidates.filter((t) => !t.currentGroup);

    const shouldRunPass2 = aiEngine !== "off" && pass2Input.length > 0;
    const isRemoteEngine = ["jev", "chatgpt", "primalabs", "openai", "gemini", "custom"].includes(aiEngine);

    if (!shouldRunPass2 && pass2Input.length === 0 && isRemoteEngine) {
      showToast("No ungrouped tabs left to sort.");
    }

    if (shouldRunPass2) {
      const inputCount = pass2Input.length;
      const inputLabel = isFreshLike ? "ALL eligible tab(s)" : "ungrouped tab(s)";
      const modeSuffix = isIdentifyOnly ? " (identify-only)" : isFreshMode ? ` (${sortMode === "full-ai" ? "full-ai" : "fresh-categories"})` : "";
      console.log(`${LOG} Pass 2 — running ${aiEngine}${modeSuffix} AI over ${inputCount} ${inputLabel}...`);
      try {
        let pass2;
        if (aiEngine === "jev") {
          const t0 = performance.now();
          // JEV specifically classifies into existing workspace groups; always provide
          // the live workspace groups (or rules if 0 DOM groups exist yet).
          let liveExistingGroups = getWorkspaceExistingGroups(workspaceId);
          if (!fullAIMode && domainRulesEnabled && isStrictRulesEnforced() && rules.length > 0) {
            const names = new Set(rules.map((rule) => rule.name));
            liveExistingGroups = liveExistingGroups.filter((group) => names.has(group.name));
          }
          if (liveExistingGroups.length === 0 && rules.length > 0) {
            liveExistingGroups = rules.filter((r) => r?.name).map((r) => ({
              name: r.name,
              domains: r.domains || [],
              tabs: [],
            }));
          }
          // Pass 1 is planned, not applied yet. Include its future groups as
          // existing target context without touching the browser during planning.
          for (const [name, items] of sortingPlan.pass1ByGroup) {
            if (!liveExistingGroups.some((group) => group.name === name)) {
              liveExistingGroups.push({ name, domains: [...new Set(items.map((tab) => tab.hostname))], tabs: items });
            }
          }
          pass2 = await runPass2JevHybrid(pass2Input, liveExistingGroups);
          console.log(`${LOG} JEV + Fallback-LLM Pass 2 took ${Math.round(performance.now() - t0)}ms`);
        } else if (aiEngine === "ollama") {
          const host = getOllamaHost();
          const model = getOllamaModel();
          const status = await checkOllamaReady(host, model);
          if (!status.reachable || !status.modelAvailable) {
            reportOllamaError(host, model, status);
            pass2 = { assignedToExisting: [], newGroups: [], skipped: isFreshMode ? tabs : pass2Input };
          } else {
            console.debug(`${LOG} Ollama ready at ${normalizeOllamaHost(host)} (model: ${model})`);
            const t0 = performance.now();
            const effectiveRules = rules.length > 0 ? rules : getWorkspaceExistingGroups(workspaceId);
            if (isFreshLike) {
              pass2 = await runPass2OllamaFresh(tabs);
            } else {
              pass2 = await runPass2Ollama(pass2Input, effectiveRules);
            }
            console.log(`${LOG} Ollama Pass 2 took ${Math.round(performance.now() - t0)}ms`);
          }
        } else if (["chatgpt", "primalabs", "openai", "gemini", "custom"].includes(aiEngine)) {
          const t0 = performance.now();
          const effectiveRules = rules.length > 0 ? rules : getWorkspaceExistingGroups(workspaceId);
          pass2 = isFreshLike
            ? await runPass2RemoteFresh(tabs)
            : await runPass2Remote(pass2Input, effectiveRules);
          console.log(`${LOG} ${aiEngine} Pass 2 took ${Math.round(performance.now() - t0)}ms`);
        } else {
          const localInput = pass2Input;
          let cancelled = false;
          if (localInput.length > CONFIG.AI_LOCAL_CONFIRM_THRESHOLD) {
            const proceed = window.confirm(
              `You have ${localInput.length} ${isFreshLike ? "" : "unmatched "}tabs.\n\n` +
              `Running the Local AI on this many can take minutes and briefly lag the browser.\n\n` +
              `Continue?`
            );
            if (!proceed) {
              console.log(`${LOG} Pass 2 cancelled by user (soft cap at ${CONFIG.AI_LOCAL_CONFIRM_THRESHOLD})`);
              pass2 = { assignedToExisting: [], newGroups: [], skipped: localInput };
              cancelled = true;
            }
          }
          if (!cancelled) {
            const effectiveRules = rules.length > 0 ? rules : getWorkspaceExistingGroups(workspaceId);
            if (isFreshLike) {
              pass2 = await runPass2Fresh(tabs);
            } else {
              pass2 = await runPass2(pass2Input, effectiveRules, workspaceId);
            }
          }
        }

        if (pass2.assignedToExisting.length > 0 || pass2.newGroups.length > 0) {
          console.log(`${LOG} Pass 2 plan: ${pass2.assignedToExisting.length} to existing group(s), ${pass2.newGroups.length} new group(s), ${pass2.skipped.length} skipped`);
          if (pass2.assignedToExisting.length > 0) {
            console.table(pass2.assignedToExisting.map((a) => ({
              hostname: a.tabInfo.hostname,
              "→ existing group": a.groupName,
              similarity: a.similarity.toFixed(3),
            })));
          }
          if (pass2.newGroups.length > 0) {
            console.table(pass2.newGroups.map((g) => ({
              "new group": g.name,
              tabs: g.tabs.map((t) => t.hostname).join(", "),
            })));
          }

          let planToApply = pass2;
          let showModal = false;
          let modalReason = "";
          if (isIdentifyOnly) {
            showModal = true;
            modalReason = "Plan Mode";
          } else if (domainRulesEnabled && aiEngine === "ollama" && !isFreshMode && newGroupBehavior !== "prompt") {
            const existingBehavior = getAIExistingBehavior();
            const flags = [];
            if (existingBehavior === "always-add") flags.push("always-add");
            if (newGroupBehavior === "auto-add") flags.push("auto-add");
            if (flags.length > 0) {
              showModal = true;
              modalReason = flags.join(" + ");
            }
          }

          if (showModal) {
            const existingTargets = rules.length > 0 ? rules : getWorkspaceExistingGroups(workspaceId);
            console.debug(`${LOG} Plan Mode modal opening (${modalReason})`);
            planToApply = await showPreviewModal({
              plan: pass2,
              onReassignToNew: async (pendingTabs) => {
                const r = aiEngine === "local"
                  ? await runPass2Fresh(pendingTabs)
                  : aiEngine === "ollama"
                    ? await runPass2OllamaFresh(pendingTabs)
                    : await runPass2RemoteFresh(pendingTabs);
                return { newGroups: r.newGroups, skipped: r.skipped };
              },
              onAssignToPlanned: async (pendingTabs, keptBuckets) => {
                const fakeRules = keptBuckets.map((g) => ({
                  name: g.name,
                  domains: [...new Set(g.tabs.map((t) => t.hostname).filter((h) => h))],
                  tabs: g.tabs,
                }));
                if (aiEngine === "jev") {
                  const res = await runPass2JevHybrid(pendingTabs, fakeRules);
                  return { assignments: res.assignedToExisting, skipped: [...res.skipped, ...res.newGroups.flatMap((g) => g.tabs)] };
                }
                if (aiEngine === "local") {
                  const local = await runPass2(pendingTabs, fakeRules, workspaceId);
                  return { assignments: local.assignedToExisting, skipped: local.skipped };
                }
                const assignmentMap = aiEngine === "ollama"
                  ? await classifyExistingGroupsBatch(pendingTabs, fakeRules, getOllamaHost(), getOllamaModel())
                  : await classifyExistingGroupsRemoteBatch(pendingTabs, fakeRules);
                return assignmentMapToPlan(pendingTabs, assignmentMap);
              },
              onAssignToExisting: existingTargets.length > 0 ? async (pendingTabs) => {
                if (aiEngine === "jev") {
                  const res = await runPass2JevHybrid(pendingTabs, existingTargets);
                  return { assignments: res.assignedToExisting, skipped: [...res.skipped, ...res.newGroups.flatMap((g) => g.tabs)] };
                }
                if (aiEngine === "local") {
                  const local = await runPass2(pendingTabs, existingTargets, workspaceId);
                  return { assignments: local.assignedToExisting, skipped: local.skipped };
                }
                const assignmentMap = aiEngine === "ollama"
                  ? await classifyExistingGroupsBatch(pendingTabs, existingTargets, getOllamaHost(), getOllamaModel())
                  : await classifyExistingGroupsRemoteBatch(pendingTabs, existingTargets);
                return assignmentMapToPlan(pendingTabs, assignmentMap);
              } : undefined,
            });
            if (planToApply === null) {
              console.log(`${LOG} ${modalReason}: user cancelled — no changes applied`);
              return;
            }
          }

          if (planToApply) {
            const confirmedPlan = planToApply;
            mutations.push(() => {
              const applyOpts = domainRulesEnabled
                ? resolvePass2ApplyOptions(sortMode)
                : { existingBehavior: "transient", newGroupBehavior: "transient", persistRules: false };
              const ai = applyPass2(confirmedPlan, workspaceId, rules, applyOpts);
              recordDebugEvent("APPLY", `Pass 2 applied: ${ai.movedToExisting} tabs moved into existing groups, ${ai.newGroupsCreated} new groups created`);
              console.log(`${LOG} Pass 2 applied: ${ai.movedToExisting} tab(s) → existing groups, ${ai.newGroupsCreated} new group(s), ${ai.rulesGrown} rule(s) grown, ${ai.newRulesCreated} new rule(s)`);
              pass2 = confirmedPlan;

              if (isFreshLike) {
                const tabsContainer = window.gZenWorkspaces?.activeWorkspaceElement?.tabsContainer;
                if (tabsContainer) {
                  let movedSkipped = 0;
                  for (const tabInfo of pass2.skipped) {
                    const tab = tabInfo?._tab;
                    if (!tab?.isConnected) continue;
                    if (tab.closest("tab-group")) {
                      try {
                        tabsContainer.insertBefore(tab, tabsContainer.firstChild);
                        movedSkipped++;
                      } catch (e) {
                        console.error(`${LOG} error ungrouping skipped tab:`, e);
                      }
                    }
                  }
                  if (movedSkipped > 0) console.log(`${LOG} ${newGroupBehavior} mode: ungrouped ${movedSkipped} AI-skipped tab(s) from their previous groups`);
                }
                const dropped = dissolveEmptyGroups();
                if (dropped > 0) console.log(`${LOG} dissolved ${dropped} empty group(s) after re-tidy`);
              }
            });
          }
        } else if (pass2.skipped.length > 0) {
          console.log(`${LOG} Pass 2: nothing to group (skipped ${pass2.skipped.length} ${inputLabel})`);
          recordDebugEvent("RESULT", `Pass 2: nothing to group (skipped ${pass2.skipped.length} tabs)`);
          // Provider failures already display their actionable notification.
          if (!pass2.failed) {
            showToast("Keine Tabs zum Gruppieren gefunden oder Konfidenz-Schwelle nicht erreicht.");
          }
        }
      } catch (e) {
        console.error(`${LOG} Pass 2 failed:`, e);
      }
    }

    // 8. Push any remaining ungrouped tabs to the top of the list.
    mutations.push(() => moveUngroupedToTop(workspaceId));

    // 9. Sync styling.
    mutations.push(() => syncAllGroupColors(workspaceId, rules));

    if (window.gZenWorkspaces.activeWorkspace !== workspaceId || originalTabs.some(({ node, parent, url }) =>
      !node.isConnected || node.parentElement !== parent || node.getAttribute("zen-workspace-id") !== workspaceId || getTabUrl(node) !== url)) {
      showToast("Tabs oder Workspace wurden während der Berechnung verändert. Bitte die Sortierung erneut starten.", { type: "warning" });
      return;
    }
    const collapsed = [...window.gZenWorkspaces.activeWorkspaceElement.querySelectorAll("tab-group[collapsed]")];
    await animateSidebarChanges(window, () => {
      for (const mutate of mutations) mutate();
      collapsed.forEach((group) => { if (group.isConnected) collapseGroup(group); });
      window.gBrowser.tabContainer._invalidateCachedTabs?.();
      window.gZenWorkspaces.updateTabsContainers?.();
      void window.gBrowser.tabs.length;
      saveGroupState(window);
    });

    try {
      const allGroups = document.querySelectorAll("tab-group").length;
      const nestedGroups = document.querySelectorAll("tab-group tab-group").length;
      if (nestedGroups > 0) {
        console.warn(`${LOG} ⚠ NESTED TAB-GROUPS DETECTED: ${nestedGroups} group(s) inside other groups (total ${allGroups}).`);
      }
    } catch (e) {
      console.error(`${LOG} nesting diagnostic failed:`, e);
    }

    try {
      window.gZenWorkspaces?.updateTabsContainers?.();
      void window.gBrowser?.tabs?.length;
    } catch (e) {
      console.warn(`${LOG} tab-list settle failed (non-fatal):`, e);
    }
  } finally {
    console.groupEnd();
  }

  console.log(`${LOG} click END`);
};

export const handleOrganizeClick = ({ workspaceId, fromLibrary = false } = {}) => withSortSession("tabs", async () => {
  const manager = window.gZenWorkspaces;
  if (!fromLibrary) return organizeCurrentWorkspace();
  if (!workspaceId || !manager.getWorkspaces().some((space) => space.uuid === workspaceId)) {
    showToast("Dieser Space ist nicht mehr verfügbar.", { type: "warning" });
    return;
  }
  const originalSpace = manager.activeWorkspace;
  const originalTab = window.gBrowser.selectedTab;
  let sortTab;
  try {
    // Existing grouping APIs operate on the active native strip, never on the
    // Library's copies. Activate the requested card inside the shared sort lock.
    if (originalSpace !== workspaceId) await manager.changeWorkspaceWithID(workspaceId);
    sortTab = window.gBrowser.selectedTab;
    return await organizeCurrentWorkspace();
  } finally {
    // Respect navigation while the provider was working.
    if (originalSpace !== workspaceId && manager.activeWorkspace === workspaceId &&
        window.gBrowser.selectedTab === sortTab &&
        manager.getWorkspaces().some((space) => space.uuid === originalSpace)) {
      await manager.changeWorkspaceWithID(originalSpace);
      if (originalTab?.isConnected && !originalTab.closing) window.gBrowser.selectedTab = originalTab;
    }
    window.document.querySelector("zen-library-spaces-section")?.refreshStripsNow?.();
  }
}, window, { workspaceId });
