// Zen Tab Sorting — settings rules editor widget.
// Builds the pill table (Category | Domains) with +/- buttons, color swatch per row,
// URL-to-hostname normalization & dedupe, keyboard row reorder, cached drag midpoints,
// and non-blocking inline Backup/Restore feedback.

import { CONFIG, LOG, h } from "./config.mjs";
import { readRulesPref, writeRulesPref, readSkipDomainsPref, writeSkipDomainsPref } from "./rules.mjs";
import {
  openColorPopover,
  updateSwatchAppearance,
} from "./color-picker.mjs";

let rulesPrefObserver = null;

/**
 * Normalize user-typed or pasted URLs/hostnames into clean lowercase domain
 * tokens (preserving leading `*.` wildcards). Splits comma/whitespace-separated
 * entries so pasting multiple domains works in one step.
 */
export const normalizeDomainInput = (raw) => {
  if (typeof raw !== "string") return [];
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const token of tokens) {
    const wildcard = token.startsWith("*.");
    const stripped = wildcard ? token.slice(2) : token;
    if (!stripped) continue;

    let host = "";
    try {
      const candidate = stripped.includes("://") ? stripped : `https://${stripped}`;
      const parsed = new URL(candidate);
      host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      host = stripped
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
        .split(/[/?#]/)[0]
        .replace(/:\d+$/, "")
        .toLowerCase()
        .replace(/\.+$/, "");
    }
    if (!host) continue;
    const normalized = wildcard ? `*.${host}` : host;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
};

export const buildRulesEditor = (rules) => {
  const container = h("div", { class: "zao-rules-editor" });
  const persist = () => writeRulesPref(rules);

  let render;

  const restoreFocus = (target) => {
    if (!target) return;
    const rows = container.querySelectorAll(".zao-row");
    if (target.type === "group-name") {
      const row = rows[target.idx];
      row?.querySelector(".zao-group-name")?.focus();
    } else if (target.type === "pill-add") {
      const row = rows[target.idx];
      row?.querySelector(".zao-pill-add")?.focus();
    } else if (target.type === "pill-remove") {
      const row = rows[target.idx];
      const removeBtns = row?.querySelectorAll(".zao-pill-remove");
      if (removeBtns?.length) {
        removeBtns[Math.min(target.pillIdx, removeBtns.length - 1)]?.focus();
      } else {
        row?.querySelector(".zao-pill-add")?.focus();
      }
    } else if (target.type === "grip") {
      const row = rows[target.idx];
      row?.querySelector(".zao-row-grip")?.focus();
    } else if (target.type === "row-remove") {
      if (rows.length > 0) {
        const row = rows[Math.min(target.idx, rows.length - 1)];
        row?.querySelector(".zao-remove-row")?.focus();
      } else {
        container.querySelector(".zao-add-row-btn")?.focus();
      }
    }
  };

  const renderPill = (rule, rowIdx, dIdx) => {
    const pill = h("span", { class: "zao-pill" });

    const text = h("span", { text: rule.domains[dIdx] });
    pill.appendChild(text);

    const remove = h("button", { class: "zao-pill-remove", text: "×" });
    remove.type = "button";
    remove.title = "Remove this domain";
    remove.setAttribute("aria-label", `Remove domain ${rule.domains[dIdx]}`);
    remove.addEventListener("click", () => {
      rule.domains.splice(dIdx, 1);
      persist();
      render({ type: "pill-remove", idx: rowIdx, pillIdx: dIdx });
    });
    pill.appendChild(remove);

    return pill;
  };

  const renderAddPill = (rule, rowIdx) => {
    const addBtn = h("button", { class: "zao-pill-add", text: "+" });
    addBtn.type = "button";
    addBtn.title = "Add domain";
    addBtn.setAttribute("aria-label", `Add domain to ${rule.name || `group ${rowIdx + 1}`}`);
    addBtn.addEventListener("click", () => {
      const input = h("input", { class: "zao-pill-input" });
      input.type = "text";
      input.placeholder = "host.com or *.host.com";
      input.setAttribute("aria-label", `Domain for ${rule.name || `group ${rowIdx + 1}`}`);

      let done = false;
      const commit = (focusNext) => {
        if (done) return;
        done = true;
        const normalized = normalizeDomainInput(input.value);
        if (normalized.length > 0) {
          const existing = new Set(rule.domains.map((d) => String(d).toLowerCase()));
          let added = false;
          for (const domain of normalized) {
            if (!existing.has(domain.toLowerCase())) {
              rule.domains.push(domain);
              existing.add(domain.toLowerCase());
              added = true;
            }
          }
          if (added) persist();
        }
        render(focusNext ? { type: "pill-add", idx: rowIdx } : null);
      };
      const cancel = () => {
        if (done) return;
        done = true;
        render({ type: "pill-add", idx: rowIdx });
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(true); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
      input.addEventListener("blur", () => setTimeout(() => commit(false), 0));

      addBtn.replaceWith(input);
      input.focus();
    });
    return addBtn;
  };

  const renderColorCell = (rule) => {
    const cell = h("div", { class: "zao-color-cell" });

    // Use <div role="button"> — a real <button> picks up chrome-button theming
    // that fights our 22×22 circle sizing.
    const swatch = h("div", { class: "zao-swatch" });
    swatch.setAttribute("role", "button");
    swatch.setAttribute("tabindex", "0");
    updateSwatchAppearance(swatch, rule.color);
    const open = (e) => {
      e.stopPropagation();
      openColorPopover(rule, swatch, persist);
    };
    swatch.addEventListener("click", open);
    swatch.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); }
    });
    cell.appendChild(swatch);
    return cell;
  };

  // Drag-and-drop reorder state with per-session cached row midpoints (zero
  // getBoundingClientRect calls during dragover).
  let dragFromIdx = null;
  let dragToIdx = null;
  let cachedRows = null;

  const clearDropIndicators = () => {
    container.querySelectorAll(".zao-row-drop-before, .zao-row-drop-after")
      .forEach((el) => el.classList.remove("zao-row-drop-before", "zao-row-drop-after"));
  };

  const cacheRowMidpoints = () => {
    cachedRows = Array.from(container.querySelectorAll(".zao-row")).map((el, idx) => {
      const r = el.getBoundingClientRect();
      return { el, idx, top: r.top, bottom: r.bottom, mid: r.top + r.height / 2 };
    });
  };

  const invalidateRowCache = () => {
    cachedRows = null;
  };

  const reorderRules = (fromIdx, toIdx, focusTarget = null) => {
    if (fromIdx === toIdx || fromIdx === toIdx - 1) return;
    if (fromIdx < 0 || fromIdx >= rules.length) return;
    const [moved] = rules.splice(fromIdx, 1);
    const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
    rules.splice(adjustedTo, 0, moved);
    persist();
    render(focusTarget);
  };

  const renderRow = (rule, idx) => {
    const row = h("div", { class: "zao-row" });
    row.dataset.zaoIdx = String(idx);

    const grip = h("div", { class: "zao-row-grip", text: "⋮⋮" });
    grip.setAttribute("role", "button");
    grip.tabIndex = 0;
    grip.title = "Drag to reorder (or press Alt+Up / Alt+Down)";
    grip.setAttribute("aria-label", `Reorder group ${rule.name || idx + 1} (Alt+Up or Alt+Down)`);
    grip.setAttribute("draggable", "true");
    grip.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/zao-rule-idx", String(idx));
      dragFromIdx = idx;
      dragToIdx = null;
      cacheRowMidpoints();
      try { e.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2); } catch {}
      row.classList.add("zao-row-dragging");
    });
    grip.addEventListener("dragend", () => {
      row.classList.remove("zao-row-dragging");
      clearDropIndicators();
      invalidateRowCache();
      dragFromIdx = null;
      dragToIdx = null;
    });
    row.appendChild(grip);

    row.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      if (e.key === "ArrowUp" && idx > 0) {
        e.preventDefault();
        reorderRules(idx, idx - 1, { type: "grip", idx: idx - 1 });
      } else if (e.key === "ArrowDown" && idx < rules.length - 1) {
        e.preventDefault();
        reorderRules(idx, idx + 2, { type: "grip", idx: idx + 1 });
      }
    });

    row.appendChild(renderColorCell(rule));

    const nameInput = h("input", { class: "zao-group-name" });
    nameInput.type = "text";
    nameInput.placeholder = "Group name";
    nameInput.setAttribute("aria-label", `Group ${idx + 1} name`);
    nameInput.value = rule.name || "";
    nameInput.addEventListener("input", () => {
      rule.name = nameInput.value;
      persist();
    });
    row.appendChild(nameInput);

    const domainsEl = h("div", { class: "zao-domains" });
    if (!Array.isArray(rule.domains)) rule.domains = [];
    rule.domains.forEach((_, dIdx) => domainsEl.appendChild(renderPill(rule, idx, dIdx)));
    domainsEl.appendChild(renderAddPill(rule, idx));
    row.appendChild(domainsEl);

    const removeBtn = h("button", { class: "zao-remove-row", text: "×" });
    removeBtn.type = "button";
    removeBtn.title = "Remove this group";
    removeBtn.setAttribute("aria-label", `Remove group ${rule.name || idx + 1}`);
    removeBtn.addEventListener("click", () => {
      rules.splice(idx, 1);
      persist();
      render({ type: "row-remove", idx });
    });
    row.appendChild(removeBtn);

    return row;
  };

  if (!container._zaoContainerDragListenersInstalled) {
    container._zaoContainerDragListenersInstalled = true;
    container.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/zao-rule-idx")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!cachedRows) cacheRowMidpoints();
      if (!cachedRows || cachedRows.length === 0) return;

      let target = null;
      let above = true;
      const first = cachedRows[0];
      const last = cachedRows[cachedRows.length - 1];
      if (e.clientY < first.top) {
        target = first;
        above = true;
      } else if (e.clientY > last.bottom) {
        target = last;
        above = false;
      } else {
        for (const entry of cachedRows) {
          if (e.clientY >= entry.top && e.clientY <= entry.bottom) {
            target = entry;
            above = e.clientY < entry.mid;
            break;
          }
        }
      }
      if (!target) return;
      const newToIdx = above ? target.idx : target.idx + 1;
      if (dragToIdx === newToIdx) return;
      dragToIdx = newToIdx;
      clearDropIndicators();
      target.el.classList.toggle("zao-row-drop-before", above);
      target.el.classList.toggle("zao-row-drop-after", !above);
    });
    container.addEventListener("drop", (e) => {
      const fromStr = e.dataTransfer.getData("text/zao-rule-idx");
      if (!fromStr) return;
      e.preventDefault();
      const fromIdx = parseInt(fromStr, 10);
      const toIdx = dragToIdx;
      clearDropIndicators();
      invalidateRowCache();
      dragFromIdx = null;
      dragToIdx = null;
      if (toIdx === null) return;
      const finalIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
      reorderRules(fromIdx, toIdx, { type: "grip", idx: finalIdx });
    });
  }

  render = (focusTarget = null) => {
    invalidateRowCache();
    container.replaceChildren();

    const header = h("div", { class: "zao-header" });
    header.appendChild(h("div")); // grip column
    header.appendChild(h("div")); // color column
    header.appendChild(h("div", { text: "Category" }));
    header.appendChild(h("div", { text: "Domains" }));
    header.appendChild(h("div")); // remove column
    container.appendChild(header);

    if (rules.length === 0) {
      container.appendChild(h("div", {
        class: "zao-empty",
        text: "No groups yet — click \"+ Add group\" to start.",
      }));
    } else {
      rules.forEach((rule, idx) => container.appendChild(renderRow(rule, idx)));
    }

    const addRow = h("div", { class: "zao-add-row" });
    const addRowBtn = h("button", { class: "zao-add-row-btn", text: "+ Add group" });
    addRowBtn.type = "button";
    addRowBtn.addEventListener("click", () => {
      rules.push({ name: "", domains: [] });
      persist();
      render({ type: "group-name", idx: rules.length - 1 });
    });
    addRow.appendChild(addRowBtn);
    container.appendChild(addRow);

    if (focusTarget) restoreFocus(focusTarget);
  };

  const refreshFromPref = (reason) => {
    if (!container.isConnected) return;
    const fresh = readRulesPref({ keepIncomplete: true });
    if (!fresh) return;
    if (JSON.stringify(fresh) === JSON.stringify(rules)) return;
    console.log(`${LOG} widget refresh (${reason}): ${rules.length} → ${fresh.length} rule(s)`);
    rules.length = 0;
    rules.push(...fresh);
    render();
  };

  container._zaoRefresh = refreshFromPref;

  if (rulesPrefObserver) {
    try { Services.prefs.removeObserver(CONFIG.RULES_PREF, rulesPrefObserver); } catch {}
    rulesPrefObserver = null;
  }
  rulesPrefObserver = {
    observe(_, topic, data) {
      if (topic !== "nsPref:changed" || data !== CONFIG.RULES_PREF) return;
      if (!container.isConnected) {
        try { Services.prefs.removeObserver(CONFIG.RULES_PREF, rulesPrefObserver); } catch {}
        rulesPrefObserver = null;
        return;
      }
      refreshFromPref("pref change");
    },
  };
  try {
    Services.prefs.addObserver(CONFIG.RULES_PREF, rulesPrefObserver);
    console.log(`${LOG} registered rules pref observer for ${CONFIG.RULES_PREF}`);
  } catch (e) {
    console.error(`${LOG} failed to add rules pref observer:`, e);
  }

  render();
  return container;
};

// ──────────────────────────────────────────────────────────────────────────────
// Skip-domains editor — simple pill list.
// ──────────────────────────────────────────────────────────────────────────────

let skipPrefObserver = null;

export const buildSkipDomainsEditor = () => {
  const initial = readSkipDomainsPref();
  const domains = Array.isArray(initial) ? [...initial] : [];
  const container = h("div", { class: "zao-skip-editor" });
  const persist = () => writeSkipDomainsPref(domains);

  let render;

  const restoreFocus = (target) => {
    if (!target) return;
    if (target.type === "add") {
      container.querySelector(".zao-pill-add")?.focus();
    } else if (target.type === "remove") {
      const btns = container.querySelectorAll(".zao-pill-remove");
      if (btns.length > 0) btns[Math.min(target.idx, btns.length - 1)]?.focus();
      else container.querySelector(".zao-pill-add")?.focus();
    }
  };

  const renderPill = (idx) => {
    const pill = h("span", { class: "zao-pill" });
    pill.appendChild(h("span", { text: domains[idx] }));
    const remove = h("button", { class: "zao-pill-remove", text: "×" });
    remove.type = "button";
    remove.title = "Remove from skip list";
    remove.setAttribute("aria-label", `Remove ${domains[idx]} from skip list`);
    remove.addEventListener("click", () => {
      domains.splice(idx, 1);
      persist();
      render({ type: "remove", idx });
    });
    pill.appendChild(remove);
    return pill;
  };

  const renderAddPill = () => {
    const addBtn = h("button", { class: "zao-pill-add", text: "+" });
    addBtn.type = "button";
    addBtn.title = "Add a domain to skip";
    addBtn.setAttribute("aria-label", "Add domain to skip list");
    addBtn.addEventListener("click", () => {
      const input = h("input", { class: "zao-pill-input" });
      input.type = "text";
      input.placeholder = "host.com or *.host.com";
      input.setAttribute("aria-label", "Domain to skip");

      let done = false;
      const commit = (focusNext) => {
        if (done) return;
        done = true;
        const normalized = normalizeDomainInput(input.value);
        if (normalized.length > 0) {
          const existing = new Set(domains.map((d) => String(d).toLowerCase()));
          let added = false;
          for (const domain of normalized) {
            if (!existing.has(domain.toLowerCase())) {
              domains.push(domain);
              existing.add(domain.toLowerCase());
              added = true;
            }
          }
          if (added) persist();
        }
        render(focusNext ? { type: "add" } : null);
      };
      const cancel = () => {
        if (done) return;
        done = true;
        render({ type: "add" });
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(true); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
      input.addEventListener("blur", () => setTimeout(() => commit(false), 0));

      addBtn.replaceWith(input);
      input.focus();
    });
    return addBtn;
  };

  render = (focusTarget = null) => {
    container.replaceChildren();
    const row = h("div", { class: "zao-skip-row" });
    if (domains.length === 0) {
      row.appendChild(h("span", {
        class: "zao-skip-empty",
        text: "No domains skipped — add hostnames you never want the tidy click to touch.",
      }));
    } else {
      domains.forEach((_, idx) => row.appendChild(renderPill(idx)));
    }
    row.appendChild(renderAddPill());
    container.appendChild(row);
    if (focusTarget) restoreFocus(focusTarget);
  };

  const refreshFromPref = () => {
    if (!container.isConnected) return;
    const fresh = readSkipDomainsPref();
    if (JSON.stringify(fresh) === JSON.stringify(domains)) return;
    domains.length = 0;
    domains.push(...fresh);
    render();
  };
  container._zaoSkipRefresh = refreshFromPref;

  if (skipPrefObserver) {
    try { Services.prefs.removeObserver(CONFIG.SKIP_DOMAINS_PREF, skipPrefObserver); } catch {}
    skipPrefObserver = null;
  }
  skipPrefObserver = {
    observe(_, topic, data) {
      if (topic !== "nsPref:changed" || data !== CONFIG.SKIP_DOMAINS_PREF) return;
      if (!container.isConnected) {
        try { Services.prefs.removeObserver(CONFIG.SKIP_DOMAINS_PREF, skipPrefObserver); } catch {}
        skipPrefObserver = null;
        return;
      }
      refreshFromPref();
    },
  };
  try { Services.prefs.addObserver(CONFIG.SKIP_DOMAINS_PREF, skipPrefObserver); } catch {}

  render();
  return container;
};

export const teardownSkipPrefObserver = () => {
  if (!skipPrefObserver) return;
  try { Services.prefs.removeObserver(CONFIG.SKIP_DOMAINS_PREF, skipPrefObserver); } catch {}
  skipPrefObserver = null;
};

// ──────────────────────────────────────────────────────────────────────────────
// Backup & Restore — Export / Import with non-blocking inline status & confirm.
// ──────────────────────────────────────────────────────────────────────────────
export const buildBackupRestoreSection = () => {
  const section = h("div", { class: "zao-backup-section" });
  const bar = h("div", { class: "zao-backup-row" });

  const statusEl = h("div", { class: "zao-backup-status" });
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");

  const confirmBox = h("div", { class: "zao-backup-confirm" });
  confirmBox.hidden = true;

  let statusTimer = null;
  const setStatus = (text, state = "info", clearAfterMs = 0) => {
    if (statusTimer != null) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    statusEl.textContent = text || "";
    if (state) statusEl.dataset.state = state;
    else delete statusEl.dataset.state;
    if (clearAfterMs > 0) {
      statusTimer = setTimeout(() => {
        statusTimer = null;
        statusEl.textContent = "";
        delete statusEl.dataset.state;
      }, clearAfterMs);
    }
  };

  const clearConfirm = () => {
    confirmBox.replaceChildren();
    confirmBox.hidden = true;
  };

  const showInlineConfirm = (summaryText, onConfirm) => {
    confirmBox.replaceChildren();
    confirmBox.hidden = false;

    const msg = h("span", { class: "zao-backup-confirm-text", text: summaryText });
    const actions = h("div", { class: "zao-backup-confirm-actions" });

    const confirmBtn = h("button", { class: "zao-backup-btn zao-backup-btn-primary", text: "Replace settings" });
    confirmBtn.type = "button";
    confirmBtn.addEventListener("click", () => {
      clearConfirm();
      onConfirm();
    });

    const cancelBtn = h("button", { class: "zao-backup-btn", text: "Cancel" });
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", () => {
      clearConfirm();
      setStatus("Import cancelled.", "info", 2500);
      importBtn.focus();
    });

    actions.append(confirmBtn, cancelBtn);
    confirmBox.append(msg, actions);
    confirmBtn.focus();
  };

  const exportBtn = h("button", { class: "zao-backup-btn", text: "Export" });
  exportBtn.type = "button";
  exportBtn.title = "Download current rules + skip-domains as a JSON file";
  exportBtn.addEventListener("click", async () => {
    clearConfirm();
    const payload = {
      rules: readRulesPref({ keepIncomplete: true }) || [],
      skipDomains: readSkipDomainsPref() || [],
    };
    const json = JSON.stringify(payload, null, 2);
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .replace(/\..*$/, "")
      .replace(/^(\d{8})(\d{6})$/, "$1-$2");
    const filename = `wand-backup-${payload.rules.length}groups-${ts}.json`;

    const finish = (label, statusMsg, state = "ok") => {
      const original = exportBtn.textContent;
      exportBtn.textContent = label;
      setTimeout(() => { exportBtn.textContent = original; }, 1500);
      setStatus(statusMsg, state, 5000);
    };

    const fallbackToClipboard = async () => {
      try {
        await navigator.clipboard.writeText(json);
        finish("Copied!", "Saved to clipboard (downloads folder unavailable).", "ok");
      } catch (e) {
        console.error(`${LOG} clipboard fallback failed:`, e);
        console.log(json);
        setStatus("Couldn't save or copy — backup JSON logged to Browser Console.", "err");
      }
    };

    try {
      const { Downloads } = ChromeUtils.importESModule(
        "resource://gre/modules/Downloads.sys.mjs",
      );
      const downloadsDir = await Downloads.getPreferredDownloadsDirectory();
      const targetPath = PathUtils.join(downloadsDir, filename);
      await IOUtils.writeUTF8(targetPath, json);
      try {
        const list = await Downloads.getList(Downloads.PUBLIC);
        const download = await Downloads.createDownload({
          source: { url: "data:application/json,zen-tab-sorting-export" },
          target: { path: targetPath },
        });
        download.succeeded = true;
        download.stopped = true;
        download.canceled = false;
        download.error = null;
        download.progress = 100;
        download.hasProgress = true;
        const byteLen = new TextEncoder().encode(json).byteLength;
        download.totalBytes = byteLen;
        download.currentBytes = byteLen;
        await list.add(download);
      } catch (e) {
        console.warn(`${LOG} could not register download with Firefox's download list:`, e);
      }
      console.log(`${LOG} exported ${payload.rules.length} rule(s) + ${payload.skipDomains.length} skip-domain(s) → ${targetPath}`);
      finish("Downloaded!", `Exported ${filename}`, "ok");
    } catch (e) {
      console.error(`${LOG} export failed:`, e);
      await fallbackToClipboard();
    }
  });
  bar.appendChild(exportBtn);

  const importBtn = h("button", { class: "zao-backup-btn", text: "Import…" });
  importBtn.type = "button";
  importBtn.title = "Replace rules + skip-domains from a JSON file";
  importBtn.addEventListener("click", () => {
    clearConfirm();
    const picker = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    picker.type = "file";
    picker.accept = "application/json,.json";
    picker.style.display = "none";
    picker.addEventListener("change", async () => {
      const file = picker.files?.[0];
      picker.remove();
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        let importedRules = null;
        let importedSkip = null;
        if (Array.isArray(parsed)) {
          importedRules = parsed;
        } else if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed.rules)) importedRules = parsed.rules;
          if (Array.isArray(parsed.skipDomains)) importedSkip = parsed.skipDomains;
        } else {
          throw new Error("Top-level must be an array or { rules, skipDomains } object");
        }
        if (!importedRules && !importedSkip) {
          throw new Error("Nothing to import (no rules or skipDomains found)");
        }

        let validRules = null;
        if (importedRules) {
          validRules = importedRules
            .map((r) => ({
              name: typeof r?.name === "string" ? r.name.trim() : "",
              domains: Array.isArray(r?.domains)
                ? r.domains.flatMap((d) => normalizeDomainInput(String(d)))
                : [],
              ...(typeof r?.color === "string" ? { color: r.color } : {}),
            }))
            .filter((r) => r.name && r.domains.length);
          if (validRules.length === 0 && !importedSkip) {
            throw new Error("No valid rules in import (each needs name + domains)");
          }
        }

        let validSkip = null;
        if (importedSkip) {
          validSkip = [...new Set(importedSkip.flatMap((d) => normalizeDomainInput(String(d))))];
        }

        const current = {
          rules: (readRulesPref({ keepIncomplete: true }) || []).length,
          skip: (readSkipDomainsPref() || []).length,
        };
        const summaryParts = [];
        if (validRules) summaryParts.push(`Rules: ${current.rules} → ${validRules.length}`);
        if (validSkip) summaryParts.push(`Skip: ${current.skip} → ${validSkip.length}`);

        showInlineConfirm(`Replace current settings? (${summaryParts.join(" · ")})`, () => {
          if (validRules) writeRulesPref(validRules);
          if (validSkip) writeSkipDomainsPref(validSkip);
          const importedSummary = [
            validRules ? `${validRules.length} rule(s)` : "",
            validSkip ? `${validSkip.length} skip-domain(s)` : "",
          ].filter(Boolean).join(" and ");
          console.log(`${LOG} imported ${importedSummary}`);
          setStatus(`Imported ${importedSummary}.`, "ok", 5000);
        });
      } catch (e) {
        console.error(`${LOG} import failed:`, e);
        setStatus(`Import failed: ${e.message}`, "err");
      }
    });
    document.documentElement.appendChild(picker);
    picker.click();
  });
  bar.appendChild(importBtn);

  section.append(bar, confirmBox, statusEl);
  return section;
};

export const teardownRulesPrefObserver = () => {
  if (!rulesPrefObserver) return;
  try { Services.prefs.removeObserver(CONFIG.RULES_PREF, rulesPrefObserver); } catch {}
  rulesPrefObserver = null;
};
