import { LOG } from "./config.mjs";
import { buildMergePrompt } from "./ollama-prompts.mjs";

const TRAILING_GENERICS = new Set([
  "category", "categories", "label", "labels", "topic", "topics",
  "bucket", "buckets", "group", "groups", "management", "tools",
  "resources", "resource", "sites", "site", "pages", "page",
  "products", "product", "stuff", "things",
]);

const ASCII_WORD_RE = /^[a-z]+$/i;
const MIN_STEM_LEN = 4;

const applySuffixRule = (word, regex, replacement = "") => {
  const candidate = word.replace(regex, replacement);
  return candidate.length >= MIN_STEM_LEN ? candidate : word;
};

const lightStem = (word) => {
  if (!ASCII_WORD_RE.test(word) || word.length <= MIN_STEM_LEN) return word;
  let stemmed = word;
  stemmed = applySuffixRule(stemmed, /(ability|ibility)$/i, "");
  stemmed = applySuffixRule(stemmed, /(able|ible)$/i, "");
  stemmed = applySuffixRule(stemmed, /(ation|ization)$/i, "");
  stemmed = applySuffixRule(stemmed, /(ing)$/i, "");
  stemmed = applySuffixRule(stemmed, /(ies)$/i, "y");
  stemmed = applySuffixRule(stemmed, /(s)$/i, "");
  return stemmed;
};

export const normalizeNameForDedupe = (name) => {
  const words = String(name || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (words.length > 1 && TRAILING_GENERICS.has(words[words.length - 1])) {
    words.pop();
  }
  return words.map(lightStem).join(" ");
};

const dedupeSimilarNewGroups = (newGroups) => {
  if (!Array.isArray(newGroups) || newGroups.length === 0) return [];
  const byNorm = new Map();
  const out = [];
  for (const group of newGroups) {
    const clonedTabs = Array.isArray(group.tabs) ? [...group.tabs] : [];
    const norm = normalizeNameForDedupe(group.name);
    if (!norm) {
      // Never collapse unrelated symbol/emoji-only names into an empty key.
      out.push({ ...group, tabs: clonedTabs });
      continue;
    }
    if (byNorm.has(norm)) {
      out[byNorm.get(norm)].tabs.push(...clonedTabs);
      continue;
    }
    byNorm.set(norm, out.length);
    out.push({ ...group, tabs: clonedTabs });
  }
  return out;
};

const applyMergePlan = (newGroups, parsed) => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return newGroups.map((group) => ({ ...group, tabs: Array.isArray(group.tabs) ? [...group.tabs] : [] }));
  }

  // Aggregate by lowercase key as Map<string, Group[]> so casing collisions never drop a group.
  const origByLower = new Map();
  for (const group of newGroups) {
    const key = String(group.name || "").trim().toLowerCase();
    if (!origByLower.has(key)) origByLower.set(key, []);
    origByLower.get(key).push(group);
  }

  const consumed = new Set();
  const byTarget = new Map();

  for (const [origName, targetRaw] of Object.entries(parsed)) {
    const origKey = String(origName || "").trim().toLowerCase();
    const targetName = String(targetRaw || "").trim();
    if (!origKey || !targetName || consumed.has(origKey)) continue;
    const sources = origByLower.get(origKey);
    if (!sources || sources.length === 0) continue;
    consumed.add(origKey);

    const targetKey = targetName.toLowerCase();
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, { name: targetName, tabs: [] });
    const bucket = byTarget.get(targetKey);
    for (const source of sources) {
      if (Array.isArray(source.tabs)) bucket.tabs.push(...source.tabs);
    }
  }

  const merged = [...byTarget.values()];
  for (const group of newGroups) {
    const key = String(group.name || "").trim().toLowerCase();
    if (!consumed.has(key)) {
      merged.push({ ...group, tabs: Array.isArray(group.tabs) ? [...group.tabs] : [] });
    }
  }
  return merged;
};

const reconcileWithExistingNames = (groups, existingGroupNames) => {
  if (!existingGroupNames) return groups;
  const names = [...existingGroupNames].map((n) => String(n || "").trim()).filter(Boolean);
  if (names.length === 0) return groups;

  const exactLower = new Map();
  const byNorm = new Map();
  for (const existingName of names) {
    const lower = existingName.toLowerCase();
    if (!exactLower.has(lower)) exactLower.set(lower, existingName);
    const norm = normalizeNameForDedupe(existingName);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, existingName);
  }

  const byCanonical = new Map();
  const out = [];
  for (const group of groups) {
    const trimmed = String(group.name || "").trim();
    const norm = normalizeNameForDedupe(trimmed);
    const matched = exactLower.get(trimmed.toLowerCase()) || (norm ? byNorm.get(norm) : null);
    const finalName = matched || group.name;
    const key = String(finalName || "").trim().toLowerCase();
    const clonedTabs = Array.isArray(group.tabs) ? [...group.tabs] : [];
    if (key && byCanonical.has(key)) {
      out[byCanonical.get(key)].tabs.push(...clonedTabs);
    } else {
      if (key) byCanonical.set(key, out.length);
      out.push({ ...group, name: finalName, tabs: clonedTabs });
    }
  }
  return out;
};

export const consolidateNewGroups = async (
  newGroups,
  fetchMergePlan,
  label = "Provider",
  { existingGroupNames } = {},
) => {
  let merged = (newGroups || []).map((group) => ({
    ...group,
    tabs: Array.isArray(group.tabs) ? [...group.tabs] : [],
  }));
  if (merged.length >= 2 && typeof fetchMergePlan === "function") {
    try {
      merged = applyMergePlan(merged, await fetchMergePlan(buildMergePrompt(merged)));
    } catch (e) {
      console.warn(`${LOG} ${label} merge-pass errored; keeping un-merged groups:`, e);
    }
  }
  merged = dedupeSimilarNewGroups(merged);
  return reconcileWithExistingNames(merged, existingGroupNames);
};
