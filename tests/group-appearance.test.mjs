import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../modules/config.mjs";
import { normalizeGroupColorStrength, captureNewGroupAppearance, savedGroupColorStrength, applyGroupColorStrength } from "../modules/group-appearance.mjs";

const group = () => {
  const attributes = new Map();
  const styles = new Map();
  return { attributes, styles, setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: key => attributes.has(key) ? attributes.get(key) : null,
    style: { setProperty: (key, value) => styles.set(key, value) } };
};
test("Color intensity captures a creation-time value and never edits older groups when the preference changes", () => {
  let value = "18";
  const oldServices = globalThis.Services;
  globalThis.Services = { prefs: { getStringPref: name => { assert.equal(name, CONFIG.NEW_GROUP_COLOR_STRENGTH_PREF); return value; } } };
  try {
    const existing = group();
    const first = group();
    captureNewGroupAppearance(first);
    value = "65";
    const second = group();
    captureNewGroupAppearance(second);
    assert.equal(savedGroupColorStrength(existing), null);
    assert.equal(savedGroupColorStrength(first), 18);
    assert.equal(savedGroupColorStrength(second), 65);
    assert.equal(first.styles.get("--zao-group-color-strength"), "18%");
    assert.equal(first.styles.has("opacity"), false);
    assert.equal(first.styles.has("--tab-group-color"), false);
  } finally { if (oldServices) globalThis.Services = oldServices; else delete globalThis.Services; }
});
test("Restoring saved intensity uses its saved value and corrupt/missing metadata leaves a group alone", () => {
  const restored = group();
  assert.equal(applyGroupColorStrength(restored, 35), true);
  assert.equal(savedGroupColorStrength(restored), 35);
  const untouched = group();
  for (const value of [null, undefined, "bad", {}]) assert.equal(applyGroupColorStrength(untouched, value), false);
  assert.equal(untouched.attributes.size, 0);
});
test("Intensity input is bounded and finite", () => {
  assert.equal(normalizeGroupColorStrength(""), 20);
  assert.equal(normalizeGroupColorStrength("12.6"), 13);
  assert.equal(normalizeGroupColorStrength(-10), 0);
  assert.equal(normalizeGroupColorStrength(200), 100);
  assert.equal(normalizeGroupColorStrength(Infinity), 20);
});
