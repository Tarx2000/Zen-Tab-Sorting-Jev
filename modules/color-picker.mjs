// Zen Tab Sorting — color picker UI used inside the settings widget rows.
// Includes the swatch, the popover with Reset/Auto + 9 Zen presets + hex input,
// and a single-recalc batched runtime fetch of Zen's actual rendered palette.

import {
  CONFIG,
  LOG,
  HTML_NS,
  PRESET_COLORS,
  HEX_BY_NAME,
  h,
  bgForName,
  isZenColorName,
  isValidHex,
} from "./config.mjs";

// Zen's --tab-group-color-* CSS vars are defined in tabs.css which only loads in
// browser.xhtml, not in about:preferences. Batch all 9 probe nodes in a single
// DocumentFragment so computing the full palette costs 1 style recalc instead of 9.
export const fetchZenColorsFromBrowser = () => {
  try {
    const browserWin = Services.wm.getMostRecentWindow("navigator:browser");
    if (!browserWin?.document?.documentElement) return;
    const browserDoc = browserWin.document;
    const createDiv = () =>
      typeof browserDoc.createElementNS === "function"
        ? browserDoc.createElementNS(HTML_NS, "div")
        : browserDoc.createElement("div");

    const fragment = browserDoc.createDocumentFragment();
    const probes = [];
    for (const { name } of PRESET_COLORS) {
      const probe = createDiv();
      probe.style.cssText = `background: light-dark(var(--tab-group-color-${name}), var(--tab-group-color-${name}-invert)); display: none;`;
      fragment.appendChild(probe);
      probes.push({ name, probe });
    }

    browserDoc.documentElement.appendChild(fragment);
    try {
      for (const { name, probe } of probes) {
        const computed = browserWin.getComputedStyle(probe).backgroundColor;
        // Filter sentinel values getComputedStyle returns when a var() doesn't resolve.
        if (computed && computed !== "rgb(0, 0, 0)" && computed !== "rgba(0, 0, 0, 0)") {
          HEX_BY_NAME.set(name, computed);
        }
      }
    } finally {
      for (const { probe } of probes) probe.remove();
    }
    console.log(`${LOG} fetched Zen tab-group palette (theme-rendered) from browser window`);
  } catch (e) {
    console.warn(`${LOG} fetchZenColorsFromBrowser failed:`, e);
  }
};

export const updateSwatchAppearance = (swatch, color) => {
  if (color && isZenColorName(color)) {
    swatch.style.background = bgForName(color);
    swatch.classList.remove("zao-swatch-empty");
    swatch.title = `Color: ${color}`;
    swatch.setAttribute("aria-label", `Group color: ${color}`);
  } else if (color && isValidHex(color)) {
    swatch.style.background = color;
    swatch.classList.remove("zao-swatch-empty");
    swatch.title = `Color: ${color}`;
    swatch.setAttribute("aria-label", `Group color: ${color}`);
  } else {
    swatch.style.background = "";
    swatch.classList.add("zao-swatch-empty");
    swatch.title = "Auto color — click to pick";
    swatch.setAttribute("aria-label", "Group color: auto");
  }
};

// Open the color popover anchored above (or below) the given swatch element.
// `onChange` is called whenever the rule's color is mutated (so the caller can persist).
export const openColorPopover = (rule, swatch, onChange) => {
  document.querySelectorAll(".zao-color-popover").forEach((p) => {
    if (typeof p._zaoClose === "function") p._zaoClose();
    else p.remove();
  });

  const pop = h("div", { class: "zao-color-popover" });
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Choose group color");

  const presets = h("div", { class: "zao-presets" });
  let hexInput;

  const syncPresetStates = (activeValue) => {
    presets.querySelectorAll(".zao-preset").forEach((btn) => {
      const active = (btn.dataset.zaoColor || "") === (activeValue || "");
      btn.classList.toggle("zao-preset-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  };

  const clearHexInvalid = () => {
    if (!hexInput) return;
    hexInput.classList.remove("zao-color-hex-invalid");
    hexInput.removeAttribute("aria-invalid");
  };

  // Reset / Auto swatch button
  const resetDot = h("button", { class: "zao-preset zao-preset-reset" });
  resetDot.type = "button";
  resetDot.dataset.zaoColor = "";
  resetDot.title = "Auto / reset color";
  resetDot.setAttribute("aria-label", "Auto / reset color");
  resetDot.setAttribute("aria-pressed", !rule.color ? "true" : "false");
  if (!rule.color) resetDot.classList.add("zao-preset-active");
  resetDot.addEventListener("click", (e) => {
    e.stopPropagation();
    delete rule.color;
    onChange();
    updateSwatchAppearance(swatch, null);
    syncPresetStates("");
    if (hexInput) {
      hexInput.value = "";
      clearHexInvalid();
    }
  });
  presets.appendChild(resetDot);

  for (const { name } of PRESET_COLORS) {
    const dot = h("button", { class: "zao-preset" });
    dot.type = "button";
    dot.dataset.zaoColor = name;
    dot.style.background = bgForName(name);
    const isActive = rule.color === name;
    if (isActive) dot.classList.add("zao-preset-active");
    dot.title = name;
    dot.setAttribute("aria-label", `Color: ${name}`);
    dot.setAttribute("aria-pressed", isActive ? "true" : "false");
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      rule.color = name;
      onChange();
      updateSwatchAppearance(swatch, name);
      syncPresetStates(name);
      if (hexInput) {
        hexInput.value = "";
        clearHexInvalid();
      }
    });
    presets.appendChild(dot);
  }
  pop.appendChild(presets);

  hexInput = h("input", { class: "zao-color-hex" });
  hexInput.type = "text";
  hexInput.placeholder = "#hex";
  hexInput.setAttribute("aria-label", "Custom hex color");
  hexInput.value = rule.color && isValidHex(rule.color) ? rule.color : "";
  hexInput.spellcheck = false;
  hexInput.addEventListener("input", () => {
    const v = hexInput.value.trim();
    if (v === "") {
      clearHexInvalid();
      delete rule.color;
      onChange();
      updateSwatchAppearance(swatch, null);
      syncPresetStates("");
    } else if (isValidHex(v)) {
      clearHexInvalid();
      rule.color = v;
      onChange();
      updateSwatchAppearance(swatch, v);
      syncPresetStates(null);
    } else {
      hexInput.classList.add("zao-color-hex-invalid");
      hexInput.setAttribute("aria-invalid", "true");
    }
  });
  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  hexInput.addEventListener("click", (e) => e.stopPropagation());
  pop.appendChild(hexInput);

  // Append INSIDE the dialog (not document.body) so the popover shares the
  // top-layer that .showModal() creates.
  const dialog = swatch.closest(".sineItemPreferenceDialog") || document.body;
  dialog.appendChild(pop);

  let closed = false;
  let attachTimer = null;

  const positionPopover = () => {
    if (closed || !pop.isConnected || !swatch.isConnected) {
      close();
      return;
    }
    const r = swatch.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const gap = CONFIG.POPOVER_GAP_PX;

    // If the swatch scrolled out of the visible viewport, dismiss cleanly.
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
      close();
      return;
    }

    const maxLeft = Math.max(gap, window.innerWidth - popRect.width - gap);
    const clampedLeft = Math.min(Math.max(gap, r.left), maxLeft);
    pop.style.left = `${clampedLeft}px`;

    const aboveTop = r.top - popRect.height - gap;
    const belowTop = r.bottom + gap;
    const maxTop = Math.max(gap, window.innerHeight - popRect.height - gap);
    pop.style.top = `${aboveTop >= gap ? aboveTop : Math.min(belowTop, maxTop)}px`;
  };

  const closeIfOutside = (e) => {
    if (!pop.contains(e.target) && e.target !== swatch) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      swatch.focus?.();
    }
  };
  const onScrollOrResize = () => positionPopover();

  const cleanup = () => {
    if (attachTimer != null) {
      clearTimeout(attachTimer);
      attachTimer = null;
    }
    document.removeEventListener("mousedown", closeIfOutside, true);
    document.removeEventListener("keydown", onKey, true);
    dialog.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    cleanup();
    pop.remove();
  };
  pop._zaoClose = close;

  positionPopover();

  dialog.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
  window.addEventListener("resize", onScrollOrResize, { passive: true });
  attachTimer = setTimeout(() => {
    attachTimer = null;
    if (closed) return;
    document.addEventListener("mousedown", closeIfOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
};
