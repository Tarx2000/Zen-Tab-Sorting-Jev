import { CONFIG, h } from "./config.mjs";

const separator = (dialog, prefix) => [...dialog.querySelectorAll(".separator-label")]
  .find(label => label.textContent.trim().startsWith(prefix))?.closest("vbox");

export const organizeSettingsLayout = (dialog, content) => {
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
  // The threshold detail was wrapped inside the Jev card; keep the connection
  // test before it and the advanced controls collapsed by default.
  if (jev) jev.classList.add("zao-jev-settings");
  wrap("2. New groups", "3. Sorting behavior", "llm");
  const behavior = wrap("3. Sorting behavior", "Skip Domains", "behavior");
  behavior?.appendChild(h("p", { class: "zao-pref-description", text:
    "Space-menu sorting uses Jev only. Groups move intact between existing Spaces, only when the destination scores more than 10 percentage points above the current Space." }));
  wrap("Skip Domains", "Group Rules", "skip");
  wrap("Group Rules", "Look & Feel", "rules", true);
  wrap("Look & Feel", "Backup & Restore", "appearance");
  wrap("Backup & Restore", "Debug & Diagnostics", "backup", true);
  wrap("Debug & Diagnostics", null, "diagnostics", true);
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
  for (const name of [CONFIG.AI_JEV_API_KEY_PREF, CONFIG.AI_PRIMALABS_API_KEY_PREF,
    CONFIG.AI_OPENAI_API_KEY_PREF, CONFIG.AI_GEMINI_API_KEY_PREF, CONFIG.AI_CUSTOM_API_KEY_PREF]) {
    const input = dialog.querySelector(`#${name.replaceAll(".", "-")} input`);
    if (!input || input.parentElement.classList.contains("zao-secret-control")) continue;
    const control = h("div", { class: "zao-secret-control" });
    input.before(control);
    control.append(input);
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    const button = h("button", { type: "button", text: "Show", class: "zao-backup-btn" });
    button.setAttribute("aria-label", "Show API key");
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.textContent = show ? "Hide" : "Show";
      button.setAttribute("aria-label", show ? "Hide API key" : "Show API key");
      button.setAttribute("aria-pressed", String(show));
    });
    control.appendChild(button);
  }
};
