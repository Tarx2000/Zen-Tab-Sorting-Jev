import { CONFIG } from "./config.mjs";

export const DEFAULT_NEW_GROUP_COLOR_STRENGTH = 20;

// Cache Zia detection (--zia-folder-wash) once per browser window to eliminate
// per-group forced style recalculations during creation and session restore.
const ziaWashByWindow = new WeakMap();

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

export const resetZiaDetectionCache = (win) => {
  if (win) ziaWashByWindow.delete(win);
};

const detectZiaFolderWash = (group) => {
  try {
    const win = group?.ownerDocument?.defaultView;
    if (!win) return false;
    if (ziaWashByWindow.has(win)) return ziaWashByWindow.get(win);
    // Measure BEFORE inline style writes so we never trigger a read-after-write recalc.
    const hasZia = Boolean(win.getComputedStyle(group).getPropertyValue("--zia-folder-wash").trim());
    ziaWashByWindow.set(win, hasZia);
    return hasZia;
  } catch {
    return false;
  }
};

/**
 * Publish live default strength CSS custom properties on `:root` so preference
 * updates propagate cleanly to default-strength groups without overriding Zia's
 * `--zia-folder-wash` or mutating explicitly captured groups.
 */
export const publishDefaultGroupColorStrength = (value = readNewGroupColorStrength(), win = globalThis.window) => {
  const strength = normalizeGroupColorStrength(value, null);
  const rootStyle = win?.document?.documentElement?.style;
  if (strength == null || typeof rootStyle?.setProperty !== "function") return false;
  rootStyle.setProperty("--zao-default-group-strength", `${strength}%`);
  rootStyle.setProperty("--zao-default-group-hover-strength", `${Math.min(100, Math.round(strength * 1.3))}%`);
  return true;
};

// Capture the preference only at creation. Existing groups are never traversed
// when it changes. Restoration applies this captured value, not today's pref.
export const applyGroupColorStrength = (group, value) => {
  const strength = normalizeGroupColorStrength(value, null);
  if (strength == null || !group?.setAttribute || !group.style?.setProperty) return false;

  // Detect Zia once per window BEFORE mutating inline styles on `group`.
  const hasZia = detectZiaFolderWash(group);

  group.setAttribute("data-zao-color-strength", String(strength));
  group.style.setProperty("--zao-group-color-strength", `${strength}%`);
  group.style.setProperty("--zao-group-hover-strength", `${Math.min(100, Math.round(strength * 1.3))}%`);
  // Zia owns the large ::before fill in the user's setup. Scope its override to
  // the marked group so an older nested group cannot inherit a changed wash.
  try {
    group.toggleAttribute?.("data-zao-zia-strength", hasZia);
  } catch { /* Native groups also work without Zia. */ }
  return true;
};

export const captureNewGroupAppearance = (group) => {
  const strength = readNewGroupColorStrength();
  const win = group?.ownerDocument?.defaultView;
  if (win) publishDefaultGroupColorStrength(strength, win);
  return applyGroupColorStrength(group, strength);
};
