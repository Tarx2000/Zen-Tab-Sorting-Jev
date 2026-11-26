// Zen Tab Sorting — Plan Mode preview modal.
//
// Interactive modal that lets the user review the AI's proposed groupings
// before they're applied. Supports:
//   - In-place keep/skip toggles (preserving keyboard focus & scroll position)
//   - Inline group rename (double-click or edit button)
//   - Per-tab exclude (×) back to Skipped
//   - Compact segmented Re-assign bar (Planned / Existing / New) with per-button spinner
//   - Optional header model badge, quick model switcher, and Re-run action
//   - Dynamic Apply (N groups · M tabs) label and AbortSignal auto-close

import { LOG, h } from "./config.mjs";

const newKey = (name) => `new:${name.toLowerCase()}`;
const existingKey = (name) => `existing:${name.toLowerCase()}`;

const clonePlan = (p) => ({
  assignedToExisting: (p?.assignedToExisting || []).map((a) => ({ ...a })),
  newGroups: (p?.newGroups || []).map((g) => ({ name: g.name, tabs: [...(g.tabs || [])] })),
  skipped: [...(p?.skipped || [])],
});

const groupExistingByTarget = (assignedToExisting) => {
  const byName = new Map();
  for (const a of assignedToExisting) {
    const k = a.groupName.toLowerCase();
    if (!byName.has(k)) byName.set(k, { name: a.groupName, tabs: [] });
    byName.get(k).tabs.push(a.tabInfo);
  }
  return [...byName.values()];
};

const normalizeModelOption = (entry) => {
  if (typeof entry === "string") return { id: entry, label: entry };
  if (entry && typeof entry === "object") {
    const id = String(entry.id ?? entry.value ?? entry.label ?? "");
    const label = String(entry.label ?? entry.name ?? id);
    return { id, label };
  }
  return null;
};

let modalSeq = 0;

/**
 * Show the AI plan as an interactive modal.
 *
 * @param {object} args
 * @param {Plan} args.plan
 * @param {(pending) => Promise<{newGroups,skipped}>} [args.onReassignToNew]
 * @param {(pending,buckets) => Promise<{assignments,skipped}>} [args.onAssignToPlanned]
 * @param {(pending) => Promise<{assignments,skipped}>} [args.onAssignToExisting]
 * @param {string} [args.activeModelLabel]
 * @param {Array<string|{id:string,label?:string}>} [args.models]
 * @param {(modelId:string) => Promise<Plan|null>} [args.onModelChangeAndRerun]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<Plan | null>}
 */
export const showPreviewModal = ({
  plan,
  onReassignToNew,
  onAssignToPlanned,
  onAssignToExisting,
  activeModelLabel = "",
  models = null,
  onModelChangeAndRerun = null,
  signal = null,
}) => {
  if (signal?.aborted) return Promise.resolve(null);

  return new Promise((resolve) => {
    let currentPlan = clonePlan(plan);
    const kept = new Set();

    const seedKeptFromPlan = (nextPlan) => {
      kept.clear();
      for (const g of nextPlan.newGroups) kept.add(newKey(g.name));
      for (const a of nextPlan.assignedToExisting) kept.add(existingKey(a.groupName));
    };
    seedKeptFromPlan(currentPlan);

    const titleId = `zao-preview-title-${++modalSeq}`;
    const dialog = h("dialog", { class: "zao-preview-dialog" });
    dialog.setAttribute("aria-labelledby", titleId);

    // ─── Header ────────────────────────────────────────────────────────────
    const header = h("div", { class: "zao-preview-header" });
    const titleEl = h("h2", { class: "zao-preview-title", text: "AI grouping preview" });
    titleEl.id = titleId;
    header.appendChild(titleEl);

    const headerControls = h("div", { class: "zao-preview-header-controls" });
    const normalizedModels = Array.isArray(models)
      ? models.map(normalizeModelOption).filter((m) => m && m.id)
      : [];
    let modelSelect = null;
    let rerunBtn = null;
    let modelBadge = null;

    if (normalizedModels.length > 0 && typeof onModelChangeAndRerun === "function") {
      const modelBar = h("div", { class: "zao-preview-model-bar" });
      modelSelect = h("select", { class: "zao-preview-model-select" });
      modelSelect.setAttribute("aria-label", "AI model");
      for (const m of normalizedModels) {
        const opt = h("option", { text: m.label });
        opt.value = m.id;
        if (activeModelLabel && (m.id === activeModelLabel || m.label === activeModelLabel)) {
          opt.selected = true;
        }
        modelSelect.appendChild(opt);
      }
      rerunBtn = h("button", { class: "zao-preview-btn zao-preview-btn-rerun", text: "Re-run" });
      rerunBtn.type = "button";
      rerunBtn.title = "Re-run grouping with the selected model";
      rerunBtn.addEventListener("click", onRerunClick);
      modelBar.append(modelSelect, rerunBtn);
      headerControls.appendChild(modelBar);
    } else if (activeModelLabel || typeof onModelChangeAndRerun === "function") {
      const modelBar = h("div", { class: "zao-preview-model-bar" });
      if (activeModelLabel) {
        modelBadge = h("span", { class: "zao-preview-model-badge", text: activeModelLabel });
        modelBadge.title = `Active AI model: ${activeModelLabel}`;
        modelBar.appendChild(modelBadge);
      }
      if (typeof onModelChangeAndRerun === "function") {
        rerunBtn = h("button", { class: "zao-preview-btn zao-preview-btn-rerun", text: "Re-run" });
        rerunBtn.type = "button";
        rerunBtn.title = "Re-run grouping";
        rerunBtn.addEventListener("click", onRerunClick);
        modelBar.appendChild(rerunBtn);
      }
      headerControls.appendChild(modelBar);
    }

    const closeBtn = h("button", { class: "zao-preview-close" });
    closeBtn.setAttribute("type", "button");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => cleanup(null));
    headerControls.appendChild(closeBtn);
    header.appendChild(headerControls);
    dialog.appendChild(header);

    const body = h("div", { class: "zao-preview-body" });
    dialog.appendChild(body);

    // ─── Footer ────────────────────────────────────────────────────────────
    const footer = h("div", { class: "zao-preview-footer" });
    const footerLeft = h("div", { class: "zao-preview-footer-left" });
    const footerRight = h("div", { class: "zao-preview-footer-right" });

    const reassignBar = h("div", { class: "zao-preview-reassign-group" });
    reassignBar.setAttribute("role", "group");
    reassignBar.setAttribute("aria-label", "Re-assign unkept tabs");
    reassignBar.appendChild(h("span", { class: "zao-preview-reassign-label", text: "Re-assign:" }));

    const reassignToPlannedBtn = h("button", { class: "zao-preview-btn zao-preview-btn-reassign", text: "Planned" });
    reassignToPlannedBtn.setAttribute("type", "button");
    reassignToPlannedBtn.setAttribute("aria-label", "Re-assign to planned");
    reassignToPlannedBtn.addEventListener("click", onReassignToPlannedClick);
    reassignBar.appendChild(reassignToPlannedBtn);

    const reassignToExistingBtn = h("button", { class: "zao-preview-btn zao-preview-btn-reassign", text: "Existing" });
    reassignToExistingBtn.setAttribute("type", "button");
    reassignToExistingBtn.setAttribute("aria-label", "Re-assign to existing");
    reassignToExistingBtn.addEventListener("click", onReassignToExistingClick);
    reassignBar.appendChild(reassignToExistingBtn);

    const reassignToNewBtn = h("button", { class: "zao-preview-btn zao-preview-btn-reassign", text: "New" });
    reassignToNewBtn.setAttribute("type", "button");
    reassignToNewBtn.setAttribute("aria-label", "Re-assign to new");
    reassignToNewBtn.addEventListener("click", onReassignToNewClick);
    reassignBar.appendChild(reassignToNewBtn);

    footerLeft.appendChild(reassignBar);

    const cancelBtn = h("button", { class: "zao-preview-btn zao-preview-btn-cancel", text: "Cancel" });
    cancelBtn.setAttribute("type", "button");
    cancelBtn.addEventListener("click", () => cleanup(null));
    footerRight.appendChild(cancelBtn);

    const applyBtn = h("button", { class: "zao-preview-btn zao-preview-btn-apply", text: "Apply" });
    applyBtn.setAttribute("type", "button");
    applyBtn.addEventListener("click", onApplyClick);
    footerRight.appendChild(applyBtn);

    footer.appendChild(footerLeft);
    footer.appendChild(footerRight);
    dialog.appendChild(footer);

    let summaryEl = null;
    let busy = false;

    // ─── Summary & Footer sync (in-place, zero DOM rebuild) ────────────────
    function updateSummaryAndFooter() {
      const existingTargets = groupExistingByTarget(currentPlan.assignedToExisting);
      const keptCounts = countKeptStats(existingTargets);
      const totalGroups = currentPlan.newGroups.length + existingTargets.length;
      const skippedCount = currentPlan.skipped.length;
      const pendingForReassign = pendingTabs(existingTargets).length;

      const summaryText =
        totalGroups === 0 && skippedCount === 0
          ? "The AI found nothing to group."
          : `${keptCounts.groups}/${totalGroups} group(s) kept · ${keptCounts.tabs} tab(s) moving · ${skippedCount} ungrouped`;
      if (summaryEl) summaryEl.textContent = summaryText;

      applyBtn.textContent = keptCounts.groups > 0
        ? `Apply (${keptCounts.groups} ${keptCounts.groups === 1 ? "group" : "groups"} · ${keptCounts.tabs} ${keptCounts.tabs === 1 ? "tab" : "tabs"})`
        : "Apply (0 groups)";

      if (busy) return;

      reassignToPlannedBtn.disabled =
        pendingForReassign === 0 || keptCounts.groups === 0 || typeof onAssignToPlanned !== "function";
      reassignToPlannedBtn.title =
        pendingForReassign === 0 ? "Nothing to re-assign — every tab is in a kept group"
        : keptCounts.groups === 0 ? "No kept groups to assign into — keep at least one first"
        : `Try fitting ${pendingForReassign} unkept tab(s) into your ${keptCounts.groups} kept group(s)`;

      reassignToExistingBtn.disabled =
        pendingForReassign === 0 || typeof onAssignToExisting !== "function";
      reassignToExistingBtn.title =
        pendingForReassign === 0 ? "Nothing to re-assign — every tab is in a kept group"
        : typeof onAssignToExisting !== "function" ? "No existing rule groups to assign into"
        : `Try fitting ${pendingForReassign} unkept tab(s) into one of your existing rule groups`;

      reassignToNewBtn.disabled =
        pendingForReassign === 0 || typeof onReassignToNew !== "function";
      reassignToNewBtn.title = pendingForReassign === 0
        ? "Nothing to re-assign — every tab is in a kept group"
        : `Cluster ${pendingForReassign} unkept tab(s) into fresh new categories`;
    }

    // ─── Full Rendering (preserves scrollTop) ──────────────────────────────
    function render() {
      const prevScrollTop = body.scrollTop;
      while (body.firstChild) body.firstChild.remove();

      const existingTargets = groupExistingByTarget(currentPlan.assignedToExisting);
      const skippedCount = currentPlan.skipped.length;

      summaryEl = h("p", { class: "zao-preview-summary" });
      body.appendChild(summaryEl);

      if (currentPlan.newGroups.length > 0) {
        const sec = h("section", { class: "zao-preview-section" });
        sec.appendChild(h("h3", { class: "zao-preview-section-title", text: "Proposed new groups — click to keep / skip" }));
        for (const g of currentPlan.newGroups) {
          sec.appendChild(renderGroupBlock(g, "new"));
        }
        body.appendChild(sec);
      }

      if (existingTargets.length > 0) {
        const sec = h("section", { class: "zao-preview-section" });
        sec.appendChild(h("h3", {
          class: "zao-preview-section-title",
          text: "Into existing groups — click to keep / skip",
        }));
        for (const t of existingTargets) {
          sec.appendChild(renderGroupBlock(t, "existing"));
        }
        body.appendChild(sec);
      }

      if (skippedCount > 0) {
        const sec = h("section", { class: "zao-preview-section zao-preview-skipped" });
        sec.appendChild(h("h3", {
          class: "zao-preview-section-title",
          text: `Skipped (${skippedCount}) — will remain ungrouped`,
        }));
        const ul = h("ul", { class: "zao-preview-tab-list" });
        for (const t of currentPlan.skipped) ul.appendChild(renderTabRow(t, null));
        sec.appendChild(ul);
        body.appendChild(sec);
      }

      updateSummaryAndFooter();
      body.scrollTop = prevScrollTop;
    }

    function renameNewGroup(groupObj, nextRawName) {
      const nextName = String(nextRawName || "").trim();
      if (!nextName || nextName === groupObj.name) return false;

      const oldKey = newKey(groupObj.name);
      const targetKey = newKey(nextName);
      const wasKept = kept.has(oldKey);

      const collision = currentPlan.newGroups.find(
        (other) => other !== groupObj && other.name.toLowerCase() === nextName.toLowerCase(),
      );
      if (collision) {
        collision.tabs.push(...groupObj.tabs);
        currentPlan.newGroups = currentPlan.newGroups.filter((g) => g !== groupObj);
        kept.delete(oldKey);
        if (wasKept) kept.add(targetKey);
        render();
        return true;
      }

      groupObj.name = nextName;
      kept.delete(oldKey);
      if (wasKept) kept.add(targetKey);
      return true;
    }

    function excludeTabFromGroup(tabInfo, groupObj, kind) {
      if (kind === "new") {
        const idx = groupObj.tabs.indexOf(tabInfo);
        if (idx === -1) return;
        groupObj.tabs.splice(idx, 1);
        if (groupObj.tabs.length === 0) {
          currentPlan.newGroups = currentPlan.newGroups.filter((g) => g !== groupObj);
          kept.delete(newKey(groupObj.name));
        }
      } else {
        const targetLower = groupObj.name.toLowerCase();
        const idx = currentPlan.assignedToExisting.findIndex(
          (a) => a.tabInfo === tabInfo && a.groupName.toLowerCase() === targetLower,
        );
        if (idx === -1) return;
        currentPlan.assignedToExisting.splice(idx, 1);
        const remaining = currentPlan.assignedToExisting.some(
          (a) => a.groupName.toLowerCase() === targetLower,
        );
        if (!remaining) kept.delete(existingKey(groupObj.name));
      }
      currentPlan.skipped.push(tabInfo);
      render();
    }

    function renderGroupBlock(g, kind) {
      const getKey = () => (kind === "new" ? newKey(g.name) : existingKey(g.name));
      const isKeptInitial = kept.has(getKey());
      const classes = ["zao-preview-group"];
      if (isKeptInitial) classes.push("zao-kept");
      if (kind === "existing") classes.push("zao-preview-group-existing");
      const block = h("div", { class: classes.join(" ") });
      block.setAttribute("role", "button");
      block.setAttribute("aria-pressed", isKeptInitial ? "true" : "false");
      block.tabIndex = 0;

      const head = h("div", { class: "zao-preview-group-head" });
      const headLeft = h("div", { class: "zao-preview-group-head-left" });
      const prefix = kind === "existing" ? "→ " : "";

      const nameEl = h("span", {
        class: "zao-preview-group-name",
        text: `${prefix}${g.name}`,
      });
      const countEl = h("span", {
        class: "zao-preview-group-count",
        text: `(${g.tabs.length})`,
      });
      headLeft.append(nameEl, countEl);

      const startInlineRename = (e) => {
        e?.stopPropagation?.();
        if (kind !== "new" || headLeft.querySelector(".zao-preview-rename-input")) return;
        const input = h("input", { class: "zao-preview-rename-input" });
        input.type = "text";
        input.value = g.name;
        input.setAttribute("aria-label", `Rename group ${g.name}`);

        let finished = false;
        const finish = (commit) => {
          if (finished) return;
          finished = true;
          const nextValue = input.value;
          input.replaceWith(nameEl);
          if (commit) {
            const changed = renameNewGroup(g, nextValue);
            if (changed && nameEl.isConnected) {
              nameEl.textContent = g.name;
              updateSummaryAndFooter();
            }
          }
          if (block.isConnected) block.focus();
        };

        input.addEventListener("click", (ev) => ev.stopPropagation());
        input.addEventListener("keydown", (ev) => {
          ev.stopPropagation();
          if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
          else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
        });
        input.addEventListener("blur", () => finish(true));

        nameEl.replaceWith(input);
        input.focus();
        input.select();
      };

      if (kind === "new") {
        nameEl.title = "Double-click to rename group";
        nameEl.addEventListener("dblclick", startInlineRename);
        const renameBtn = h("button", { class: "zao-preview-group-rename-btn", text: "✎" });
        renameBtn.type = "button";
        renameBtn.title = "Rename group";
        renameBtn.setAttribute("aria-label", `Rename group ${g.name}`);
        renameBtn.addEventListener("click", startInlineRename);
        headLeft.appendChild(renameBtn);
      }

      const stateEl = h("span", {
        class: "zao-preview-group-state",
        text: isKeptInitial ? "✓ keep" : "skip",
      });
      head.append(headLeft, stateEl);
      block.appendChild(head);

      const toggleInPlace = () => {
        const key = getKey();
        const nextKept = !kept.has(key);
        if (nextKept) kept.add(key);
        else kept.delete(key);
        block.classList.toggle("zao-kept", nextKept);
        block.setAttribute("aria-pressed", nextKept ? "true" : "false");
        stateEl.textContent = nextKept ? "✓ keep" : "skip";
        updateSummaryAndFooter();
      };

      block.addEventListener("click", (e) => {
        if (e.target.closest?.("button, input")) return;
        toggleInPlace();
      });
      block.addEventListener("keydown", (e) => {
        if (e.target !== block) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleInPlace();
        }
      });

      const ul = h("ul", { class: "zao-preview-tab-list" });
      for (const t of g.tabs) {
        ul.appendChild(renderTabRow(t, () => excludeTabFromGroup(t, g, kind)));
      }
      block.appendChild(ul);
      return block;
    }

    function renderTabRow(tabInfo, onExclude) {
      const li = h("li", { class: "zao-preview-tab" });
      const iconSrc = tabInfo?._tab?.image;
      if (iconSrc) {
        const icon = h("img", { class: "zao-preview-tab-icon" });
        icon.src = iconSrc;
        icon.alt = "";
        icon.addEventListener("error", () => icon.remove(), { once: true });
        li.appendChild(icon);
      }
      li.appendChild(h("span", { class: "zao-preview-tab-host", text: tabInfo.hostname || "(no host)" }));
      const title = (tabInfo.title || "").replace(/\s+/g, " ").trim();
      if (title) {
        const titleSpan = h("span", { class: "zao-preview-tab-title", text: ` — ${title}` });
        titleSpan.title = title;
        li.appendChild(titleSpan);
      }
      if (typeof onExclude === "function") {
        const excludeBtn = h("button", { class: "zao-preview-tab-exclude", text: "×" });
        excludeBtn.type = "button";
        excludeBtn.title = "Exclude tab (move to skipped)";
        excludeBtn.setAttribute("aria-label", `Exclude ${tabInfo.hostname || "tab"} from group`);
        excludeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          onExclude();
        });
        li.appendChild(excludeBtn);
      }
      return li;
    }

    // ─── State helpers ─────────────────────────────────────────────────────
    function countKeptStats(existingTargets) {
      let groups = 0;
      let tabs = 0;
      for (const g of currentPlan.newGroups) {
        if (kept.has(newKey(g.name))) {
          groups++;
          tabs += g.tabs.length;
        }
      }
      for (const t of existingTargets) {
        if (kept.has(existingKey(t.name))) {
          groups++;
          tabs += t.tabs.length;
        }
      }
      return { groups, tabs };
    }

    function pendingTabs(existingTargets = groupExistingByTarget(currentPlan.assignedToExisting)) {
      const fromUnkeptNew = currentPlan.newGroups
        .filter((g) => !kept.has(newKey(g.name)))
        .flatMap((g) => g.tabs);
      const fromUnkeptExisting = existingTargets
        .filter((t) => !kept.has(existingKey(t.name)))
        .flatMap((t) => t.tabs);
      return [...fromUnkeptNew, ...fromUnkeptExisting, ...currentPlan.skipped];
    }

    function keptBuckets() {
      const existingTargets = groupExistingByTarget(currentPlan.assignedToExisting);
      const out = [];
      for (const g of currentPlan.newGroups) if (kept.has(newKey(g.name))) out.push(g);
      for (const t of existingTargets) if (kept.has(existingKey(t.name))) out.push(t);
      return out;
    }

    // ─── Per-button spinner-wrapped action runner ──────────────────────────
    const createSpinner = () => {
      const SVG = "http://www.w3.org/2000/svg";
      if (typeof document.createElementNS === "function") {
        const svg = document.createElementNS(SVG, "svg");
        svg.setAttribute("class", "zao-spinner-svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "14");
        svg.setAttribute("height", "14");
        svg.setAttribute("fill", "none");
        svg.setAttribute("aria-label", "Working");
        const track = document.createElementNS(SVG, "circle");
        track.setAttribute("class", "zao-loading-track");
        track.setAttribute("cx", "12");
        track.setAttribute("cy", "12");
        track.setAttribute("r", "8.5");
        const arc = document.createElementNS(SVG, "circle");
        arc.setAttribute("class", "zao-loading-arc");
        arc.setAttribute("cx", "12");
        arc.setAttribute("cy", "12");
        arc.setAttribute("r", "8.5");
        svg.append(track, arc);
        return svg;
      }
      const s = h("span", { class: "zao-spinner" });
      s.setAttribute("aria-label", "Working");
      return s;
    };

    async function runWithSpinner(activeBtn, fn) {
      if (busy) return;
      busy = true;
      const allControls = [
        reassignToPlannedBtn,
        reassignToExistingBtn,
        reassignToNewBtn,
        cancelBtn,
        applyBtn,
        ...(rerunBtn ? [rerunBtn] : []),
        ...(modelSelect ? [modelSelect] : []),
      ];
      const wasDisabled = allControls.map((el) => el.disabled);
      for (const el of allControls) el.disabled = true;

      const originalText = activeBtn.textContent;
      activeBtn.textContent = "";
      const spinner = createSpinner();
      activeBtn.appendChild(spinner);
      activeBtn.setAttribute("aria-busy", "true");

      try {
        await fn();
      } catch (e) {
        console.error(`${LOG} preview modal: action failed:`, e);
      } finally {
        busy = false;
        spinner.remove();
        activeBtn.removeAttribute("aria-busy");
        activeBtn.textContent = originalText;
        for (let i = 0; i < allControls.length; i++) allControls[i].disabled = wasDisabled[i];
        if (!done) render();
      }
    }

    // ─── Model switcher / Re-run handler ───────────────────────────────────
    async function onRerunClick() {
      if (!rerunBtn || rerunBtn.disabled || typeof onModelChangeAndRerun !== "function") return;
      const selectedModel = modelSelect ? modelSelect.value : activeModelLabel;
      await runWithSpinner(rerunBtn, async () => {
        const nextPlan = await onModelChangeAndRerun(selectedModel);
        if (!nextPlan || done) return;
        currentPlan = clonePlan(nextPlan);
        seedKeptFromPlan(currentPlan);
        if (modelBadge && selectedModel) modelBadge.textContent = selectedModel;
        console.log(`${LOG} preview modal: re-ran grouping with model "${selectedModel || "default"}"`);
      });
    }

    // ─── Re-assign handlers ────────────────────────────────────────────────
    async function onReassignToNewClick() {
      if (reassignToNewBtn.disabled) return;
      const pending = pendingTabs();
      if (pending.length === 0 || typeof onReassignToNew !== "function") return;
      await runWithSpinner(reassignToNewBtn, async () => {
        const result = await onReassignToNew(pending);
        const incomingGroups = (result && result.newGroups) || [];
        const newSkipped = (result && result.skipped) || [];

        currentPlan.newGroups = currentPlan.newGroups.filter((g) => kept.has(newKey(g.name)));
        currentPlan.assignedToExisting = currentPlan.assignedToExisting.filter((a) =>
          kept.has(existingKey(a.groupName)),
        );
        currentPlan.newGroups.push(...incomingGroups);
        currentPlan.skipped = newSkipped;
        for (const g of incomingGroups) kept.add(newKey(g.name));
        console.log(`${LOG} preview modal: re-assigned ${pending.length} tab(s) to new → ${incomingGroups.length} new group(s), ${newSkipped.length} skipped`);
      });
    }

    async function onReassignToPlannedClick() {
      if (reassignToPlannedBtn.disabled) return;
      const pending = pendingTabs();
      if (pending.length === 0) return;
      const buckets = keptBuckets();
      if (buckets.length === 0 || typeof onAssignToPlanned !== "function") return;

      await runWithSpinner(reassignToPlannedBtn, async () => {
        const result = await onAssignToPlanned(pending, buckets);
        const assignments = (result && result.assignments) || [];
        const newSkipped = (result && result.skipped) || [];

        const newByLower = new Map();
        const existingByLower = new Set();
        for (const g of currentPlan.newGroups) {
          if (kept.has(newKey(g.name))) newByLower.set(g.name.toLowerCase(), g);
        }
        for (const a of currentPlan.assignedToExisting) {
          if (kept.has(existingKey(a.groupName))) existingByLower.add(a.groupName.toLowerCase());
        }

        currentPlan.newGroups = currentPlan.newGroups.filter((g) => kept.has(newKey(g.name)));
        currentPlan.assignedToExisting = currentPlan.assignedToExisting.filter((a) =>
          kept.has(existingKey(a.groupName)),
        );

        let placed = 0;
        for (const { tabInfo, groupName } of assignments) {
          const lower = String(groupName || "").toLowerCase();
          if (newByLower.has(lower)) {
            newByLower.get(lower).tabs.push(tabInfo);
            placed++;
          } else if (existingByLower.has(lower)) {
            const canonical = [...currentPlan.assignedToExisting].find(
              (a) => a.groupName.toLowerCase() === lower,
            )?.groupName || groupName;
            currentPlan.assignedToExisting.push({ tabInfo, groupName: canonical, similarity: 1.0 });
            placed++;
          } else {
            newSkipped.push(tabInfo);
          }
        }
        currentPlan.skipped = newSkipped;
        console.log(`${LOG} preview modal: re-assigned ${pending.length} tab(s) to planned → ${placed} placed, ${newSkipped.length} skipped`);
      });
    }

    async function onReassignToExistingClick() {
      if (reassignToExistingBtn.disabled) return;
      const pending = pendingTabs();
      if (pending.length === 0 || typeof onAssignToExisting !== "function") return;

      await runWithSpinner(reassignToExistingBtn, async () => {
        const result = await onAssignToExisting(pending);
        const assignments = (result && result.assignments) || [];
        const newSkipped = (result && result.skipped) || [];

        currentPlan.newGroups = currentPlan.newGroups.filter((g) => kept.has(newKey(g.name)));
        currentPlan.assignedToExisting = currentPlan.assignedToExisting.filter((a) =>
          kept.has(existingKey(a.groupName)),
        );

        let placed = 0;
        for (const { tabInfo, groupName } of assignments) {
          const name = String(groupName || "").trim();
          if (!name) {
            newSkipped.push(tabInfo);
            continue;
          }
          currentPlan.assignedToExisting.push({ tabInfo, groupName: name, similarity: 1.0 });
          kept.add(existingKey(name));
          placed++;
        }
        currentPlan.skipped = newSkipped;
        console.log(`${LOG} preview modal: re-assigned ${pending.length} tab(s) to existing rules → ${placed} placed, ${newSkipped.length} skipped`);
      });
    }

    // ─── Apply ─────────────────────────────────────────────────────────────
    function onApplyClick() {
      const droppedTabs = [];
      const finalNewGroups = currentPlan.newGroups.filter((g) => {
        if (kept.has(newKey(g.name))) return true;
        droppedTabs.push(...g.tabs);
        return false;
      });
      const finalExisting = currentPlan.assignedToExisting.filter((a) => {
        if (kept.has(existingKey(a.groupName))) return true;
        droppedTabs.push(a.tabInfo);
        return false;
      });
      cleanup({
        assignedToExisting: finalExisting,
        newGroups: finalNewGroups,
        skipped: [...currentPlan.skipped, ...droppedTabs],
      });
    }

    // ─── Cancel paths & AbortSignal ────────────────────────────────────────
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      cleanup(null);
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) cleanup(null);
    });

    const onAbort = () => cleanup(null);
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────
    let done = false;
    function cleanup(result) {
      if (done) return;
      done = true;
      try { signal?.removeEventListener?.("abort", onAbort); } catch {}
      try { dialog.close(); } catch {}
      dialog.remove();
      console.log(`${LOG} preview modal closed (apply=${result !== null})`);
      resolve(result);
    }

    render();
    document.body.appendChild(dialog);
    dialog.showModal();
    applyBtn.focus();
    console.log(`${LOG} preview modal opened`);
  });
};
