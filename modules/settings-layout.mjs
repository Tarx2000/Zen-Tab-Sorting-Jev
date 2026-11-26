// Zen Tab Sorting — Settings dialog layout, Q6 Standard vs Fine-Tuning drawers,
// per-section Reset-to-Defaults headers, color strength slider, and key masking.

import { CONFIG, h } from "./config.mjs";
import { normalizeGroupColorStrength } from "./group-appearance.mjs";
import { getLocale } from "./i18n.mjs";

const isGerman = () => getLocale() === "de";
const loc = (de, en) => (isGerman() ? de : en);

export const setupNewGroupStrengthControl = (dialog) => {
  const row = dialog.querySelector(`#${CONFIG.NEW_GROUP_COLOR_STRENGTH_PREF.replaceAll(".", "-")}`);
  const input = row?.querySelector("input");
  if (!input || row.querySelector(".zao-group-strength-control")) return;
  const control = h("div", { class: "zao-group-strength-control" });
  input.before(control);
  control.appendChild(input);
  const strength = normalizeGroupColorStrength(input.value);
  input.type = "range";
  input.min = "0";
  input.max = "100";
  input.step = "1";
  input.value = String(strength);
  input.id = "zao-new-group-color-strength";
  const output = h("output");
  output.setAttribute("for", input.id);
  const preview = h("div", { class: "zao-group-strength-preview" });
  preview.append(
    h("strong", { text: loc("Neue Gruppe", "New group") }),
    h("div", { text: loc("Beispiel-Tab", "Example tab") }),
  );
  const note = h("p", {
    class: "zao-group-strength-note",
    text: loc(
      "Nur neu von der Sortierung erstellte Gruppen nutzen diesen Wert. Bestehende Gruppen behalten ihr Aussehen. Der Minimal-Stil hat Vorrang.",
      "Only new groups created by Autosort use this value. Existing groups keep their saved appearance. Minimal style takes precedence.",
    ),
  });
  const update = () => {
    output.textContent = `${input.value}%`;
    preview.style.setProperty("--zao-preview-strength", `${input.value}%`);
  };
  input.addEventListener("input", update);
  input.addEventListener("change", update);
  control.append(output, preview, note);
  update();
};

const separator = (dialog, prefix) => [...dialog.querySelectorAll(".separator-label")]
  .find((label) => label.textContent.trim().startsWith(prefix))?.closest("vbox");

const findPrefRow = (root, prefName) =>
  root?.querySelector?.(`#${CSS.escape(prefName.replaceAll(".", "-"))}`) || null;

const createFineTuningDrawer = (parentCard, summaryLabel, prefNames, sectionId) => {
  if (!parentCard) return null;
  const rows = prefNames.map((name) => findPrefRow(parentCard, name)).filter(Boolean);
  if (rows.length === 0) return null;
  const details = h("details", { class: "zao-settings-card zao-fine-tuning-details" });
  details.dataset.zaoSection = sectionId;
  details.appendChild(h("summary", { text: summaryLabel }));
  const inner = h("div", { class: "zao-details-content" });
  for (const row of rows) inner.appendChild(row);
  details.appendChild(inner);
  parentCard.appendChild(details);
  return details;
};

const attachSectionResetButton = (card, sectionId, onResetSection) => {
  if (!card || typeof onResetSection !== "function") return;
  const headerRow = card.querySelector(".zao-section-header-row");
  if (!headerRow || card.querySelector(".zao-section-reset-btn")) return;

  const wrapper = h("div", { class: "zao-section-header-bar" });
  headerRow.before(wrapper);
  wrapper.appendChild(headerRow);

  const resetBtn = h("button", {
    class: "zao-section-reset-btn",
    text: loc("Standard", "Reset section"),
  });
  resetBtn.type = "button";
  resetBtn.dataset.zaoResetSection = sectionId;
  resetBtn.title = loc(
    "Setzt nur die Tuning-Werte dieses Abschnitts zurück (API-Keys, Login & Regeln bleiben erhalten).",
    "Resets only tuning values in this section (API keys, sign-in & rules are preserved).",
  );
  resetBtn.addEventListener("click", (e) => {
    e.preventDefault();
    onResetSection(sectionId);
  });
  wrapper.appendChild(resetBtn);
};

export const organizeSettingsLayout = (dialog, content, { onResetSection } = {}) => {
  const wrap = (title, endTitle, id, collapsed = false) => {
    const first = separator(dialog, title);
    if (!first) return null;
    const last = endTitle ? separator(dialog, endTitle) : null;
    const parent = first.parentNode;
    const box = h(collapsed ? "details" : "section", { class: "zao-settings-card" });
    box.dataset.zaoSection = id;
    parent.insertBefore(box, first);
    let target = box;
    if (collapsed) {
      box.appendChild(h("summary", { text: title }));
      target = h("div", { class: "zao-details-content" });
      box.appendChild(target);
      first.classList.add("zao-pref-hidden");
    }
    let node = first;
    while (node && node !== last) {
      const next = node.nextSibling;
      target.appendChild(node);
      node = next;
    }
    return box;
  };

  wrap("AI Sorting", "1. Existing groups", "overview");
  const jev = wrap("1. Existing groups", "2. New groups", "jev");
  wrap("Jev confidence thresholds", null, "thresholds", true);
  if (jev) jev.classList.add("zao-jev-settings");

  const llm = wrap("2. New groups", "3. Sorting behavior", "llm");
  const behavior = wrap("3. Sorting behavior", "Skip Domains", "behavior");
  behavior?.appendChild(h("p", {
    class: "zao-pref-description",
    text: loc(
      "Die Space-Sortierung im Menü nutzt ausschließlich Jev. Ordner werden nur verschoben, wenn das Ziel-Space klar besser passt.",
      "Space-menu sorting uses Jev only. Groups move intact between existing Spaces only when the destination clearly scores above the current Space.",
    ),
  }));
  wrap("Skip Domains", "Group Rules", "skip");
  wrap("Group Rules", "Look & Feel", "rules", true);
  const appearance = wrap("Look & Feel", "Backup & Restore", "appearance");
  wrap("Backup & Restore", "Debug & Diagnostics", "backup", true);
  const diagnostics = wrap("Debug & Diagnostics", null, "diagnostics", true);

  // Q6: Group advanced / fine-tuning controls into collapsible drawers (closed by default)
  const fineTuningLabel = loc("Erweitert / Fine-Tuning", "Advanced / Fine-Tuning");
  createFineTuningDrawer(
    llm,
    fineTuningLabel,
    [
      CONFIG.AI_REASONING_EFFORT_PREF,
      CONFIG.AI_TIME_BUDGET_PREF,
      CONFIG.AI_LOCAL_BATCH_SIZE_PREF,
      CONFIG.AI_OLLAMA_WARMUP_PREF,
    ],
    "llm-tuning",
  );
  createFineTuningDrawer(
    behavior,
    fineTuningLabel,
    [
      CONFIG.AI_RESPECT_SPACE_CONTAINERS_PREF,
      CONFIG.AI_WORKSPACE_SORT_STRICTNESS_PREF,
    ],
    "behavior-tuning",
  );
  createFineTuningDrawer(
    appearance,
    loc("Erweitert / Folder-Engine & Animation", "Advanced / Folder Engine & Motion"),
    [
      CONFIG.ANIMATION_STYLE_PREF,
      CONFIG.FOLDER_ENGINE_ENABLED_PREF,
      CONFIG.FOLDER_TAB_COUNT_PREF,
      CONFIG.FOLDER_GROUP_SHORTCUT_PREF,
    ],
    "appearance-tuning",
  );

  // Per-section Reset-to-Default buttons (never touch secrets, OAuth, rules, or skip domains)
  attachSectionResetButton(jev, "jev", onResetSection);
  attachSectionResetButton(llm, "llm", onResetSection);
  attachSectionResetButton(behavior, "behavior", onResetSection);
  attachSectionResetButton(appearance, "appearance", onResetSection);
  if (diagnostics && typeof onResetSection === "function") {
    const diagBody = diagnostics.querySelector(".zao-details-content");
    if (diagBody && !diagBody.querySelector(".zao-section-reset-btn")) {
      const btn = h("button", { class: "zao-section-reset-btn", text: loc("Diagnose zurücksetzen", "Reset diagnostics") });
      btn.type = "button";
      btn.dataset.zaoResetSection = "diagnostics";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        onResetSection("diagnostics");
      });
      diagBody.appendChild(btn);
    }
  }

  const debug = dialog.querySelector(`#${CONFIG.DEBUG_MODE_PREF.replaceAll(".", "-")}`);
  debug?.classList.add("zao-pref-hidden");

  for (const row of content.querySelectorAll("hbox[id]")) {
    const label = row.querySelector(".sineItemPreferenceLabel")?.textContent;
    const control = row.querySelector("input, menulist, checkbox");
    if (label && control) control.setAttribute("aria-label", label.trim());
  }
  content.classList.add("zao-settings-layout");
};

export const maskProviderKeys = (dialog) => {
  const showLabel = loc("Anzeigen", "Show");
  const hideLabel = loc("Verbergen", "Hide");
  const showAria = loc("API-Key anzeigen", "Show API key");
  const hideAria = loc("API-Key verbergen", "Hide API key");

  for (const name of [
    CONFIG.AI_JEV_API_KEY_PREF,
    CONFIG.AI_PRIMALABS_API_KEY_PREF,
    CONFIG.AI_OPENAI_API_KEY_PREF,
    CONFIG.AI_GEMINI_API_KEY_PREF,
    CONFIG.AI_CUSTOM_API_KEY_PREF,
  ]) {
    const input = dialog.querySelector(`#${name.replaceAll(".", "-")} input`);
    if (!input || input.parentElement.classList.contains("zao-secret-control")) continue;
    const control = h("div", { class: "zao-secret-control" });
    input.before(control);
    control.append(input);
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    const button = h("button", { type: "button", text: showLabel, class: "zao-backup-btn" });
    button.setAttribute("aria-label", showAria);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? hideLabel : showLabel;
      button.setAttribute("aria-label", show ? hideAria : showAria);
      button.setAttribute("aria-pressed", String(show));
    });
    control.appendChild(button);
  }
};
