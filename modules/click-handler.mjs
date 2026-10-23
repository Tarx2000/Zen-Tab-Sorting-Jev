// Zen Tab Sorting — tidy-button click orchestrator.
// Sequences: wiggle → consolidate → load rules (optional) → enumerate tabs
//            → JEV Stage 1 (existing workspace groups) + Fallback-LLM Stage 2 (new groups)
//            → apply → ungrouped-to-top → sync colors.

import { CONFIG, LOG, BUILD_VERSION } from "./config.mjs";
import {
  loadRules,
  readSkipDomainsPref,
  isMinimalStyle,
  isStrictRulesEnforced,
  isDomainRulesEnabled,
  getAIEngine,
  getAISortMode,
  getOllamaHost,
  getOllamaModel,
  getAINewGroupBehavior,
  getAIExistingBehavior,
} from "./rules.mjs";
import { getEligibleTabs } from "./tabs.mjs";
import {
  consolidateDuplicateGroups,
  dissolveStaleGroups,
  dissolveEmptyGroups,
  getWorkspaceExistingGroups,
  moveTabsToTop,
  moveUngroupedToTop,
  syncAllGroupColors,
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

const getTidyButton = () =>
  window.gZenWorkspaces?.activeWorkspaceElement?.querySelector?.(`#${CONFIG.BUTTON_ID}`) ||
  document.querySelector?.(`#${CONFIG.BUTTON_ID}`) ||
  null;

const wiggleButton = () => {
  try {
    const button = getTidyButton();
    if (!button) return;
    button.classList.remove("zao-wiggling");
    void button.offsetWidth;
    button.classList.add("zao-wiggling");
    setTimeout(() => {
      if (button.isConnected) button.classList.remove("zao-wiggling");
    }, CONFIG.WIGGLE_DURATION_MS);
  } catch (e) {
    console.error(`${LOG} wiggle error:`, e);
  }
};

const setButtonThinking = (thinking) => {
  try {
    const button = getTidyButton();
    if (!button) return;
    button.classList.toggle("zao-thinking", !!thinking);
  } catch (e) {
    console.error(`${LOG} setButtonThinking error:`, e);
  }
};

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

export const handleOrganizeClick = async () => {
  recordDebugEvent("START", "Zauberstab geklickt — starte Sortierung");
  wiggleButton();

  const workspaceId = window.gZenWorkspaces?.activeWorkspace;
  if (!workspaceId) {
    recordDebugEvent("ERROR", "Kein aktiver Workspace gefunden (window.gZenWorkspaces?.activeWorkspace ist leer)");
    console.warn(`${LOG} no active workspace`);
    showToast("Kein aktiver Workspace gefunden.");
    return;
  }

  console.log(`${LOG} click START — v${BUILD_VERSION}`);
  const aiEngine = getAIEngine();
  recordDebugEvent("WORKSPACE", `Aktiver Workspace: "${workspaceId}", AI Engine: "${aiEngine}"`);
  const sortMode = resolveEffectiveSortingMode({ aiEngine, preferredMode: getAISortMode() });
  const fullAIMode = isFullAIMode(sortMode);
  const domainRulesEnabled = isDomainRulesEnabled();

  // 1. Merge any duplicate-name groups before lookups assume uniqueness.
  const consolidation = consolidateDuplicateGroups(workspaceId);
  if (consolidation.mergedLabels > 0) {
    console.log(`${LOG} pre-pass consolidation: merged ${consolidation.mergedLabels} duplicate label(s), moved ${consolidation.tabsMoved} tab(s)`);
  }

  // 2. Load optional domain rules (empty by default when domain rules are disabled).
  const rules = await loadRules();

  // 3. Never dissolve existing workspace groups unless deterministic domain rules AND
  //    strict rule enforcement are explicitly enabled. Existing user/AI groups are
  //    preserved as anchor categories for JEV.
  if (!fullAIMode && domainRulesEnabled && isStrictRulesEnforced() && rules.length > 0) {
    const dissolution = dissolveStaleGroups(workspaceId, rules);
    if (dissolution.dissolved > 0) {
      console.log(`${LOG} dissolved ${dissolution.dissolved} stale group(s), ungrouped ${dissolution.ungrouped} tab(s)`);
    }
  } else {
    console.log(`${LOG} preserving existing workspace tab groups (domainRules=${domainRulesEnabled})`);
  }

  // 4. Enumerate eligible tabs.
  const allTabs = getEligibleTabs().tabs;
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
      const moved = moveTabsToTop(skipped.map((s) => s._tab), workspaceId);
      console.log(`${LOG} skip-domains: parked ${moved} tab(s) at the top of the workspace`);
      const skippedSet = new Set(skipped);
      tabs = allTabs.filter((t) => !skippedSet.has(t));
    }
  }
  if (tabs.length === 0) {
    console.log(`${LOG} no non-skipped eligible tabs in workspace ${workspaceId}`);
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
      const result = applyPass1(sortingPlan.pass1ByGroup, workspaceId, rules);
      console.log(`${LOG} Applied: created ${result.createdGroups} new group(s), moved ${result.movedToNew} tab(s) into new groups, ${result.movedToExisting} tab(s) into existing groups.`);
      if (result.errors.length > 0) {
        console.warn(`${LOG} ${result.errors.length} error(s) during apply:`, result.errors);
      }

      if (domainRulesEnabled && isStrictRulesEnforced()) {
        const candidates = unmatched.filter((t) => t.currentGroup && t._tab?.isConnected);
        if (candidates.length > 0) {
          const ejected = moveTabsToTop(candidates.map((t) => t._tab), workspaceId);
          if (ejected > 0) {
            console.log(`${LOG} Strict: ejected ${ejected} unmatched tab(s) from rule groups`);
            for (const t of candidates) t.currentGroup = null;
          }
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
      setButtonThinking(true);
      try {
        let pass2;
        if (aiEngine === "jev") {
          const t0 = performance.now();
          const liveExistingGroups = isFreshLike ? [] : getWorkspaceExistingGroups(workspaceId);
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
            }
          }

          if (planToApply) {
            const applyOpts = domainRulesEnabled
              ? resolvePass2ApplyOptions(sortMode)
              : { existingBehavior: "transient", newGroupBehavior: "transient", persistRules: false };
            const ai = applyPass2(planToApply, workspaceId, rules, applyOpts);
            recordDebugEvent("APPLY", `Pass 2 applied: ${ai.movedToExisting} tabs moved into existing groups, ${ai.newGroupsCreated} new groups created`);
            console.log(`${LOG} Pass 2 applied: ${ai.movedToExisting} tab(s) → existing groups, ${ai.newGroupsCreated} new group(s), ${ai.rulesGrown} rule(s) grown, ${ai.newRulesCreated} new rule(s)`);
            pass2 = planToApply;

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
          }
        } else if (pass2.skipped.length > 0) {
          console.log(`${LOG} Pass 2: nothing to group (skipped ${pass2.skipped.length} ${inputLabel})`);
          recordDebugEvent("RESULT", `Pass 2: nothing to group (skipped ${pass2.skipped.length} tabs)`);
          if (!pass2.failed) {
            showToast("Keine Tabs zum Gruppieren gefunden oder Konfidenz-Schwelle nicht erreicht.");
          }
        }
      } catch (e) {
        console.error(`${LOG} Pass 2 failed:`, e);
      } finally {
        setButtonThinking(false);
      }
    }

    // 8. Push any remaining ungrouped tabs to the top of the list.
    const movedUp = moveUngroupedToTop(workspaceId);
    if (movedUp > 0) console.log(`${LOG} moved ${movedUp} ungrouped tab(s) to the top of the list`);

    // 9. Sync styling.
    const colored = syncAllGroupColors(workspaceId, rules);
    if (colored > 0) console.log(`${LOG} synced styling on ${colored} group(s) (minimal=${isMinimalStyle()})`);

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
