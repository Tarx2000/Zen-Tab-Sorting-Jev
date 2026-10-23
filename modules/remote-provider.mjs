// Zen Tab Sorting — remote provider & JEV + Fallback-LLM Pass 2 drivers.
//
// Supports:
//   1. JEV + One-Shot Fallback-LLM hybrid pipeline (`runPass2JevHybrid`):
//      - Stage 1: TypeSafe JEV decision model classifies ungrouped tabs into
//        existing workspace `<tab-group>` folders using probability + margin thresholds.
//      - Stage 2: All remaining ungrouped tabs are sent in a single One-Shot call
//        to the configured Fallback-LLM (ChatGPT SIWC, PrimaLabs, OpenAI-compatible,
//        Gemini, Ollama, or Custom) to create new groups (min 2 tabs per new group)
//        and leave true outliers ungrouped (`skipped`).
//   2. Standalone remote providers (`openai`, `primalabs`, `chatgpt`, `gemini`, `custom`).

import { LOG } from "./config.mjs";
import { ensureValidChatGPTToken } from "./chatgpt-auth.mjs";
import { classifyExistingGroupsWithJev, readJevSettings } from "./jev.mjs";
import { getProviderReadiness } from "./provider-readiness.mjs";
import {
  buildProviderRequest,
  describeEmptyResponse,
  getProviderKind,
  isParamStyleError,
  paramStyleLadder,
  parseProviderResponse,
  PARAM_STYLE_CLASSIC,
} from "./provider-requests.mjs";
import { readFallbackProviderSettings, readProviderSettings } from "./provider-settings.mjs";
import {
  buildClassifyPrompt,
  buildClusterPrompt,
  buildUnifiedPrompt,
  buildFreshPrompt,
  buildOneShotNewGroupsPrompt,
} from "./ollama-prompts.mjs";
import { consolidateNewGroups } from "./new-group-consolidation.mjs";
import { chunkTabsForProvider, PROVIDER_TAB_BATCH_SIZE } from "./provider-batching.mjs";
import { collectProviderTabMap } from "./remote-assignment-retry.mjs";
import { fetchPageSnippet } from "./tabs.mjs";
import { showToast } from "./ui-toast.mjs";

const GENERATE_TIMEOUT_MS = 120000;
const PROVIDER_JSON_MAX_TOKENS = 4096;
const PROVIDER_FRESH_JSON_MAX_TOKENS = 4096;
const PROVIDER_FRESH_TAB_BATCH_SIZE = 35;
export const FALLBACK_MIN_NEW_GROUP_TABS = 2;

const stripMetaPrefix = (s) => s
  .replace(/^\s*(?:new\s+)?(?:category|label|topic|bucket|group)\s*[:\-–]\s*/i, "")
  .trim();

// One-click connectivity probe for the settings dialog's "Test connection"
// button. Runs the SAME readiness gate as a real sort (consent stays required —
// a test request still sends data to the provider), then issues a minimal
// probe. Returns a plain result object; never throws.
export const testProviderConnection = async (settings = readProviderSettings(globalThis.Services?.prefs)) => {
  const readiness = getProviderReadiness(settings);
  if (!readiness.ok) {
    return { ok: false, reason: readiness.reason, missingFields: readiness.missingFields || [] };
  }
  try {
    const reply = await providerText(readiness.value, "Reply with the single word: ok", 16);
    return { ok: true, reply: reply.slice(0, 60) };
  } catch (e) {
    return { ok: false, reason: "request_failed", error: e?.message || String(e) };
  }
};

// Stage 2: One-Shot Fallback-LLM for tabs that JEV did not confidently place into
// an existing workspace group (or all ungrouped tabs when 0 groups exist).
// Sends all leftover tabs together in ONE request so the LLM has full context,
// and enforces `minGroupSize` (default 2) so isolated singletons stay ungrouped.
export const runOneShotFallbackNewGroups = async ({
  leftoverTabs,
  snippets = [],
  existingGroupNames = [],
  fallbackSettings = readFallbackProviderSettings(globalThis.Services?.prefs),
  minGroupSize = FALLBACK_MIN_NEW_GROUP_TABS,
  fetchImpl,
}) => {
  if (!Array.isArray(leftoverTabs) || leftoverTabs.length === 0) {
    return { newGroups: [], skipped: [] };
  }
  if (fallbackSettings?.provider === "off") {
    return { newGroups: [], skipped: [...leftoverTabs] };
  }
  // If fewer tabs remain than the minimum group size (e.g. only 1 tab left),
  // it cannot form a multi-tab group, so leave it ungrouped without an extra API call.
  if (leftoverTabs.length < minGroupSize) {
    return { newGroups: [], skipped: [...leftoverTabs] };
  }

  const readiness = getProviderReadiness(fallbackSettings);
  if (!readiness.ok) {
    const msg = readiness.reason === "consent_required"
      ? "Fallback LLM needs data-sending consent before creating new groups."
      : `Fallback LLM (${fallbackSettings?.provider || "unknown"}) is not ready: ${readiness.reason}`;
    showToast(msg);
    return { newGroups: [], skipped: [...leftoverTabs], failed: readiness.reason };
  }

  const existingLower = new Set(
    (existingGroupNames || []).map((n) => String(n || "").trim().toLowerCase()).filter(Boolean),
  );

  const oneShotInput = buildOneShotNewGroupsPrompt(leftoverTabs, snippets, existingGroupNames);
  const parsed = await providerJson(readiness.value, oneShotInput, PROVIDER_JSON_MAX_TOKENS, fetchImpl);

  const groupsByLower = new Map();
  const skipped = [];

  // Support both flat map `{"0": "Group", "1": "skipped"}` and `{"groups": [...]}`
  if (Array.isArray(parsed?.groups)) {
    const seen = new Set();
    for (const grp of parsed.groups) {
      const rawName = stripMetaPrefix(String(grp?.name || "").trim());
      const lower = rawName.toLowerCase();
      if (!rawName || lower === "skipped" || lower === "none" || existingLower.has(lower)) continue;
      if (!groupsByLower.has(lower)) groupsByLower.set(lower, { name: rawName, tabs: [] });
      for (const idx of Array.isArray(grp?.tabs) ? grp.tabs : []) {
        const num = Number.parseInt(idx, 10);
        if (!Number.isFinite(num) || num < 0 || num >= leftoverTabs.length || seen.has(num)) continue;
        seen.add(num);
        groupsByLower.get(lower).tabs.push(leftoverTabs[num]);
      }
    }
    for (let i = 0; i < leftoverTabs.length; i++) {
      if (!seen.has(i)) skipped.push(leftoverTabs[i]);
    }
  } else {
    for (let i = 0; i < leftoverTabs.length; i++) {
      const rawVal = parsed?.[String(i)] ?? parsed?.[i];
      const cleaned = stripMetaPrefix(rawVal == null ? "" : String(rawVal).trim());
      const lower = cleaned.toLowerCase();
      if (!cleaned || lower === "skipped" || lower === "none" || existingLower.has(lower)) {
        skipped.push(leftoverTabs[i]);
        continue;
      }
      if (!groupsByLower.has(lower)) {
        groupsByLower.set(lower, { name: cleaned, tabs: [] });
      }
      groupsByLower.get(lower).tabs.push(leftoverTabs[i]);
    }
  }

  // Enforce minimum group size (default 2): demote any 1-tab group to `skipped`
  // so singletons stay ungrouped instead of creating 1-tab folders.
  const newGroups = [];
  for (const group of groupsByLower.values()) {
    if (group.tabs.length < minGroupSize) {
      skipped.push(...group.tabs);
    } else {
      newGroups.push(group);
    }
  }

  return { newGroups, skipped };
};

// Complete 2-stage JEV + One-Shot Fallback-LLM pipeline:
//   1. Enrich ungrouped tabs with page snippets (`fetchPageSnippet`).
//   2. If workspace has existing `<tab-group>` folders, run JEV (`classifyExistingGroupsWithJev`)
//      to place tabs that match existing groups with high probability & margin.
//   3. Send all leftover tabs in ONE shot to the Fallback-LLM (`runOneShotFallbackNewGroups`)
//      to invent new group names and group related tabs (>= 2 tabs per group), while leaving
//      true exotic singletons ungrouped (`skipped`).
export const runPass2JevHybrid = async (
  unmatchedTabs,
  existingGroups = [],
  {
    jevSettings = readJevSettings(globalThis.Services?.prefs),
    fallbackSettings = readFallbackProviderSettings(globalThis.Services?.prefs),
    minGroupSize = FALLBACK_MIN_NEW_GROUP_TABS,
    fetchImpl,
    preFetchedSnippets,
  } = {},
) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!Array.isArray(unmatchedTabs) || unmatchedTabs.length === 0) return empty;

  const snippets = Array.isArray(preFetchedSnippets)
    ? preFetchedSnippets
    : await fetchSnippets(unmatchedTabs, "jev-hybrid");

  const validExistingGroups = Array.isArray(existingGroups)
    ? existingGroups.filter((g) => g && typeof g.name === "string" && g.name.trim())
    : [];

  let assignedToExisting = [];
  let leftoverTabs = [...unmatchedTabs];
  let leftoverSnippets = [...snippets];

  // Stage 1: JEV Decision Model (only when existing groups are present and JEV key is configured)
  if (validExistingGroups.length > 0) {
    if (!jevSettings.consentToSendData) {
      showToast("Data-sending consent is required in Zen Tab Sorting settings.");
      return { ...empty, skipped: unmatchedTabs, failed: "consent_required" };
    }
    if (jevSettings.apiKey && jevSettings.apiKey.trim()) {
      try {
        const jevResult = await classifyExistingGroupsWithJev({
          tabs: unmatchedTabs,
          existingGroups: validExistingGroups,
          snippets,
          jevSettings,
          fetchImpl,
        });
        assignedToExisting = jevResult.assignedToExisting;
        leftoverTabs = jevResult.leftoverTabs;
        leftoverSnippets = jevResult.leftoverSnippets;
        console.log(
          `${LOG} JEV Stage 1: assigned ${assignedToExisting.length}/${unmatchedTabs.length} tab(s) to existing groups, ${leftoverTabs.length} left for Fallback-LLM`,
        );
      } catch (e) {
        console.error(`${LOG} JEV Stage 1 failed, falling through to Fallback-LLM:`, e);
        showToast(`JEV classification error: ${e.message || e}`);
      }
    } else {
      console.warn(`${LOG} JEV key not configured; skipping Stage 1 and sending tabs to Fallback-LLM`);
    }
  } else {
    console.log(`${LOG} JEV Stage 1 skipped: no existing groups in workspace; sending ${leftoverTabs.length} tab(s) to Fallback-LLM`);
  }

  // Stage 2: One-Shot Fallback-LLM for remaining ungrouped tabs
  if (leftoverTabs.length === 0) {
    return { assignedToExisting, newGroups: [], skipped: [] };
  }

  try {
    const existingGroupNames = validExistingGroups.map((g) => g.name);
    const stage2 = await runOneShotFallbackNewGroups({
      leftoverTabs,
      snippets: leftoverSnippets,
      existingGroupNames,
      fallbackSettings,
      minGroupSize,
      fetchImpl,
    });
    console.log(
      `${LOG} Fallback-LLM Stage 2: created ${stage2.newGroups.length} new group(s), skipped ${stage2.skipped.length} outlier tab(s)`,
    );
    return {
      assignedToExisting,
      newGroups: stage2.newGroups,
      skipped: stage2.skipped,
      ...(stage2.failed ? { failed: stage2.failed } : {}),
    };
  } catch (e) {
    console.error(`${LOG} Fallback-LLM Stage 2 failed:`, e);
    showToast(`Fallback-LLM failed: ${e.message || e}`);
    return {
      assignedToExisting,
      newGroups: [],
      skipped: leftoverTabs,
      failed: e.message || String(e),
    };
  }
};

export const classifyExistingGroupsRemoteBatch = async (pendingTabs, rules, settings = readProviderSettings(globalThis.Services?.prefs)) => {
  if (!pendingTabs?.length || !rules?.length) return new Map();
  const readiness = getProviderReadiness(settings);
  if (!readiness.ok) {
    showToast(readiness.reason === "consent_required"
      ? "Remote provider needs data-sending consent before sorting."
      : `Remote provider is not ready: ${readiness.reason}`);
    return skippedMap(pendingTabs);
  }

  const namesByLower = new Map(rules.map((r) => r?.name).filter(Boolean).map((name) => [name.toLowerCase(), name]));
  const out = new Map();

  for (const chunk of chunkTabsForProvider(pendingTabs)) {
    const parsed = await providerJson(readiness.value, buildClassifyPrompt(rules, chunk.tabs));
    for (const [key, value] of Object.entries(parsed)) {
      const chunkIdx = Number.parseInt(key, 10);
      if (!Number.isFinite(chunkIdx) || chunkIdx < 0 || chunkIdx >= chunk.tabs.length) continue;
      const raw = String(value || "").trim();
      const canonical = namesByLower.get(raw.toLowerCase());
      out.set(chunk.start + chunkIdx, canonical || null);
    }
  }
  for (let i = 0; i < pendingTabs.length; i++) if (!out.has(i)) out.set(i, null);
  return out;
};

export const runPass2Remote = async (unmatched, rules, settings = readProviderSettings(globalThis.Services?.prefs)) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!unmatched?.length) return empty;

  try {
    const readiness = getProviderReadiness(settings);
    if (!readiness.ok) {
      const message = readiness.reason === "consent_required"
        ? "Remote provider needs data-sending consent before sorting."
        : `Remote provider is not ready: ${readiness.reason}`;
      showToast(message);
      return { ...empty, skipped: unmatched, failed: readiness.reason };
    }

    if (!rules.some((r) => r?.name)) {
      const grouped = await clusterUnmatchedNewGroups(unmatched, readiness.value);
      return { assignedToExisting: [], newGroups: grouped.groups, skipped: grouped.skipped };
    }

    const { deduped, origToDeduped } = dedupeTabs(unmatched);
    const snippets = await fetchSnippets(deduped, "remote");
    const ruleNameByLower = new Map(rules.filter((r) => r?.name).map((r) => [r.name.toLowerCase(), r.name]));
    const { parsedByIndex: parsedByDedupedIndex, failures } = await collectProviderTabMap({
      tabs: deduped,
      snippets,
      initialBatchSize: PROVIDER_TAB_BATCH_SIZE,
      label: "remote provider",
      buildPrompt: (tabs, chunkSnippets) => buildUnifiedPrompt(rules, tabs, chunkSnippets),
      fetchJson: (inputStr) => providerJson(readiness.value, inputStr, PROVIDER_JSON_MAX_TOKENS),
    });
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
      const canonical = ruleNameByLower.get(lower);
      if (canonical) {
        assignedToExisting.push({ tabInfo: unmatched[i], groupName: canonical, similarity: 1.0 });
        continue;
      }
      if (!newGroupsByKey.has(lower)) newGroupsByKey.set(lower, { name: raw, tabs: [] });
      newGroupsByKey.get(lower).tabs.push(unmatched[i]);
    }

    const newGroups = await consolidateNewGroups([...newGroupsByKey.values()], (inputStr) =>
      providerJson(readiness.value, inputStr), "Remote provider");
    if (failures.length > 0) {
      showToast(`Remote provider retried incomplete batches; ${skipped.length} tab(s) still did not move.`);
    }
    return { assignedToExisting, newGroups, skipped };
  } catch (e) {
    console.error(`${LOG} remote provider classification failed:`, e);
    showToast(`Remote provider classification failed: ${e.message || e}`);
    return { ...empty, skipped: unmatched, failed: e.message || String(e) };
  }
};

export const runPass2RemoteFresh = async (allTabs, settings = readProviderSettings(globalThis.Services?.prefs)) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!allTabs?.length) return empty;

  try {
    const readiness = getProviderReadiness(settings);
    if (!readiness.ok) {
      showToast(`Remote provider is not ready: ${readiness.reason}`);
      return { ...empty, skipped: allTabs, failed: readiness.reason };
    }

    const { deduped, origToDeduped } = dedupeTabs(allTabs);
    const snippets = await fetchSnippets(deduped, "remote fresh");
    const { parsedByIndex: parsedByDedupedIndex, failures } = await collectProviderTabMap({
      tabs: deduped,
      snippets,
      initialBatchSize: PROVIDER_FRESH_TAB_BATCH_SIZE,
      label: "remote provider fresh",
      buildPrompt: (tabs, chunkSnippets) => buildFreshPrompt(tabs, chunkSnippets),
      fetchJson: (inputStr) => providerJson(readiness.value, inputStr, PROVIDER_FRESH_JSON_MAX_TOKENS),
    });
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
      if (!newGroupsByKey.has(lower)) newGroupsByKey.set(lower, { name: raw, tabs: [] });
      newGroupsByKey.get(lower).tabs.push(allTabs[i]);
    }

    if (failures.length > 0) {
      showToast(`Remote provider skipped ${failures.length} full-AI batch(es). Try a stronger model if some tabs did not move.`);
    }

    const newGroups = await consolidateNewGroups([...newGroupsByKey.values()], (inputStr) =>
      providerJson(readiness.value, inputStr, PROVIDER_FRESH_JSON_MAX_TOKENS), "Remote provider");

    return {
      assignedToExisting: [],
      newGroups,
      skipped,
      ...(failures.length > 0 ? { failed: failures.join("; ") } : {}),
    };
  } catch (e) {
    console.error(`${LOG} remote provider fresh classification failed:`, e);
    showToast(`Remote provider fresh classification failed: ${e.message || e}`);
    return { ...empty, skipped: allTabs, failed: e.message || String(e) };
  }
};

const clusterUnmatchedNewGroups = async (leftover, settings) => {
  const seen = new Set();
  const groupsByLower = new Map();

  for (const chunk of chunkTabsForProvider(leftover)) {
    const parsed = await providerJson(settings, buildClusterPrompt(chunk.tabs));
    const validIdx = (i) => Number.isFinite(i) && i >= 0 && i < chunk.tabs.length;

    for (const group of Array.isArray(parsed?.groups) ? parsed.groups : []) {
      const name = String(group?.name || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!groupsByLower.has(key)) groupsByLower.set(key, { name, tabs: [] });

      for (const chunkIdx of Array.isArray(group?.tabs) ? group.tabs.filter(validIdx) : []) {
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

const providerJson = async (settings, inputStr, maxTokens = PROVIDER_JSON_MAX_TOKENS, fetchImpl) => {
  const responseText = await providerText(settings, inputStr, maxTokens, fetchImpl);
  let parsed;
  try {
    parsed = JSON.parse(extractJsonObjectText(responseText));
  } catch {
    throw new Error(`Provider returned non-JSON content: ${String(responseText).slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Provider returned non-object JSON");
  }
  return parsed;
};

const extractJsonObjectText = (text) => {
  const raw = String(text || "").trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }
  return raw;
};

// Resolve which fetch to use. In the about:preferences context (where the
// "Test connection" button lives) the document's CSP can block fetches to
// external provider hosts with a bare "NetworkError" — so route requests
// through the main browser window's fetch instead. In the browser window this
// resolves to the same fetch as before, and in Node (tests stub
// globalThis.fetch) Services is undefined so the global is used unchanged.
const resolveFetch = (customFetch) => {
  if (typeof customFetch === "function") return customFetch;
  try {
    if (typeof Services !== "undefined" && typeof window !== "undefined" &&
        window.location?.href !== "chrome://browser/content/browser.xhtml") {
      const win = Services.wm?.getMostRecentWindow?.("navigator:browser");
      if (win?.fetch) return win.fetch.bind(win);
    }
  } catch {}
  return fetch;
};

const sendProviderRequest = async (request, fetchImpl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
  try {
    const doFetch = resolveFetch(fetchImpl);
    const response = await doFetch(request.url, { ...request.init, signal: controller.signal });
    return { response, body: await response.text() };
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `timeout after ${GENERATE_TIMEOUT_MS}ms` : (e.message || String(e)));
  } finally {
    clearTimeout(timer);
  }
};

// Which OpenAI parameter shape an endpoint and model accepted, remembered so a
// sort pays the extra round trip once rather than on every batch. In-memory on
// purpose: the shape belongs to the model, not to the user's settings, and
// re-learning it after a restart costs one rejected request.
const paramStyleByTarget = new Map();

const providerText = async (settings, inputStr, maxTokens, fetchImpl) => {
  let effectiveSettings = settings;
  if (settings.provider === "chatgpt") {
    const freshToken = await ensureValidChatGPTToken(
      globalThis.Services?.prefs,
      fetchImpl,
      settings,
    );
    effectiveSettings = { ...settings, accessToken: freshToken };
  }

  const kind = getProviderKind(effectiveSettings);
  // Only the OpenAI-shaped kinds have the parameter split. Gemini, ChatGPT SIWC,
  // and Ollama take their own parameters and are left alone.
  const adaptive = kind === "openai";
  const target = `${effectiveSettings.endpoint || ""}\x00${effectiveSettings.model || ""}`;
  const cached = adaptive ? paramStyleByTarget.get(target) : null;
  const ladder = !adaptive
    ? [PARAM_STYLE_CLASSIC]
    : cached
      ? [cached]
      : paramStyleLadder(effectiveSettings.model);

  let response;
  let body;
  let style;
  // Walk the ladder while the provider is specifically rejecting the shape of
  // the request. Any other failure is the caller's problem, not ours.
  for (const candidate of ladder) {
    style = candidate;
    ({ response, body } = await sendProviderRequest(
      buildProviderRequest(effectiveSettings, inputStr, maxTokens, candidate),
      fetchImpl,
    ));
    if (response.ok || !isParamStyleError(response.status, body)) break;
    console.log(`${LOG} provider rejected the ${candidate} parameter shape`);
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  if (adaptive) paramStyleByTarget.set(target, style);
  const text = parseProviderResponse(kind, body);
  if (typeof text !== "string" || !text.trim()) {
    const detail = describeEmptyResponse(kind, body);
    throw new Error(`Provider response did not contain text${detail ? ` (${detail})` : ""}`);
  }
  return text.trim();
};

const dedupeTabs = (tabs) => {
  const indexByKey = new Map();
  const deduped = [];
  const origToDeduped = tabs.map((tab) => {
    const key = `${tab.hostname || ""}\x00${tab.title || ""}`;
    if (indexByKey.has(key)) return indexByKey.get(key);
    const idx = deduped.length;
    indexByKey.set(key, idx);
    deduped.push(tab);
    return idx;
  });
  return { deduped, origToDeduped };
};

const fetchSnippets = async (tabs, label) => {
  const t0 = performance.now();
  const snippets = await Promise.all(tabs.map((tab) => {
    const url = tab.url || "";
    if (!url.startsWith("http://") && !url.startsWith("https://")) return "";
    return fetchPageSnippet(url);
  }));
  const hit = snippets.filter(Boolean).length;
  console.log(`${LOG} ${label}: fetched snippets for ${hit}/${tabs.length} tab(s) in ${Math.round(performance.now() - t0)}ms`);
  return snippets;
};

const skippedMap = (tabs) => new Map(tabs.map((_, idx) => [idx, null]));
