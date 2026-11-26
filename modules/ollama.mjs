// Zen Tab Sorting — Ollama engine orchestrators.
//
// Talks to a local/remote Ollama daemon via `ollama-transport.mjs` (backed by
// the unified `ollama-native` protocol adapter) to perform AI-driven Pass 2
// sorting. All transport, formatting, `keep_alive`, `format: "json"`, and
// thinking-tag stripping live in `ollama-transport.mjs` / `provider-adapters.mjs`.

import { LOG } from "./config.mjs";
import { getOllamaHost, getOllamaModel } from "./rules.mjs";
import { fetchPageSnippets } from "./tabs.mjs";
import { showToast } from "./ui-toast.mjs";
import { chunkTabsByBudget, PROVIDER_TAB_BATCH_SIZE } from "./provider-batching.mjs";
import { ollamaGenerateJson } from "./ollama-transport.mjs";
import {
  buildClassifyPrompt,
  buildClusterPrompt,
  buildUnifiedPrompt,
  buildFreshPrompt,
  buildMergePrompt,
} from "./ollama-prompts.mjs";

// Re-export the transport surface that callers outside this module need.
export {
  normalizeOllamaHost,
  checkOllamaReady,
  warmupOllama,
  reportOllamaError,
  pullOllamaModel,
} from "./ollama-transport.mjs";

const stripMetaPrefix = (s) => s
  .replace(/^\s*(?:new\s+)?(?:category|label|topic|bucket|group)\s*[:\-–]\s*/i, "")
  .trim();

const isStrictNonNegIntKey = (key) => /^\d+$/.test(String(key));

// Support both flat map `{ "0": "Dev" }` and structured `{ assignments: [{ id: 0, group: "Dev" }] }`
const extractIndexedEntries = (parsed) => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Array.isArray(parsed.assignments)) {
    const pairs = [];
    for (const item of parsed.assignments) {
      if (item && Number.isInteger(item.id) && typeof item.group === "string") {
        pairs.push([String(item.id), item.group]);
      }
    }
    return pairs;
  }
  return Object.entries(parsed);
};

// ─── Classify into existing rules ────────────────────────────────────────────

export const classifyExistingGroupsBatch = async (unmatched, rules, host, model, options = {}) => {
  if (!unmatched?.length || !rules?.length) return new Map();
  const groupNames = rules.map((r) => r?.name).filter(Boolean);
  const nameByLower = new Map(groupNames.map((n) => [n.toLowerCase(), n]));
  const rejections = [];
  const out = new Map();

  for (const chunk of chunkTabsByBudget(unmatched, { maxTabs: PROVIDER_TAB_BATCH_SIZE })) {
    const r = await ollamaGenerateJson(host, model, buildClassifyPrompt(rules, chunk.tabs), options);
    if (!r.ok) {
      throw new Error(`Ollama classify: ${r.error}`);
    }
    const entries = extractIndexedEntries(r.parsed);
    if (!entries) {
      throw new Error("Ollama classify: returned non-object JSON");
    }

    console.debug(`${LOG} Ollama raw classification:`, r.parsed);

    for (const [key, value] of entries) {
      if (!isStrictNonNegIntKey(key)) continue;
      const chunkIdx = Number.parseInt(key, 10);
      if (chunkIdx < 0 || chunkIdx >= chunk.tabs.length) continue;
      const originalIdx = chunk.start + chunkIdx;
      const v = String(value || "").trim();
      if (!v || v.toLowerCase() === "none") { out.set(originalIdx, null); continue; }
      const canonical = nameByLower.get(v.toLowerCase());
      if (canonical) {
        out.set(originalIdx, canonical);
      } else {
        rejections.push(`${unmatched[originalIdx]?.hostname || `tab${originalIdx}`} → "${v}"`);
        out.set(originalIdx, null);
      }
    }
  }
  if (rejections.length > 0) {
    console.warn(`${LOG} Ollama returned ${rejections.length} category name(s) not in rules — treated as no match: ${rejections.join(", ")}`);
  }
  for (let i = 0; i < unmatched.length; i++) if (!out.has(i)) out.set(i, null);
  return out;
};

// ─── Cluster leftover tabs into new groups ───────────────────────────────────

const clusterUnmatchedNewGroups = async (leftover, host, model, options = {}) => {
  if (!leftover?.length) return { groups: [], skipped: [] };
  const seen = new Set();
  const groupsByLower = new Map();

  for (const chunk of chunkTabsByBudget(leftover, { maxTabs: PROVIDER_TAB_BATCH_SIZE })) {
    const r = await ollamaGenerateJson(host, model, buildClusterPrompt(chunk.tabs), options);
    if (!r.ok) throw new Error(`Ollama cluster: ${r.error}`);

    console.debug(`${LOG} Ollama raw clustering:`, r.parsed);

    const validIdx = (i) => Number.isInteger(i) && i >= 0 && i < chunk.tabs.length;
    for (const g of Array.isArray(r.parsed?.groups) ? r.parsed.groups : []) {
      const name = String(g?.name || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!groupsByLower.has(key)) groupsByLower.set(key, { name, tabs: [] });

      const indices = Array.isArray(g?.tabs) ? g.tabs.filter(validIdx) : [];
      for (const chunkIdx of indices) {
        const originalIdx = chunk.start + chunkIdx;
        if (seen.has(originalIdx)) continue;
        seen.add(originalIdx);
        groupsByLower.get(key).tabs.push(leftover[originalIdx]);
      }
    }
  }

  return {
    groups: [...groupsByLower.values()].filter((group) => group.tabs.length > 0),
    skipped: leftover.filter((_, idx) => !seen.has(idx)),
  };
};

// ─── Shared tab deduplication & 3rd-pass name dedupe ─────────────────────────

const dedupeTabs = (tabs) => {
  const dedupIndexByKey = new Map();
  const deduped = [];
  const origToDeduped = tabs.map((t) => {
    const k = `${t.hostname || ""}\x00${t.title || ""}`;
    if (dedupIndexByKey.has(k)) return dedupIndexByKey.get(k);
    const i = deduped.length;
    dedupIndexByKey.set(k, i);
    deduped.push(t);
    return i;
  });
  return { deduped, origToDeduped };
};

const TRAILING_GENERICS = new Set([
  "tools", "tool", "apps", "app", "platforms", "platform",
  "services", "service", "sites", "site", "websites", "website",
  "products", "product", "stuff", "things",
]);

const lightStem = (word) => {
  if (!/^[a-z]+$/i.test(word) || word.length < 5) return word;
  return word
    .replace(/(ability|ibility)$/i, "")
    .replace(/(able|ible)$/i, "")
    .replace(/(ation|ization)$/i, "")
    .replace(/(ing)$/i, "")
    .replace(/(ies)$/i, "y")
    .replace(/(s)$/i, "");
};

const normalizeNameForDedupe = (name) => {
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
  if (!newGroups || newGroups.length < 2) return newGroups || [];
  const byNorm = new Map();
  const out = [];
  let mergedCount = 0;
  for (const g of newGroups) {
    const norm = normalizeNameForDedupe(g.name);
    if (!norm) {
      out.push({ ...g, tabs: [...g.tabs] });
      continue;
    }
    if (byNorm.has(norm)) {
      const existing = out[byNorm.get(norm)];
      console.log(`${LOG} Ollama 3rd-pass dedupe: "${g.name}" → "${existing.name}" (normalized match: "${norm}")`);
      existing.tabs.push(...g.tabs);
      mergedCount++;
    } else {
      byNorm.set(norm, out.length);
      out.push({ ...g, tabs: [...g.tabs] });
    }
  }
  if (mergedCount > 0) {
    console.log(`${LOG} Ollama 3rd-pass dedupe: collapsed ${mergedCount} similar-named cluster(s) (${newGroups.length} → ${out.length})`);
  }
  return out;
};

// ─── Merge pass ──────────────────────────────────────────────────────────────

const mergeNewCategoriesPass = async (newGroups, host, model, options = {}) => {
  if (!newGroups || newGroups.length < 2) return newGroups;
  const t0 = performance.now();

  const r = await ollamaGenerateJson(host, model, buildMergePrompt(newGroups), options);
  if (!r.ok) {
    console.warn(`${LOG} Ollama merge-pass failed (${r.errorType}: ${r.error}), keeping original groups`);
    return newGroups;
  }
  const parsed = r.parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`${LOG} Ollama merge-pass returned non-object, keeping original groups`);
    return newGroups;
  }

  console.log(`${LOG} Ollama merge-pass took ${Math.round(performance.now() - t0)}ms`);

  const origByLower = new Map();
  for (const g of newGroups) {
    const key = g.name.toLowerCase();
    if (!origByLower.has(key)) origByLower.set(key, []);
    origByLower.get(key).push(g);
  }
  const consumed = new Set();
  const byTarget = new Map();

  for (const [origName, targetRaw] of Object.entries(parsed)) {
    const origKey = String(origName || "").trim().toLowerCase();
    const targetName = String(targetRaw || "").trim();
    if (!origKey || !targetName || consumed.has(origKey)) continue;
    const sources = origByLower.get(origKey);
    if (!sources?.length) continue;
    consumed.add(origKey);

    const targetKey = targetName.toLowerCase();
    if (!byTarget.has(targetKey)) {
      byTarget.set(targetKey, { name: targetName, tabs: [] });
    }
    for (const src of sources) byTarget.get(targetKey).tabs.push(...src.tabs);
  }

  const merged = [...byTarget.values()];
  for (const g of newGroups) {
    if (!consumed.has(g.name.toLowerCase())) {
      merged.push({ ...g, tabs: [...g.tabs] });
    }
  }
  return merged;
};

// ─── Unified classification ──────────────────────────────────────────────────

export const unifiedClassifyOllama = async (unmatched, rules, host, model, options = {}) => {
  if (!unmatched?.length) return { assignedToExisting: [], newGroups: [], skipped: [] };

  if (!rules.some((r) => r?.name)) {
    const c = await clusterUnmatchedNewGroups(unmatched, host, model, options);
    return { assignedToExisting: [], newGroups: c.groups, skipped: c.skipped };
  }

  const { deduped, origToDeduped } = dedupeTabs(unmatched);
  if (deduped.length < unmatched.length) {
    console.log(`${LOG} Ollama: deduplicated ${unmatched.length} tabs → ${deduped.length} unique`);
  }

  const t0 = performance.now();
  const snippets = await fetchPageSnippets(deduped, options.signal ? { signal: options.signal } : undefined);
  const hit = snippets.filter((s) => s).length;
  console.log(`${LOG} Ollama: fetched page snippets for ${hit}/${deduped.length} tab(s) in ${Math.round(performance.now() - t0)}ms`);

  const parsedByDedupedIndex = new Map();
  for (const chunk of chunkTabsByBudget(deduped, { maxTabs: PROVIDER_TAB_BATCH_SIZE, snippets })) {
    const r = await ollamaGenerateJson(
      host,
      model,
      buildUnifiedPrompt(rules, chunk.tabs, chunk.snippets),
      options,
    );
    if (!r.ok) throw new Error(`Ollama unified: ${r.error}`);
    const entries = extractIndexedEntries(r.parsed);
    if (!entries) {
      throw new Error("Ollama unified: returned non-object JSON");
    }

    for (const [key, value] of entries) {
      if (!isStrictNonNegIntKey(key)) continue;
      const chunkIdx = Number.parseInt(key, 10);
      if (chunkIdx < 0 || chunkIdx >= chunk.tabs.length) continue;
      parsedByDedupedIndex.set(chunk.start + chunkIdx, value);
    }
  }

  const ruleNameByLower = new Map(
    rules.filter((r) => r?.name).map((r) => [r.name.toLowerCase(), r.name]),
  );

  const assignedToExisting = [];
  const newGroupsByKey = new Map();
  const skipped = [];

  for (let i = 0; i < unmatched.length; i++) {
    const value = parsedByDedupedIndex.get(origToDeduped[i]);
    const raw = stripMetaPrefix(value == null ? "" : String(value).trim());
    const lower = raw.toLowerCase();

    if (!raw || lower === "skipped" || lower === "none") {
      skipped.push(unmatched[i]);
      continue;
    }

    const canonicalExisting = ruleNameByLower.get(lower);
    if (canonicalExisting) {
      assignedToExisting.push({ tabInfo: unmatched[i], groupName: canonicalExisting, similarity: 1.0 });
      continue;
    }

    if (!newGroupsByKey.has(lower)) {
      newGroupsByKey.set(lower, { name: raw, tabs: [] });
    }
    newGroupsByKey.get(lower).tabs.push(unmatched[i]);
  }

  let newGroups = [...newGroupsByKey.values()];
  if (newGroups.length >= 2) {
    try {
      newGroups = await mergeNewCategoriesPass(newGroups, host, model, options);
    } catch (e) {
      console.warn(`${LOG} Ollama merge-pass errored — keeping un-merged groups:`, e);
    }
  }
  newGroups = dedupeSimilarNewGroups(newGroups);

  return { assignedToExisting, newGroups, skipped };
};

// ─── Pass 2 drivers (public API for click-handler) ───────────────────────────

export const runPass2Ollama = async (unmatched, rules, options = {}) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!unmatched?.length) return empty;

  const host = options.host || getOllamaHost();
  const model = options.model || getOllamaModel();
  try {
    return await unifiedClassifyOllama(unmatched, rules, host, model, options);
  } catch (e) {
    console.error(`${LOG} Ollama unified classification failed:`, e);
    showToast(`Ollama classification failed: ${e.message || e}`);
    return { ...empty, skipped: unmatched, failed: e.message || String(e) };
  }
};

export const runPass2OllamaFresh = async (allTabs, options = {}) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!allTabs?.length) return empty;

  const host = options.host || getOllamaHost();
  const model = options.model || getOllamaModel();

  try {
    const { deduped, origToDeduped } = dedupeTabs(allTabs);
    if (deduped.length < allTabs.length) {
      console.log(`${LOG} Ollama fresh: deduplicated ${allTabs.length} tabs → ${deduped.length} unique`);
    }

    const t0 = performance.now();
    const snippets = await fetchPageSnippets(deduped, options.signal ? { signal: options.signal } : undefined);
    const hit = snippets.filter((s) => s).length;
    console.log(`${LOG} Ollama fresh: fetched snippets for ${hit}/${deduped.length} tab(s) in ${Math.round(performance.now() - t0)}ms`);

    const parsedByDedupedIndex = new Map();
    for (const chunk of chunkTabsByBudget(deduped, { maxTabs: PROVIDER_TAB_BATCH_SIZE, snippets })) {
      const r = await ollamaGenerateJson(host, model, buildFreshPrompt(chunk.tabs, chunk.snippets), options);
      if (!r.ok) {
        console.error(`${LOG} Ollama fresh failed (${r.errorType}):`, r.error);
        showToast(`Ollama fresh classification failed: ${r.error}`);
        return { ...empty, skipped: allTabs, failed: r.error };
      }
      const entries = extractIndexedEntries(r.parsed);
      if (!entries) {
        console.warn(`${LOG} Ollama fresh: non-object JSON, returning all as skipped`);
        return { ...empty, skipped: allTabs };
      }

      for (const [key, value] of entries) {
        if (!isStrictNonNegIntKey(key)) continue;
        const chunkIdx = Number.parseInt(key, 10);
        if (chunkIdx < 0 || chunkIdx >= chunk.tabs.length) continue;
        parsedByDedupedIndex.set(chunk.start + chunkIdx, value);
      }
    }

    const newGroupsByKey = new Map();
    const skipped = [];
    for (let i = 0; i < allTabs.length; i++) {
      const value = parsedByDedupedIndex.get(origToDeduped[i]);
      const raw = stripMetaPrefix(value == null ? "" : String(value).trim());
      const lower = raw.toLowerCase();
      if (!raw || lower === "skipped" || lower === "none") {
        skipped.push(allTabs[i]);
        continue;
      }
      if (!newGroupsByKey.has(lower)) {
        newGroupsByKey.set(lower, { name: raw, tabs: [] });
      }
      newGroupsByKey.get(lower).tabs.push(allTabs[i]);
    }

    let newGroups = [...newGroupsByKey.values()];
    if (newGroups.length >= 2) {
      try {
        newGroups = await mergeNewCategoriesPass(newGroups, host, model, options);
      } catch (e) {
        console.warn(`${LOG} Ollama merge-pass errored — keeping un-merged groups:`, e);
      }
    }
    newGroups = dedupeSimilarNewGroups(newGroups);
    return { assignedToExisting: [], newGroups, skipped };
  } catch (e) {
    console.error(`${LOG} Ollama fresh classification failed:`, e);
    showToast(`Ollama fresh classification failed: ${e.message || e}`);
    return { ...empty, skipped: allTabs, failed: e.message || String(e) };
  }
};
