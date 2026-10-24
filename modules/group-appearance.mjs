import { CONFIG } from "./config.mjs";

export const DEFAULT_NEW_GROUP_COLOR_STRENGTH = 20;
export const normalizeGroupColorStrength = (value, fallback = DEFAULT_NEW_GROUP_COLOR_STRENGTH) => {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.max(0, Math.min(100, number))) : fallback;
};
export const readNewGroupColorStrength = (prefs = globalThis.Services?.prefs) => {
  try { return normalizeGroupColorStrength(prefs?.getStringPref(CONFIG.NEW_GROUP_COLOR_STRENGTH_PREF, "20")); }
  catch { return DEFAULT_NEW_GROUP_COLOR_STRENGTH; }
};
export const savedGroupColorStrength = (group) => {
  const value = group?.getAttribute?.("data-zao-color-strength");
  return value == null ? null : normalizeGroupColorStrength(value, null);
};

// Capture the preference only at creation. Existing groups are never traversed
// when it changes. Restoration applies this captured value, not today's pref.
export const applyGroupColorStrength = (group, value) => {
  const strength = normalizeGroupColorStrength(value, null);
  if (strength == null || !group?.setAttribute || !group.style?.setProperty) return false;
  group.setAttribute("data-zao-color-strength", String(strength));
  group.style.setProperty("--zao-group-color-strength", `${strength}%`);
  group.style.setProperty("--zao-group-hover-strength", `${Math.min(100, Math.round(strength * 1.3))}%`);
  // Zia owns the large ::before fill in the user's setup. Scope its override to
  // the marked group so an older nested group cannot inherit a changed wash.
  try {
    const win = group.ownerDocument.defaultView;
    group.toggleAttribute("data-zao-zia-strength", Boolean(win.getComputedStyle(group).getPropertyValue("--zia-folder-wash").trim()));
  } catch { /* Native groups also work without Zia. */ }
  return true;
};
export const captureNewGroupAppearance = (group) => applyGroupColorStrength(group, readNewGroupColorStrength());
