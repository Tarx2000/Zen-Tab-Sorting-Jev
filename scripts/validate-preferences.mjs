import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../modules/config.mjs";
import { PROVIDER_PRESETS } from "../modules/provider-registry.mjs";

const REQUIRED_SECTIONS = [
  "Group Rules",
  "Skip Domains",
  "Backup & Restore",
  "Look & Feel",
  "AI Sorting",
];

const REQUIRED_LLM_VALUES = [
  "off",
  ...PROVIDER_PRESETS.map((preset) => preset.id),
];

const REQUIRED_PROPERTIES = [
  "extensions.zen-auto-organize.new-group-color-strength",
  "extensions.zen-auto-organize.ai-jev-provider",
  "extensions.zen-auto-organize.ai-jev-model",
  "extensions.zen-auto-organize.ai-jev-api-key",
  "extensions.zen-auto-organize.ai-fallback-provider",
  "extensions.zen-auto-organize.ai-sort-mode",
  "extensions.zen-auto-organize.ai-provider-consent",
  "extensions.zen-auto-organize.ai-openai-api-key",
  "extensions.zen-auto-organize.ai-openai-model",
  "extensions.zen-auto-organize.ai-gemini-api-key",
  "extensions.zen-auto-organize.ai-gemini-model",
  "extensions.zen-auto-organize.ai-custom-api-key",
  "extensions.zen-auto-organize.ai-custom-model",
  "extensions.zen-auto-organize.ai-custom-endpoint",
  "extensions.zen-auto-organize.ai-custom-format",
  "extensions.zen-auto-organize.ai-respect-space-containers",
  "extensions.zen-auto-organize.ai-workspace-sort-strictness",
  "extensions.zen-tab-sorting.folder-engine-enabled",
  "extensions.zen-tab-sorting.folder-tab-count",
  "extensions.zen-tab-sorting.folder-group-shortcut",
  "extensions.zen-tab-sorting.animation-style",
];

const SECRET_PROPERTY_PATTERN = /(?:api-key|token|secret|password|session)/i;

const KNOWN_CONFIG_PREFS = new Set(
  Object.entries(CONFIG)
    .filter(([key, val]) => key.endsWith("_PREF") && typeof val === "string")
    .map(([, val]) => val),
);

const readPreferences = (rootDir, errors) => {
  try {
    const parsed = JSON.parse(readFileSync(resolve(rootDir, "preferences.json"), "utf8"));
    if (!Array.isArray(parsed)) {
      errors.push("preferences.json root must be an array");
      return [];
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`preferences.json is not valid JSON: ${message}`);
    return [];
  }
};

const propertySet = (preferences) =>
  new Set(preferences.flatMap((entry) => (typeof entry?.property === "string" ? [entry.property] : [])));

const findEntry = (preferences, property) =>
  preferences.find((entry) => entry && typeof entry === "object" && entry.property === property);

const optionValues = (entry) =>
  Array.isArray(entry?.options)
    ? entry.options.flatMap((option) => (typeof option?.value === "string" ? [option.value] : []))
    : [];

export const validatePreferences = (rootDir = process.cwd()) => {
  const errors = [];
  const preferences = readPreferences(rootDir, errors);
  const labels = preferences.flatMap((entry) => (typeof entry?.label === "string" ? [entry.label] : []));
  const properties = propertySet(preferences);

  for (const label of REQUIRED_SECTIONS) {
    if (!labels.includes(label)) errors.push(`missing section ${label}`);
  }

  for (const property of REQUIRED_PROPERTIES) {
    if (!properties.has(property)) errors.push(`missing preference ${property}`);
  }

  if (findEntry(preferences, "extensions.zen-auto-organize.ai-engine")) {
    errors.push("the hybrid pipeline is fixed; do not expose an AI engine selector");
  }

  const llm = findEntry(preferences, "extensions.zen-auto-organize.ai-fallback-provider");
  const llmValues = optionValues(llm);
  for (const value of REQUIRED_LLM_VALUES) {
    if (!llmValues.includes(value)) errors.push(`LLM provider missing option ${value}`);
  }
  if (llmValues.some((value) => ["none", "local"].includes(value))) {
    errors.push("LLM options must not include deprecated none/local values (use 'off' to disable Stage 2)");
  }

  for (const entry of preferences) {
    for (const option of entry.options || []) {
      if (/[&<>"]/.test(option.label || "")) {
        errors.push(`XML-unsafe dropdown label in ${entry.property}`);
      }
    }

    if (typeof entry?.property === "string") {
      // Cross-check every preferences.json property against modules/config.mjs *_PREF constants
      if (!KNOWN_CONFIG_PREFS.has(entry.property)) {
        errors.push(`preference ${entry.property} is not declared as a *_PREF constant in modules/config.mjs`);
      }

      // Validate secret fields: must be string type with an empty defaultValue
      if (SECRET_PROPERTY_PATTERN.test(entry.property)) {
        if (entry.type !== "string") {
          errors.push(`secret preference ${entry.property} must have type "string"`);
        }
        if (entry.defaultValue !== "") {
          errors.push(`secret preference ${entry.property} must have an empty defaultValue ""`);
        }
      }
    }
  }

  const sortMode = findEntry(preferences, "extensions.zen-auto-organize.ai-sort-mode");
  const sortModeValues = optionValues(sortMode);
  for (const value of ["rules-first", "full-ai"]) {
    if (!sortModeValues.includes(value)) errors.push(`AI sorting mode missing option ${value}`);
  }

  const duplicates = [...properties].filter((property) => {
    return preferences.filter((entry) => entry?.property === property).length > 1;
  });
  for (const property of duplicates) {
    errors.push(`duplicate preference ${property}`);
  }

  return { ok: errors.length === 0, errors };
};

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  const result = validatePreferences();
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exit(1);
  }
  console.log("validate-preferences: PASS sections/provider controls/secret fields/config cross-check");
}
