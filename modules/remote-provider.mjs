// Zen Tab Sorting — remote provider & JEV + Fallback-LLM Pass 2 drivers.
//
// Supports:
//   1. JEV + One-Shot Fallback-LLM hybrid pipeline (`runPass2JevHybrid`):
//      - Stage 1: TypeSafe JEV decision model classifies ungrouped tabs into
//        existing workspace `<tab-group>` folders using probability + margin thresholds.
//      - Stage 2: All remaining ungrouped tabs are sent in a single One-Shot call
//        to the configured Fallback-LLM (ChatGPT SIWC, PrimaLabs, OpenAI-compatible,
//        Gemini, Ollama, or Custom) to create new groups (min 2 tabs per new group)
//        with strict JSON schema validation and up to 3 automatic retry attempts.
//   2. Standalone remote providers (`openai`, `primalabs`, `chatgpt`, `gemini`, `custom`).

import { LOG } from "./config.mjs";
import { ChatGPTSignInRequiredError, ensureValidChatGPTToken } from "./chatgpt-auth.mjs";
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
  buildOneShotSchemaRetryPrompt,
} from "./ollama-prompts.mjs";
import { consolidateNewGroups } from "./new-group-consolidation.mjs";
import { chunkTabsForProvider, PROVIDER_TAB_BATCH_SIZE } from "./provider-batching.mjs";
import { collectProviderTabMap } from "./remote-assignment-retry.mjs";
import { fetchPageSnippet } from "./tabs.mjs";
import { showToast } from "./ui-toast.mjs";
import { recordDebugEvent, detectQuotaOrRateLimit } from "./debug-journal.mjs";

const GENERATE_TIMEOUT_MS = 120000;
const PROVIDER_JSON_MAX_TOKENS = 4096;
const PROVIDER_FRESH_JSON_MAX_TOKENS = 4096;
const PROVIDER_FRESH_TAB_BATCH_SIZE = 35;
export const FALLBACK_MIN_NEW_GROUP_TABS = 2;
export const MAX_FALLBACK_SCHEMA_ATTEMPTS = 3;

const stripMetaPrefix = (s) => s
  .replace(/^\s*(?:new\s+)?(?:category|label|topic|bucket|group)\s*[:\-–]\s*/i, "")
  .trim();

/**
 * Validate that a parsed JSON object from the Fallback-LLM strictly conforms to
 * our expected tab-grouping schema for `tabCount` tabs.
 *
 * Accepted schema:
 *   1. Primary flat map: `{ "0": "Group Name", "1": "skipped", ... }` where EVERY
 *      index from `"0"` to `"${tabCount - 1}"` is present and mapped to a non-empty string.
 *   2. Structured groups object: `{ "groups": [{ "name": string, "tabs": number[] }], "skipped"?: number[] }`
 *      with valid group names and valid tab indices.
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export const validateFallbackSchema = (parsed, tabCount) => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Response is not a JSON object" };
  }

  if (Array.isArray(parsed.groups)) {
    if (parsed.groups.length === 0 && !Array.isArray(parsed.skipped)) {
      return { ok: false, error: "JSON 'groups' array is empty and 'skipped' is missing" };
    }
    for (let gIdx = 0; gIdx < parsed.groups.length; gIdx++) {
      const grp = parsed.groups[gIdx];
      if (!grp || typeof grp !== "object") {
        return { ok: false, error: `groups[${gIdx}] is not an object` };
      }
      if (typeof grp.name !== "string" || !grp.name.trim() || grp.name.trim().length > 80) {
        return { ok: false, error: `groups[${gIdx}].name must be a non-empty string (<= 80 chars)` };
      }
      if (!Array.isArray(grp.tabs) || grp.tabs.some((idx) => !Number.isInteger(Number(idx)) || Number(idx) < 0 || Number(idx) >= tabCount)) {
        return { ok: false, error: `groups[${gIdx}].tabs must be an array of valid tab indices (0..${tabCount - 1})` };
      }
    }
    return { ok: true };
  }

  for (let i = 0; i < tabCount; i++) {
    const key = String(i);
    if (!(key in parsed)) {
      return { ok: false, error: `Missing required tab index key "${key}" (expected all keys "0".."${tabCount - 1}")` };
    }
    const val = parsed[key];
    if (typeof val !== "string") {
      return { ok: false, error: `Value for tab "${key}" must be a string, got ${typeof val}` };
    }
    const trimmed = stripMetaPrefix(val.trim());
    if (!trimmed) {
      return { ok: false, error: `Value for tab "${key}" is empty` };
    }
    if (trimmed.length > 80) {
      return { ok: false, error: `Value for tab "${key}" exceeds maximum group name length (80 chars)` };
    }
  }

  return { ok: true };
};

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
// Includes a up-to-3x retry mechanism with strict schema validation and clear user
// error notifications if all 3 attempts fail.
export const runOneShotFallbackNewGroups = async ({
  leftoverTabs,
  snippets = [],
  existingGroupNames = [],
  fallbackSettings = readFallbackProviderSettings(globalThis.Services?.prefs),
  minGroupSize = FALLBACK_MIN_NEW_GROUP_TABS,
  maxAttempts = MAX_FALLBACK_SCHEMA_ATTEMPTS,
  fetchImpl,
}) => {
  if (!Array.isArray(leftoverTabs) || leftoverTabs.length === 0) {
    return { newGroups: [], skipped: [] };
  }
  if (fallbackSettings?.provider === "off" || fallbackSettings?.provider === "none") {
    recordDebugEvent("STAGE-2-FALLBACK", "Fallback-LLM ist ausgeschaltet; überspringe neue Gruppen.");
    return { newGroups: [], skipped: [...leftoverTabs] };
  }
  if (leftoverTabs.length < minGroupSize) {
    return { newGroups: [], skipped: [...leftoverTabs] };
  }

  const readiness = getProviderReadiness(fallbackSettings);
  if (!readiness.ok) {
    if (fallbackSettings?.provider === "chatgpt" && readiness.missingFields?.includes("accessToken")) {
      const error = new ChatGPTSignInRequiredError();
      showToast(error.message, { type: "warning" });
      return { newGroups: [], skipped: [...leftoverTabs], failed: error.code, failedMessage: error.message };
    }
    const msg = readiness.reason === "consent_required"
      ? "Fallback-LLM benötigt Daten-Freigabe (Consent Checkbox) in den Einstellungen."
      : `Fallback-LLM (${fallbackSettings?.provider || "unknown"}) ist nicht bereit: ${readiness.reason}`;
    showToast(msg, { type: "warning" });
    return { newGroups: [], skipped: [...leftoverTabs], failed: readiness.reason, failedMessage: msg };
  }

  const existingLower = new Set(
    (existingGroupNames || []).map((n) => String(n || "").trim().toLowerCase()).filter(Boolean),
  );

  const baseInput = buildOneShotNewGroupsPrompt(leftoverTabs, snippets, existingGroupNames);
  let parsed = null;
  let lastError = "";
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const currentInput = attempt === 1
      ? baseInput
      : buildOneShotSchemaRetryPrompt(baseInput, lastError, attempt, leftoverTabs.length);

    try {
      const candidate = await providerJson(readiness.value, currentInput, PROVIDER_JSON_MAX_TOKENS, fetchImpl);
      const validation = validateFallbackSchema(candidate, leftoverTabs.length);
      if (validation.ok) {
        parsed = candidate;
        lastError = "";
        break;
      }
      lastError = validation.error;
      console.warn(`${LOG} Fallback-LLM attempt ${attempt}/${maxAttempts} failed schema check: ${lastError}`);
    } catch (e) {
      lastError = e?.message || String(e);
      if (e?.requiresSignIn) {
        showToast(lastError, { type: "warning" });
        return { newGroups: [], skipped: [...leftoverTabs], failed: e.code,
          failedMessage: lastError, attempts: attempt };
      }
      recordDebugEvent("STAGE-2-ERROR", `Attempt ${attempt}/${maxAttempts} error: ${lastError}`);
      const quotaCheck = detectQuotaOrRateLimit(e?.status, e?.body, lastError);
      if (quotaCheck.isQuota) {
        showToast(quotaCheck.userMessage, { type: "warning" });
        return {
          newGroups: [],
          skipped: [...leftoverTabs],
          failed: "quota_exceeded",
          failedMessage: quotaCheck.userMessage,
          attempts: attempt,
        };
      }
      console.warn(`${LOG} Fallback-LLM attempt ${attempt}/${maxAttempts} failed: ${lastError}`);
    }
  }

  if (!parsed) {
    const userMessage = `Fallback-LLM Schema-Fehler nach ${attemptsUsed} Versuchen (${lastError}). Übrige Tabs bleiben ungruppiert.`;
    console.error(`${LOG} ${userMessage}`);
    showToast(userMessage, { type: "warning" });
    return {
      newGroups: [],
      skipped: [...leftoverTabs],
      failed: `schema_validation_failed: ${lastError}`,
      failedMessage: userMessage,
      attempts: attemptsUsed,
    };
  }

  const groupsByLower = new Map();
  const skipped = [];

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

  return { newGroups, skipped, attempts: attemptsUsed };
};

// Complete 2-stage JEV + One-Shot Fallback-LLM pipeline:
export const runPass2JevHybrid = async (
  unmatchedTabs,
  existingGroups = [],
  {
    jevSettings = readJevSettings(globalThis.Services?.prefs),
    fallbackSettings = readFallbackProviderSettings(globalThis.Services?.prefs),
    minGroupSize = FALLBACK_MIN_NEW_GROUP_TABS,
    maxAttempts = MAX_FALLBACK_SCHEMA_ATTEMPTS,
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
      recordDebugEvent("STAGE-1-ERROR", "JEV Stufe 1: Daten-Freigabe (Consent Checkbox) in Einstellungen erforderlich.");
      showToast("Daten-Freigabe (Consent Checkbox) in den Zen Tab Sorting Einstellungen erforderlich.", { type: "warning" });
      return { ...empty, skipped: unmatchedTabs, failed: "consent_required" };
    }
    if (jevSettings.apiKey && jevSettings.apiKey.trim()) {
      try {
        recordDebugEvent(
          "STAGE-1-JEV",
          `Sending ${unmatchedTabs.length} tab(s) to JEV (${jevSettings.jevProvider}, model: ${jevSettings.model})`,
          {
            tabs: unmatchedTabs.map((t) => ({ title: t.title, hostname: t.hostname })),
            existingGroups: validExistingGroups.map((g) => g.name),
          },
        );
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
        recordDebugEvent(
          "STAGE-1-JEV-RESULT",
          `JEV Stage 1 completed: assigned ${assignedToExisting.length}/${unmatchedTabs.length} tab(s) to existing groups, ${leftoverTabs.length} left`,
          {
            assigned: assignedToExisting.map((a) => ({
              tab: a.tabInfo.title || a.tabInfo.hostname,
              group: a.groupName,
              prob: a.similarity,
              margin: a.margin,
            })),
            leftoverCount: leftoverTabs.length,
          },
        );
        console.log(
          `${LOG} JEV Stage 1: assigned ${assignedToExisting.length}/${unmatchedTabs.length} tab(s) to existing groups, ${leftoverTabs.length} left for Fallback-LLM`,
        );
      } catch (e) {
        recordDebugEvent("STAGE-1-JEV-ERROR", `JEV Stage 1 error: ${e.message || e}`);
        console.error(`${LOG} JEV Stage 1 failed, falling through to Fallback-LLM:`, e);
        showToast(`JEV Fehler (Stufe 1): ${e.message || e} — übergebe an Fallback-LLM.`, { type: "warning" });
      }
    } else {
      recordDebugEvent("STAGE-1-ERROR", "JEV Stufe 1: API-Key fehlt in den Einstellungen; übergebe Tabs an Fallback-LLM.");
      console.warn(`${LOG} JEV key not configured; skipping Stage 1 and sending tabs to Fallback-LLM`);
      showToast("JEV API-Key fehlt in den Einstellungen (Zen Tab Sorting).", { type: "warning" });
    }
  } else {
    recordDebugEvent("STAGE-1-SKIPPED", `JEV Stufe 1 übersprungen: Keine bestehenden Ordner im Workspace gefunden; übergebe ${leftoverTabs.length} Tab(s) an Fallback-LLM.`);
    console.log(`${LOG} JEV Stage 1 skipped: no existing groups in workspace; sending ${leftoverTabs.length} tab(s) to Fallback-LLM`);
  }

  // Stage 2: One-Shot Fallback-LLM for remaining ungrouped tabs
  if (leftoverTabs.length === 0) {
    recordDebugEvent("HYBRID-COMPLETE", "Alle Tabs wurden durch JEV Stufe 1 zugeordnet.");
    return { assignedToExisting, newGroups: [], skipped: [] };
  }

  if (fallbackSettings?.provider === "off" || fallbackSettings?.provider === "none") {
    recordDebugEvent("STAGE-2-FALLBACK-OFF", "Fallback-LLM ist ausgeschaltet (off).");
    if (assignedToExisting.length > 0) {
      showToast(`JEV: ${assignedToExisting.length} Tab(s) in bestehende Ordner einsortiert (Fallback deaktiviert).`);
    } else {
      showToast("JEV: Keine Tabs passten in bestehende Ordner (Fallback deaktiviert).");
    }
    return { assignedToExisting, newGroups: [], skipped: leftoverTabs };
  }

  try {
    const existingGroupNames = validExistingGroups.map((g) => g.name);
    const stage2 = await runOneShotFallbackNewGroups({
      leftoverTabs,
      snippets: leftoverSnippets,
      existingGroupNames,
      fallbackSettings,
      minGroupSize,
      maxAttempts,
      fetchImpl,
    });
    console.log(
      `${LOG} Fallback-LLM Stage 2: created ${stage2.newGroups.length} new group(s), skipped ${stage2.skipped.length} outlier tab(s)`,
    );

    if (stage2.failed) {
      const fallbackMsg = stage2.failedMessage || `Fallback-LLM nicht verfügbar (${stage2.failed})`;
      recordDebugEvent("STAGE-2-FALLBACK-ABORTED", `${fallbackMsg} — Bleibe im JEV-Modus: ${assignedToExisting.length} Tab(s) zugeordnet, restliche Tabs bleiben ungruppiert.`);
      if (assignedToExisting.length > 0) {
        showToast(`Fallback nicht verfügbar: ${assignedToExisting.length} Tab(s) in bestehende Ordner sortiert. Restliche Tabs bleiben ungruppiert.`, { type: "info" });
      }
    }

    return {
      assignedToExisting,
      newGroups: stage2.newGroups,
      skipped: stage2.skipped,
      ...(stage2.failed ? { failed: stage2.failed, failedMessage: stage2.failedMessage } : {}),
      ...(stage2.attempts ? { attempts: stage2.attempts } : {}),
    };
  } catch (e) {
    recordDebugEvent("STAGE-2-ERROR", `Fallback-LLM Stage 2 exception: ${e.message || e}`);
    console.error(`${LOG} Fallback-LLM Stage 2 failed:`, e);
    const quotaCheck = detectQuotaOrRateLimit(e?.status, e?.body, e?.message);
    const errorMsg = quotaCheck.isQuota ? quotaCheck.userMessage : `Fallback-LLM Fehler: ${e.message || e}`;
    showToast(errorMsg, { type: "warning" });
    recordDebugEvent("STAGE-2-FALLBACK-ABORTED", `${errorMsg} — Bleibe im reinen JEV-Modus: ${assignedToExisting.length} Tab(s) zugeordnet.`);
    if (assignedToExisting.length > 0) {
      showToast(`Fallback-LLM nicht verfügbar: ${assignedToExisting.length} Tab(s) durch JEV sortiert, restliche Tabs bleiben ungruppiert.`, { type: "info" });
    }
    return {
      assignedToExisting,
      newGroups: [],
      skipped: leftoverTabs,
      failed: e.message || String(e),
      failedMessage: errorMsg,
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
