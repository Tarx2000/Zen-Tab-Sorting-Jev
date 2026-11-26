// Zen Tab Sorting — tidy-button click orchestrator.
// Sequences: consolidate → load rules (optional) → enumerate tabs
//            → JEV Stage 1 (existing workspace groups) + Fallback-LLM Stage 2 (new groups)
//            → apply → ungrouped-to-top → sync colors.

import { CONFIG, LOG, BUILD_VERSION, h } from "./config.mjs";
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
import { abortSortSession, withSortSession } from "./sort-session.mjs";
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
import {
  checkOllamaReady,
  reportOllamaError,
  normalizeOllamaHost,
  runPass2Ollama,
  runPass2OllamaFresh,
  classifyExistingGroupsBatch,
} from "./ollama.mjs";
import {
  runPass2JevHybrid,
  runPass2Remote,
  runPass2RemoteFresh,
  classifyExistingGroupsRemoteBatch,
  resolveEffectiveTimeBudgetMs,
} from "./remote-provider.mjs";
import { getProviderPreset } from "./provider-registry.mjs";
import {
  readFallbackProviderSettings,
  readProviderSettings,
  upsertProviderProfile,
} from "./provider-settings.mjs";
import {
  getFavoriteModels,
  getRecentModels,
  recordRecentModel,
} from "./provider-models.mjs";
import { showToast } from "./ui-toast.mjs";
import { showPreviewModal } from "./preview-modal.mjs";
import { recordDebugEvent, isDebugMode } from "./debug-journal.mjs";
import { getLocale, t } from "./i18n.mjs";
import {
  isFullAIMode,
  resolveEffectiveSortingMode,
  resolvePass2ApplyOptions,
  resolveSortingPlan,
} from "./sorting-mode.mjs";

console.log(`${LOG} click-handler.mjs loaded — v${BUILD_VERSION}`);

const PROGRESS_TOAST_DELAY_MS = 900;

const isGerman = () => getLocale() === "de";
const loc = (de, en) => (isGerman() ? de : en);

const isAbortedOrClosed = (signal) =>
  Boolean(signal?.aborted || (typeof window !== "undefined" && window.closed));

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

const getActiveWorkspaceName = (workspaceId) => {
  try {
    const spaces = window.gZenWorkspaces?.getWorkspaces?.();
    const match = Array.isArray(spaces) ? spaces.find((s) => s?.uuid === workspaceId) : null;
    return String(match?.name || "").trim();
  } catch {
    return "";
  }
};

const resolveActiveModelInfo = (aiEngine) => {
  const prefs = globalThis.Services?.prefs;
  if (aiEngine === "local") {
    return { provider: "local", model: "local-ml", label: loc("Lokale KI", "Local AI") };
  }
  if (aiEngine === "ollama") {
    const model = getOllamaModel();
    return { provider: "ollama", model, label: `Ollama · ${model}` };
  }
  const settings = aiEngine === "jev"
    ? readFallbackProviderSettings(prefs)
    : readProviderSettings(prefs);
  const preset = getProviderPreset(settings?.provider);
  const providerName = preset?.name || settings?.provider || aiEngine;
  const model = String(settings?.model || "").trim();
  return {
    provider: settings?.provider || aiEngine,
    model,
    label: model ? `${providerName} · ${model}` : providerName,
  };
};

const buildPreviewModelOptions = (activeInfo) => {
  const prefs = globalThis.Services?.prefs;
  const seen = new Set();
  const list = [];
  const push = (provider, model, label) => {
    const m = String(model || "").trim();
    if (!m) return;
    const p = String(provider || activeInfo.provider || "").trim().toLowerCase();
    const id = `${p}::${m}`;
    if (seen.has(id)) return;
    seen.add(id);
    const preset = getProviderPreset(p);
    const display = label || `${preset?.name || p} · ${m}`;
    list.push({ id, label: display, provider: p, model: m });
  };

  if (activeInfo.model && activeInfo.provider !== "local") {
    push(activeInfo.provider, activeInfo.model, activeInfo.label);
  }
  for (const fav of getFavoriteModels(prefs)) {
    push(fav.provider || activeInfo.provider, fav.model);
  }
  for (const rec of getRecentModels(prefs)) {
    push(rec.provider || activeInfo.provider, rec.model);
  }
  return list;
};

const applySelectedModelSelection = (selectionId) => {
  const prefs = globalThis.Services?.prefs;
  if (!prefs || !selectionId) return false;
  const sep = String(selectionId).indexOf("::");
  const provider = sep >= 0 ? selectionId.slice(0, sep).trim().toLowerCase() : "";
  const model = sep >= 0 ? selectionId.slice(sep + 2).trim() : String(selectionId).trim();
  if (!model) return false;

  try {
    if (provider && provider !== "local" && provider !== "off") {
      prefs.setStringPref?.(CONFIG.AI_FALLBACK_PROVIDER_PREF, provider);
    }
    const modelPrefByProvider = {
      chatgpt: CONFIG.AI_CHATGPT_MODEL_PREF,
      primalabs: CONFIG.AI_PRIMALABS_MODEL_PREF,
      openai: CONFIG.AI_OPENAI_MODEL_PREF,
      gemini: CONFIG.AI_GEMINI_MODEL_PREF,
      ollama: CONFIG.AI_OLLAMA_MODEL_PREF,
      custom: CONFIG.AI_CUSTOM_MODEL_PREF,
    };
    const targetPref = modelPrefByProvider[provider];
    if (targetPref) {
      prefs.setStringPref?.(targetPref, model);
    }
    if (provider) {
      const current = readFallbackProviderSettings(prefs);
      upsertProviderProfile(prefs, { ...current, id: provider, provider, model });
      recordRecentModel({ provider, model }, prefs);
    }
    return true;
  } catch (e) {
    console.warn(`${LOG} failed to switch model:`, e);
    return false;
  }
};

// Non-blocking <dialog> confirmation wired to AbortSignal (replaces blocking window.confirm).
const confirmLargeLocalSortDialog = (tabCount, isFreshLike, signal) => {
  if (isAbortedOrClosed(signal)) return Promise.resolve(false);
  if (typeof document === "undefined" || !document.documentElement) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const dialog = h("dialog", { class: "zao-preview-dialog zao-confirm-dialog" });
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");

    const title = h("h2", {
      class: "zao-preview-title",
      text: loc("Viele Tabs mit lokaler KI sortieren?", "Sort many tabs with Local AI?"),
    });
    const body = h("p", {
      class: "zao-preview-summary",
      text: loc(
        `Du hast ${tabCount} ${isFreshLike ? "" : "ungruppierte "}Tabs. Die lokale KI kann dafür mehrere Minuten brauchen und den Browser kurz verlangsamen. Fortfahren?`,
        `You have ${tabCount} ${isFreshLike ? "" : "unmatched "}tabs. Running Local AI on this many can take minutes and briefly lag the browser. Continue?`,
      ),
    });
    const actions = h("div", { class: "zao-preview-footer-right" });
    const cancelBtn = h("button", { class: "zao-preview-btn zao-preview-btn-cancel", text: t("toast.cancel") });
    cancelBtn.type = "button";
    const okBtn = h("button", { class: "zao-preview-btn zao-preview-btn-apply", text: loc("Fortfahren", "Continue") });
    okBtn.type = "button";
    actions.append(cancelBtn, okBtn);
    dialog.append(title, body, actions);

    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      try {
        if (dialog.open) dialog.close();
      } catch {}
      try {
        dialog.remove();
      } catch {}
      resolve(accepted);
    };
    const onAbort = () => finish(false);

    cancelBtn.addEventListener("click", () => finish(false));
    okBtn.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    signal?.addEventListener?.("abort", onAbort, { once: true });

    try {
      (document.body || document.documentElement).appendChild(dialog);
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } catch {
      finish(true);
    }
  });
};

const createDelayedProgressToast = (signal) => {
  let timer = null;
  let handle = null;
  let closed = false;

  const start = (message = t("progress.sorting")) => {
    if (closed || isAbortedOrClosed(signal)) return;
    const setTimer = typeof window?.setTimeout === "function" ? window.setTimeout.bind(window) : setTimeout;
    timer = setTimer(() => {
      timer = null;
      if (closed || isAbortedOrClosed(signal)) return;
      handle = showToast(message, {
        type: "info",
        duration: 0,
        action: {
          label: t("toast.cancel"),
          onClick: () => abortSortSession(window),
        },
      });
    }, PROGRESS_TOAST_DELAY_MS);
  };

  const update = (message) => {
    if (closed || !handle) return;
    handle.update(message);
  };

  const dismiss = () => {
    if (closed) return;
    closed = true;
    if (timer !== null) {
      const clearTimer = typeof window?.clearTimeout === "function" ? window.clearTimeout.bind(window) : clearTimeout;
      clearTimer(timer);
      timer = null;
    }
    if (handle) {
      handle.dismiss();
      handle = null;
    }
  };

  return { start, update, dismiss };
};

const organizeCurrentWorkspace = async (signal = null, { onAnimated } = {}) => {
  if (isAbortedOrClosed(signal)) return { aborted: true };
  recordDebugEvent("START", "Zauberstab geklickt — starte Sortierung");

  const workspaceId = window.gZenWorkspaces?.activeWorkspace;
  if (!workspaceId) {
    recordDebugEvent("ERROR", "Kein aktiver Workspace gefunden (window.gZenWorkspaces?.activeWorkspace ist leer)");
    console.warn(`${LOG} no active workspace`);
    showToast(t("toast.noActiveWorkspace"), { type: "warning" });
    return { failed: true };
  }

  console.log(`${LOG} click START — v${BUILD_VERSION}`);
  const aiEngine = getAIEngine();
  const activeSettings = aiEngine === "jev"
    ? readFallbackProviderSettings(globalThis.Services?.prefs)
    : readProviderSettings(globalThis.Services?.prefs);
  const sortStartedAt = Date.now();
  const aiDeadlineAt = sortStartedAt + resolveEffectiveTimeBudgetMs(activeSettings);

  recordDebugEvent("WORKSPACE", `Aktiver Workspace: "${workspaceId}", AI Engine: "${aiEngine}"`);
  const sortMode = resolveEffectiveSortingMode({ aiEngine, preferredMode: getAISortMode() });
  const fullAIMode = isFullAIMode(sortMode);
  const domainRulesEnabled = isDomainRulesEnabled();
  const workspaceName = getActiveWorkspaceName(workspaceId);

  // 1. Merge any duplicate-name groups before lookups assume uniqueness.
  const mutations = [];
  mutations.push(() => consolidateDuplicateGroups(workspaceId));

  // 2. Load optional domain rules (empty by default when domain rules are disabled).
  const rules = await loadRules();
  if (isAbortedOrClosed(signal)) return { aborted: true };

  // 3. Never dissolve existing workspace groups unless deterministic domain rules AND
  //    strict rule enforcement are explicitly enabled.
  if (!fullAIMode && domainRulesEnabled && isStrictRulesEnforced() && rules.length > 0) {
    mutations.push(() => dissolveStaleGroups(workspaceId, rules));
  } else {
    console.log(`${LOG} preserving existing workspace tab groups (domainRules=${domainRulesEnabled})`);
  }

  // 4. Enumerate eligible tabs.
  const allTabs = getEligibleTabs().tabs;
  const originalTabs = allTabs.map((info) => ({ node: info._tab, parent: info._tab?.parentElement, url: info.url }));
  if (!fullAIMode && domainRulesEnabled && isStrictRulesEnforced() && rules.length > 0) {
    const names = new Set(rules.map((rule) => rule.name));
    for (const info of allTabs) if (info.currentGroup && !names.has(info.currentGroup)) info.currentGroup = null;
  }
  if (allTabs.length === 0) {
    recordDebugEvent("TABS", `Keine sortierbaren Tabs im Workspace "${workspaceId}" gefunden.`);
    console.log(`${LOG} no eligible tabs in workspace ${workspaceId}`);
    showToast(t("toast.noEligibleTabs"));
    return { noop: true };
  }
  recordDebugEvent("TABS", `${allTabs.length} sortierbare Tabs gefunden`, {
    tabs: allTabs.map((tab) => ({ title: tab.title, hostname: tab.hostname, group: tab.currentGroup })),
  });

  // 4b. Handle skip-domains (mutable list so stale tabs can be filtered out later).
  const skipPatterns = readSkipDomainsPref();
  let tabs = allTabs;
  let skipDomainTabs = [];
  if (skipPatterns.length > 0) {
    skipDomainTabs = allTabs.filter((tab) =>
      skipPatterns.some((p) => matchesDomain(tab.hostname, p)),
    );
    if (skipDomainTabs.length > 0) {
      mutations.push(() => {
        const liveNodes = skipDomainTabs.map((s) => s._tab).filter((node) => node?.isConnected);
        if (liveNodes.length > 0) moveTabsToTop(liveNodes, workspaceId);
      });
      const skippedSet = new Set(skipDomainTabs);
      tabs = allTabs.filter((tab) => !skippedSet.has(tab));
    }
  }
  if (tabs.length === 0) {
    console.log(`${LOG} no non-skipped eligible tabs in workspace ${workspaceId}`);
    if (!isAbortedOrClosed(signal) && window.gZenWorkspaces?.activeWorkspace === workspaceId) {
      await animateSidebarChanges(window, () => {
        for (const mutate of mutations) {
          try { mutate(); } catch (err) { console.error(`${LOG} mutation failed:`, err); }
        }
      });
      onAnimated?.();
    }
    return { ok: true };
  }

  // 5. Pass 1 matching (only moves tabs if optional domain rules exist).
  const { assignments, byGroup, unmatched, alreadyCorrect } = runPass1(tabs, rules);

  const newGroupBehavior = aiEngine !== "off" ? getAINewGroupBehavior() : "";
  const isFreshMode = fullAIMode || newGroupBehavior === "fresh-categories";
  const isIdentifyOnly = newGroupBehavior === "identify-only";
  const isFreshLike = isFreshMode || isIdentifyOnly;
  const debugEnabled = isDebugMode();

  const progressToast = createDelayedProgressToast(signal);

  console.groupCollapsed(
    `${LOG} Pass 1 — ${tabs.length} tabs · ${alreadyCorrect.length} already correct · ${byGroup.size} group(s) to update · ${unmatched.length} unmatched`,
  );
  try {
    if (debugEnabled) {
      console.log("Per-tab assignments:");
      console.table(
        assignments.map(({ id, hostname, title, currentGroup, group }) => ({
          id,
          hostname,
          from: currentGroup || "—",
          to: group || "—",
          action: actionFor(currentGroup, group),
          title,
        })),
      );

      if (byGroup.size > 0) {
        console.log("Pending moves by group:");
        console.table(
          Array.from(byGroup.entries()).map(([name, items]) => ({
            target: name,
            count: items.length,
            from: items.map((tab) => tab.currentGroup || "—").join(", "),
            hosts: items.map((tab) => tab.hostname).join(", "),
          })),
        );
      }
    }

    // 6. Apply Pass 1 moves (if any optional domain rules matched).
    const sortingPlan = resolveSortingPlan({ mode: sortMode, tabs, pass1: { byGroup, unmatched } });
    let strictEjectCandidates = [];
    if (sortingPlan.shouldApplyPass1 && sortingPlan.pass1ByGroup.size > 0) {
      mutations.push(() => applyPass1(sortingPlan.pass1ByGroup, workspaceId, rules));

      if (domainRulesEnabled && isStrictRulesEnforced()) {
        strictEjectCandidates = unmatched.filter((tab) => tab.currentGroup && tab._tab?.isConnected);
        if (strictEjectCandidates.length > 0) {
          mutations.push(() => {
            const liveNodes = strictEjectCandidates.map((tab) => tab._tab).filter((n) => n?.isConnected);
            if (liveNodes.length > 0) moveTabsToTop(liveNodes, workspaceId);
          });
          for (const tab of strictEjectCandidates) tab.currentGroup = null;
        }
      }
    }

    // 7. Pass 2 (AI).
    const rawPass2Candidates = isFreshLike ? tabs : sortingPlan.tabsForAI;
    const pass2Input = isFreshLike
      ? tabs
      : rawPass2Candidates.filter((tab) => !tab.currentGroup);

    const shouldRunPass2 = aiEngine !== "off" && pass2Input.length > 0;
    const isRemoteEngine = ["jev", "chatgpt", "primalabs", "openai", "gemini", "custom"].includes(aiEngine);
    const pass1HasMoves = sortingPlan.shouldApplyPass1 && sortingPlan.pass1ByGroup.size > 0;

    // Only notify "no ungrouped tabs" when Pass 1 & skip-domains did not produce moves either.
    if (!shouldRunPass2 && pass2Input.length === 0 && isRemoteEngine && !pass1HasMoves && skipDomainTabs.length === 0) {
      showToast(t("toast.noUngroupedTabs"));
    }

    let activePass2Plan = null;
    let pass2Failed = false;

    const executePass2 = async ({ deadlineAt = aiDeadlineAt } = {}) => {
      if (aiEngine === "jev") {
        const t0 = performance.now();
        // Full-AI / fresh mode passes existingGroups = [] for true fresh re-clustering!
        let liveExistingGroups = [];
        if (!isFreshLike) {
          liveExistingGroups = getWorkspaceExistingGroups(workspaceId);
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
          for (const [name, items] of sortingPlan.pass1ByGroup) {
            if (!liveExistingGroups.some((group) => group.name === name)) {
              liveExistingGroups.push({ name, domains: [...new Set(items.map((tab) => tab.hostname))], tabs: items });
            }
          }
        }
        const res = await runPass2JevHybrid(pass2Input, liveExistingGroups, {
          deadlineAt,
          signal,
          isFreshMode: isFreshLike,
          workspaceName,
        });
        console.log(`${LOG} JEV + Fallback-LLM Pass 2 took ${Math.round(performance.now() - t0)}ms`);
        return res;
      }

      if (aiEngine === "ollama") {
        const host = getOllamaHost();
        const model = getOllamaModel();
        const status = await checkOllamaReady(host, model, { signal });
        if (isAbortedOrClosed(signal)) return { assignedToExisting: [], newGroups: [], skipped: pass2Input, failed: "aborted" };
        if (!status.reachable || !status.modelAvailable) {
          reportOllamaError(host, model, status);
          return { assignedToExisting: [], newGroups: [], skipped: isFreshMode ? tabs : pass2Input, failed: status.error || "ollama_unavailable" };
        }
        console.debug(`${LOG} Ollama ready at ${normalizeOllamaHost(host)} (model: ${model})`);
        const t0 = performance.now();
        const effectiveRules = rules.length > 0 ? rules : getWorkspaceExistingGroups(workspaceId);
        const res = isFreshLike
          ? await runPass2OllamaFresh(tabs, { signal })
          : await runPass2Ollama(pass2Input, effectiveRules, { signal });
        console.log(`${LOG} Ollama Pass 2 took ${Math.round(performance.now() - t0)}ms`);
        return res;
      }

      if (["chatgpt", "primalabs", "openai", "gemini", "custom"].includes(aiEngine)) {
        const t0 = performance.now();
        const effectiveRules = rules.length > 0 ? rules : getWorkspaceExistingGroups(workspaceId);
        const res = isFreshLike
          ? await runPass2RemoteFresh(tabs, undefined, { signal, deadlineAt })
          : await runPass2Remote(pass2Input, effectiveRules, undefined, { signal, deadlineAt });
        console.log(`${LOG} ${aiEngine} Pass 2 took ${Math.round(performance.now() - t0)}ms`);
        return res;
      }

      // Local Firefox ML engine
      const localInput = pass2Input;
      if (localInput.length > CONFIG.AI_LOCAL_CONFIRM_THRESHOLD) {
        progressToast.dismiss();
        const proceed = await confirmLargeLocalSortDialog(localInput.length, isFreshLike, signal);
        if (!proceed) {
          console.log(`${LOG} Pass 2 cancelled by user (soft cap at ${CONFIG.AI_LOCAL_CONFIRM_THRESHOLD})`);
          return { assignedToExisting: [], newGroups: [], skipped: localInput, aborted: true };
        }
      }
      const effectiveRules = rules.length > 0 ? rules : getWorkspaceExistingGroups(workspaceId);
      return isFreshLike
        ? await runPass2Fresh(tabs)
        : await runPass2(pass2Input, effectiveRules, workspaceId);
    };

    if (shouldRunPass2) {
      const inputCount = pass2Input.length;
      const inputLabel = isFreshLike ? "ALL eligible tab(s)" : "ungrouped tab(s)";
      const modeSuffix = isIdentifyOnly ? " (identify-only)" : isFreshMode ? ` (${sortMode === "full-ai" ? "full-ai" : "fresh-categories"})` : "";
      console.log(`${LOG} Pass 2 — running ${aiEngine}${modeSuffix} AI over ${inputCount} ${inputLabel}...`);

      progressToast.start(t("progress.classifying"));
      try {
        let pass2 = await executePass2();
        progressToast.dismiss();

        if (isAbortedOrClosed(signal) || pass2?.failed === "aborted" || pass2?.aborted) {
          showToast(t("toast.sortAborted"), { type: "info" });
          return { aborted: true };
        }

        if (pass2.assignedToExisting.length > 0 || pass2.newGroups.length > 0) {
          console.log(`${LOG} Pass 2 plan: ${pass2.assignedToExisting.length} to existing group(s), ${pass2.newGroups.length} new group(s), ${pass2.skipped.length} skipped`);
          if (debugEnabled) {
            if (pass2.assignedToExisting.length > 0) {
              console.table(pass2.assignedToExisting.map((a) => ({
                hostname: a.tabInfo.hostname,
                "→ existing group": a.groupName,
                similarity: Number(a.similarity || 0).toFixed(3),
              })));
            }
            if (pass2.newGroups.length > 0) {
              console.table(pass2.newGroups.map((g) => ({
                "new group": g.name,
                tabs: g.tabs.map((tab) => tab.hostname).join(", "),
              })));
            }
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
            const activeModelInfo = resolveActiveModelInfo(aiEngine);
            const previewModels = buildPreviewModelOptions(activeModelInfo);
            console.debug(`${LOG} Plan Mode modal opening (${modalReason})`);

            planToApply = await showPreviewModal({
              plan: pass2,
              signal,
              activeModelLabel: activeModelInfo.label,
              models: previewModels,
              onModelChangeAndRerun: async (selectedId) => {
                if (isAbortedOrClosed(signal)) return null;
                if (selectedId) applySelectedModelSelection(selectedId);
                const freshSettings = aiEngine === "jev"
                  ? readFallbackProviderSettings(globalThis.Services?.prefs)
                  : readProviderSettings(globalThis.Services?.prefs);
                const rerunDeadline = Date.now() + resolveEffectiveTimeBudgetMs(freshSettings);
                const nextPlan = await executePass2({ deadlineAt: rerunDeadline });
                if (isAbortedOrClosed(signal) || nextPlan?.failed === "aborted") return null;
                return nextPlan;
              },
              onReassignToNew: async (pendingTabs) => {
                if (isAbortedOrClosed(signal)) return { newGroups: [], skipped: pendingTabs };
                const r = aiEngine === "local"
                  ? await runPass2Fresh(pendingTabs)
                  : aiEngine === "ollama"
                    ? await runPass2OllamaFresh(pendingTabs, { signal })
                    : await runPass2RemoteFresh(pendingTabs, undefined, { signal, silent: true });
                return { newGroups: r.newGroups, skipped: r.skipped };
              },
              onAssignToPlanned: async (pendingTabs, keptBuckets) => {
                if (isAbortedOrClosed(signal)) return { assignments: [], skipped: pendingTabs };
                const fakeRules = keptBuckets.map((g) => ({
                  name: g.name,
                  domains: [...new Set(g.tabs.map((tab) => tab.hostname).filter((host) => host))],
                  tabs: g.tabs,
                }));
                if (aiEngine === "jev") {
                  const res = await runPass2JevHybrid(pendingTabs, fakeRules, {
                    stage1Only: true,
                    silent: true,
                    signal,
                  });
                  return { assignments: res.assignedToExisting, skipped: res.skipped };
                }
                if (aiEngine === "local") {
                  const local = await runPass2(pendingTabs, fakeRules, workspaceId);
                  return { assignments: local.assignedToExisting, skipped: local.skipped };
                }
                const assignmentMap = aiEngine === "ollama"
                  ? await classifyExistingGroupsBatch(pendingTabs, fakeRules, getOllamaHost(), getOllamaModel(), { signal })
                  : await classifyExistingGroupsRemoteBatch(pendingTabs, fakeRules, undefined, { signal, silent: true });
                return assignmentMapToPlan(pendingTabs, assignmentMap);
              },
              onAssignToExisting: existingTargets.length > 0 ? async (pendingTabs) => {
                if (isAbortedOrClosed(signal)) return { assignments: [], skipped: pendingTabs };
                if (aiEngine === "jev") {
                  const res = await runPass2JevHybrid(pendingTabs, existingTargets, {
                    stage1Only: true,
                    silent: true,
                    signal,
                  });
                  return { assignments: res.assignedToExisting, skipped: res.skipped };
                }
                if (aiEngine === "local") {
                  const local = await runPass2(pendingTabs, existingTargets, workspaceId);
                  return { assignments: local.assignedToExisting, skipped: local.skipped };
                }
                const assignmentMap = aiEngine === "ollama"
                  ? await classifyExistingGroupsBatch(pendingTabs, existingTargets, getOllamaHost(), getOllamaModel(), { signal })
                  : await classifyExistingGroupsRemoteBatch(pendingTabs, existingTargets, undefined, { signal, silent: true });
                return assignmentMapToPlan(pendingTabs, assignmentMap);
              } : undefined,
            });
            if (isAbortedOrClosed(signal)) {
              showToast(t("toast.sortAborted"), { type: "info" });
              return { aborted: true };
            }
            if (planToApply === null) {
              console.log(`${LOG} ${modalReason}: user cancelled — no changes applied`);
              return { aborted: true };
            }
          }

          if (planToApply) {
            activePass2Plan = planToApply;
            mutations.push(() => {
              const applyOpts = domainRulesEnabled
                ? resolvePass2ApplyOptions(sortMode)
                : { existingBehavior: "transient", newGroupBehavior: "transient", persistRules: false };
              const ai = applyPass2(activePass2Plan, workspaceId, rules, applyOpts);
              recordDebugEvent("APPLY", `Pass 2 applied: ${ai.movedToExisting} tabs moved into existing groups, ${ai.newGroupsCreated} new groups created`);
              console.log(`${LOG} Pass 2 applied: ${ai.movedToExisting} tab(s) → existing groups, ${ai.newGroupsCreated} new group(s), ${ai.rulesGrown} rule(s) grown, ${ai.newRulesCreated} new rule(s)`);
              pass2 = activePass2Plan;

              if (isFreshLike) {
                const skippedGroupedNodes = (pass2.skipped || [])
                  .map((tabInfo) => tabInfo?._tab)
                  .filter((tab) => tab?.isConnected && tab.closest?.("tab-group"));
                if (skippedGroupedNodes.length > 0) {
                  moveTabsToTop(skippedGroupedNodes, workspaceId);
                  console.log(`${LOG} ${newGroupBehavior} mode: ungrouped ${skippedGroupedNodes.length} AI-skipped tab(s) from their previous groups`);
                }
                const dropped = dissolveEmptyGroups(workspaceId);
                if (dropped > 0) console.log(`${LOG} dissolved ${dropped} empty group(s) after re-tidy`);
              }
            });
          }
        } else if (pass2.skipped.length > 0) {
          console.log(`${LOG} Pass 2: nothing to group (skipped ${pass2.skipped.length} ${inputLabel})`);
          recordDebugEvent("RESULT", `Pass 2: nothing to group (skipped ${pass2.skipped.length} tabs)`);
          if (pass2.failed) {
            pass2Failed = true;
          } else {
            showToast(loc(
              "Keine Tabs zum Gruppieren gefunden oder Konfidenz-Schwelle nicht erreicht.",
              "No tabs matched any group or confidence threshold was not met.",
            ));
          }
        } else if (pass2.failed) {
          pass2Failed = true;
        }
      } catch (e) {
        progressToast.dismiss();
        if (isAbortedOrClosed(signal) || e?.name === "AbortError" || e?.category === "abort") {
          showToast(t("toast.sortAborted"), { type: "info" });
          return { aborted: true };
        }
        pass2Failed = true;
        console.error(`${LOG} Pass 2 failed:`, e);
        showToast(`${t("toast.sortFailed")} ${e?.message || e}`, { type: "error" });
      } finally {
        progressToast.dismiss();
      }
    }

    if (isAbortedOrClosed(signal)) {
      showToast(t("toast.sortAborted"), { type: "info" });
      return { aborted: true };
    }

    // 8. Push any remaining ungrouped tabs to the top of the list.
    mutations.push(() => moveUngroupedToTop(workspaceId));

    // 9. Sync styling.
    mutations.push(() => syncAllGroupColors(workspaceId, rules));

    if (window.gZenWorkspaces?.activeWorkspace !== workspaceId) {
      showToast(loc(
        "Workspace wurde während der Berechnung gewechselt. Bitte die Sortierung erneut starten.",
        "Workspace changed during sorting. Please run sort again.",
      ), { type: "warning" });
      return { failed: true };
    }

    const staleTabNodes = new Set();
    for (const { node, parent, url } of originalTabs) {
      if (
        !node?.isConnected ||
        node.parentElement !== parent ||
        node.getAttribute("zen-workspace-id") !== workspaceId ||
        getTabUrl(node) !== url
      ) {
        staleTabNodes.add(node);
      }
    }

    const countPlannedMoves = () => {
      let total = 0;
      for (const items of sortingPlan.pass1ByGroup.values()) total += items.length;
      if (activePass2Plan) {
        total += activePass2Plan.assignedToExisting.length;
        for (const grp of activePass2Plan.newGroups) total += grp.tabs.length;
      }
      return total;
    };
    const initialPlannedMoves = countPlannedMoves();

    if (staleTabNodes.size > 0) {
      if (skipDomainTabs.length > 0) {
        skipDomainTabs = skipDomainTabs.filter((item) => !staleTabNodes.has(item._tab));
      }
      for (const [groupName, items] of sortingPlan.pass1ByGroup) {
        const fresh = items.filter((item) => !staleTabNodes.has(item._tab));
        if (fresh.length === 0) sortingPlan.pass1ByGroup.delete(groupName);
        else sortingPlan.pass1ByGroup.set(groupName, fresh);
      }
      if (strictEjectCandidates.length > 0) {
        for (let i = strictEjectCandidates.length - 1; i >= 0; i--) {
          if (staleTabNodes.has(strictEjectCandidates[i]._tab)) strictEjectCandidates.splice(i, 1);
        }
      }
      if (activePass2Plan) {
        activePass2Plan.assignedToExisting = activePass2Plan.assignedToExisting.filter(
          (a) => !staleTabNodes.has(a.tabInfo?._tab),
        );
        const keptNewGroups = [];
        const demotedTabs = [];
        for (const g of activePass2Plan.newGroups) {
          const freshTabs = g.tabs.filter((tab) => !staleTabNodes.has(tab._tab));
          if (freshTabs.length >= 2) {
            keptNewGroups.push({ ...g, tabs: freshTabs });
          } else if (freshTabs.length > 0) {
            demotedTabs.push(...freshTabs);
          }
        }
        activePass2Plan.newGroups = keptNewGroups;
        activePass2Plan.skipped = [
          ...activePass2Plan.skipped.filter((tab) => !staleTabNodes.has(tab._tab)),
          ...demotedTabs,
        ];
      }
      console.log(`${LOG} skipped ${staleTabNodes.size} tab(s) that changed while sorting was running`);
      if (initialPlannedMoves > 0 && countPlannedMoves() === 0) {
        showToast(loc(
          "Tabs wurden während der Berechnung verändert. Bitte die Sortierung erneut starten.",
          "Tabs changed during sorting. Please run sort again.",
        ), { type: "warning" });
        return { failed: true };
      }
    }

    const activeWorkspaceEl = window.gZenWorkspaces?.activeWorkspaceElement;
    const collapsed = activeWorkspaceEl
      ? [...activeWorkspaceEl.querySelectorAll("tab-group[collapsed]")]
      : [];

    if (!isAbortedOrClosed(signal)) {
      await animateSidebarChanges(window, () => {
        try {
          for (const mutate of mutations) {
            try {
              mutate();
            } catch (err) {
              console.error(`${LOG} sidebar mutation failed:`, err);
            }
          }
        } finally {
          for (const group of collapsed) {
            try {
              if (group?.isConnected) collapseGroup(group);
            } catch {}
          }
          try {
            window.gBrowser?.tabContainer?._invalidateCachedTabs?.();
          } catch {}
          try {
            window.gZenWorkspaces?.updateTabsContainers?.();
          } catch {}
          try {
            void window.gBrowser?.tabs?.length;
          } catch {}
          try {
            saveGroupState(window);
          } catch {}
        }
      });
      onAnimated?.();
    }

    if (debugEnabled) {
      try {
        const allGroups = document.querySelectorAll("tab-group").length;
        const nestedGroups = document.querySelectorAll("tab-group tab-group").length;
        if (nestedGroups > 0) {
          console.warn(`${LOG} ⚠ NESTED TAB-GROUPS DETECTED: ${nestedGroups} group(s) inside other groups (total ${allGroups}).`);
        }
      } catch (e) {
        console.error(`${LOG} nesting diagnostic failed:`, e);
      }
    }

    if (pass2Failed && countPlannedMoves() === 0) {
      return { failed: true };
    }
    return { ok: true };
  } finally {
    progressToast.dismiss();
    console.groupEnd();
  }
};

export const handleOrganizeClick = ({ workspaceId, fromLibrary = false } = {}) => withSortSession("tabs", async (signal) => {
  const manager = window.gZenWorkspaces;
  if (!fromLibrary) return organizeCurrentWorkspace(signal);
  if (!workspaceId || !manager?.getWorkspaces?.().some((space) => space.uuid === workspaceId)) {
    showToast(loc("Dieser Space ist nicht mehr verfügbar.", "This Space is no longer available."), { type: "warning" });
    return { failed: true };
  }
  const originalSpace = manager.activeWorkspace;
  const originalTab = window.gBrowser?.selectedTab;
  let animated = false;
  let restoredSpace = false;
  try {
    if (isAbortedOrClosed(signal)) return { aborted: true };
    // Existing grouping APIs operate on the active native strip, never on the
    // Library's copies. Activate the requested card inside the shared sort lock.
    if (originalSpace !== workspaceId) await manager.changeWorkspaceWithID(workspaceId);
    if (isAbortedOrClosed(signal)) return { aborted: true };
    return await organizeCurrentWorkspace(signal, { onAnimated: () => { animated = true; } });
  } finally {
    if (!window.closed) {
      try {
        // Restore original Space & tab unless the user navigated to a different Space.
        if (
          originalSpace &&
          originalSpace !== manager?.activeWorkspace &&
          manager?.activeWorkspace === workspaceId &&
          manager?.getWorkspaces?.().some((space) => space.uuid === originalSpace)
        ) {
          await manager.changeWorkspaceWithID(originalSpace);
          restoredSpace = true;
          if (!window.closed && originalTab?.isConnected && !originalTab.closing && window.gBrowser) {
            window.gBrowser.selectedTab = originalTab;
          }
        }
      } catch (e) {
        console.warn(`${LOG} failed to restore original workspace after Library sort:`, e);
      }
      // Reconcile Library strips after restoring the original Space (or when no animation ran)
      // so space-card copies and copyForTab() mappings stay in sync with live tab groups.
      if (!window.closed && (restoredSpace || !animated)) {
        try {
          window.document?.querySelector?.("zen-library-spaces-section")?.refreshStripsNow?.();
        } catch {}
      }
    }
  }
}, window, { workspaceId });
