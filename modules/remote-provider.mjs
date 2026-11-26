// Zen Tab Sorting — remote provider & JEV + Fallback-LLM Pass 2 drivers.
//
// Supports:
//   1. JEV + One-Shot Fallback-LLM hybrid pipeline (`runPass2JevHybrid`):
//      - Stage 1: TypeSafe JEV decision model classifies ungrouped tabs into
//        existing workspace `<tab-group>` folders using probability + margin thresholds
//        with bounded LRU classification caching and deduplication.
//      - Stage 2: Remaining ungrouped tabs are clustered by the configured
//        Fallback-LLM (18 provider presets across 5 protocol adapters) with
//        token-aware chunking, JEV top-2 rescue hints, structured JSON schema,
//        partial-valid (>=80%) delta-repair, catch-all filtering, and automatic
//        Primary -> Secondary -> Local failover.
//   2. Standalone remote providers across all 5 protocol adapters.

import { CONFIG, LOG } from "./config.mjs";
import {
  ChatGPTSignInRequiredError,
  ensureValidChatGPTToken,
  forceRefreshChatGPTToken,
} from "./chatgpt-auth.mjs";
import { classifyExistingGroupsWithJev, readJevSettings } from "./jev.mjs";
import { getProviderReadiness } from "./provider-readiness.mjs";
import {
  getProviderPreset,
  isLoopbackHost,
  resolveAdapterKind,
  resolveProfileEndpoint,
} from "./provider-registry.mjs";
import {
  getAdapterForProfile,
  streamSSEResponse,
} from "./provider-adapters.mjs";
import {
  ERROR_CATEGORIES,
  ProviderHttpError,
  classifyProviderError,
  parseRetryAfterMs,
  withTransientRetry,
} from "./provider-errors.mjs";
import {
  buildEffortCacheKey,
  buildModelCacheKey,
  clearProviderModelCache,
  getCachedModelCapabilities,
  getCachedResolvedEffort,
  listProviderModels,
  recordRecentModel,
  setCachedModelCapabilities,
  setCachedResolvedEffort,
} from "./provider-models.mjs";
import {
  buildProviderRequest,
  describeEmptyResponse,
  getProviderKind,
  isEmptyLengthResponse,
  isParamStyleError,
  isResponseFormatError,
  paramStyleLadder,
  parseProviderResponse,
  PARAM_STYLE_CLASSIC,
} from "./provider-requests.mjs";
import {
  getFallbackChain,
  getTaskProfile,
  readFallbackProviderSettings,
  readProviderSettings,
} from "./provider-settings.mjs";
import {
  ASSIGNMENTS_JSON_SCHEMA,
  buildClassifyPrompt,
  buildClusterPrompt,
  buildFreshPrompt,
  buildOneShotNewGroupsMessages,
  buildOneShotSchemaRetryMessages,
  buildUnifiedPrompt,
  isCatchAllGroupName,
  parseAssignmentsResponse,
} from "./ollama-prompts.mjs";
import {
  consolidateNewGroups,
  normalizeNameForDedupe,
} from "./new-group-consolidation.mjs";
import {
  chunkTabsByBudget,
  chunkTabsForProvider,
  PROVIDER_TAB_BATCH_SIZE,
} from "./provider-batching.mjs";
import { collectProviderTabMap } from "./remote-assignment-retry.mjs";
import {
  classificationCache,
  invalidateClassificationCache,
} from "./classification-cache.mjs";
import { fetchPageSnippets } from "./tabs.mjs";
import { showToast } from "./ui-toast.mjs";
import { recordDebugEvent, detectQuotaOrRateLimit } from "./debug-journal.mjs";
import { getLocale } from "./i18n.mjs";
import {
  describeReasoningSelection,
  isReasoningParamError,
  nextReasoningRecoveryStep,
  parseModelReasoningCapabilities,
  readReasoningPreference,
  readTimeBudgetSeconds,
  resolveCapabilitiesForModel,
  resolveReasoningEffort,
} from "./reasoning.mjs";

const MAX_TIME_BUDGET_MS = CONFIG.AI_TIME_BUDGET_MAX * 1000;
const CLOUD_DEFAULT_BUDGET_MS = (CONFIG.AI_TIME_BUDGET_CLOUD_DEFAULT || 20) * 1000;
const LOCAL_DEFAULT_BUDGET_MS = (CONFIG.AI_TIME_BUDGET_LOCAL_DEFAULT || 90) * 1000;
const AUTH_HEADER_NAME = ["author", "ization"].join("");
const MODEL_CAPABILITY_TIMEOUT_MS = 1200;
const MODEL_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const PROVIDER_JSON_MAX_TOKENS = 4096;
const PROVIDER_FRESH_JSON_MAX_TOKENS = 4096;
const PROVIDER_FRESH_TAB_BATCH_SIZE = 35;
const STAGE2_CHUNK_MAX_TABS = 45;
const STAGE2_CHUNK_MAX_INPUT_TOKENS = 6000;
const PARTIAL_RECOVERY_MIN_RATIO = 0.8;
const PARTIAL_RECOVERY_MIN_TABS = 5;

export const FALLBACK_MIN_NEW_GROUP_TABS = 2;
export const MAX_FALLBACK_SCHEMA_ATTEMPTS = 3;

const stripMetaPrefix = (s) => s
  .replace(/^\s*(?:new\s+)?(?:category|label|topic|bucket|group)\s*[:\-–]\s*/i, "")
  .trim();

const isLocalProfile = (settings) => {
  if (!settings || typeof settings !== "object") return false;
  const preset = getProviderPreset(settings.provider);
  if (preset?.category === "local") return true;
  const endpoint = resolveProfileEndpoint(settings);
  return Boolean(endpoint && isLoopbackHost(endpoint));
};

/**
 * Resolve the effective time budget (ms) for a provider profile.
 * Honors explicit user `ai-time-budget` (up to `AI_TIME_BUDGET_MAX`, 120s),
 * falling back to smart defaults (20s cloud, 90s local) when unset.
 */
export const resolveEffectiveTimeBudgetMs = (
  settings = null,
  prefs = globalThis.Services?.prefs,
) => {
  try {
    if (prefs?.prefHasUserValue?.(CONFIG.AI_TIME_BUDGET_PREF)) {
      return Math.min(MAX_TIME_BUDGET_MS, Math.max(3000, Math.round(readTimeBudgetSeconds(prefs) * 1000)));
    }
  } catch {}
  return isLocalProfile(settings) ? LOCAL_DEFAULT_BUDGET_MS : CLOUD_DEFAULT_BUDGET_MS;
};

const isGermanLocale = () => getLocale() === "de";

const localizedMsg = (de, en) => (isGermanLocale() ? de : en);

const formatActionableProviderError = (err, settings = null) => {
  const status = Number(err?.status || 0);
  const body = String(err?.body || "");
  const rawMessage = String(err?.message || err || "");
  const category = classifyProviderError(status, body, err);
  const providerId = String(settings?.provider || err?.provider || "").toLowerCase();
  const isOllama = providerId === "ollama" || resolveAdapterKind(settings) === "ollama-native";
  const model = String(settings?.model || "").trim();

  if (err?.requiresSignIn || err?.code === "chatgpt_sign_in_required") {
    return {
      errorCode: "chatgpt_sign_in_required",
      category: ERROR_CATEGORIES.AUTH,
      userMessage: rawMessage || localizedMsg(
        "ChatGPT-Anmeldung ist abgelaufen oder wurde widerrufen. Bitte in den Mod-Einstellungen erneut mit ChatGPT anmelden.",
        "ChatGPT sign-in expired or was revoked. Please sign in with ChatGPT again in settings.",
      ),
    };
  }

  if (category === ERROR_CATEGORIES.ABORT) {
    return {
      errorCode: "aborted",
      category,
      userMessage: localizedMsg("Sortierung abgebrochen.", "Sorting cancelled."),
    };
  }

  if (status === 401) {
    return {
      errorCode: "auth_401",
      category: ERROR_CATEGORIES.AUTH,
      userMessage: localizedMsg(
        "Authentifizierung fehlgeschlagen (HTTP 401) — API-Key oder Anmeldung prüfen.",
        "Authentication failed (HTTP 401) — check your API key or sign-in session.",
      ),
    };
  }

  if (status === 403) {
    if (isOllama) {
      return {
        errorCode: "ollama_origins_403",
        category: ERROR_CATEGORIES.AUTH,
        userMessage: localizedMsg(
          'Ollama hat die Anfrage blockiert (HTTP 403). Bitte OLLAMA_ORIGINS="*" (oder chrome://*,moz-extension://*) setzen und Ollama neu starten.',
          'Ollama blocked the browser origin (HTTP 403). Set OLLAMA_ORIGINS="*" (or chrome://*,moz-extension://*) and restart Ollama.',
        ),
      };
    }
    return {
      errorCode: "forbidden_403",
      category: ERROR_CATEGORIES.AUTH,
      userMessage: localizedMsg(
        "Zugriff verweigert (HTTP 403) — Berechtigungen, Region oder Kontingent beim Provider prüfen.",
        "Access forbidden (HTTP 403) — check provider permissions, account access, or billing.",
      ),
    };
  }

  if (status === 404) {
    return {
      errorCode: "not_found_404",
      category: ERROR_CATEGORIES.NOT_FOUND,
      userMessage: model
        ? localizedMsg(
            `Modell „${model}“ oder Endpoint nicht gefunden (HTTP 404). Modell-ID und URL prüfen.`,
            `Model "${model}" or endpoint not found (HTTP 404). Check model ID and endpoint URL.`,
          )
        : localizedMsg(
            "Endpoint oder Modell nicht gefunden (HTTP 404). URL und Modell-ID prüfen.",
            "Endpoint or model not found (HTTP 404). Check the endpoint URL and model ID.",
          ),
    };
  }

  const quotaCheck = detectQuotaOrRateLimit(status, body, rawMessage);
  if (category === ERROR_CATEGORIES.QUOTA || (status === 429 && quotaCheck.isQuota && /subscription|quota|credit|billing/i.test(`${body} ${rawMessage}`))) {
    return {
      errorCode: "quota_exceeded",
      category: ERROR_CATEGORIES.QUOTA,
      userMessage: quotaCheck.userMessage || localizedMsg(
        "Provider-Kontingent erschöpft (HTTP 429 / Quota). Bitte Tarif prüfen oder anderen Provider wählen.",
        "Provider quota exceeded (HTTP 429 / quota). Check billing or switch providers.",
      ),
    };
  }

  if (status === 429 || category === ERROR_CATEGORIES.RATE_LIMIT) {
    return {
      errorCode: "rate_limit_429",
      category: ERROR_CATEGORIES.RATE_LIMIT,
      userMessage: quotaCheck.userMessage || localizedMsg(
        "Rate-Limit erreicht (HTTP 429). Bitte kurz warten oder Fallback-Provider nutzen.",
        "Rate limit reached (HTTP 429). Wait briefly or configure a fallback provider.",
      ),
    };
  }

  if (category === ERROR_CATEGORIES.TIMEOUT) {
    return {
      errorCode: "timeout",
      category,
      userMessage: localizedMsg(
        "Zeitlimit überschritten — der Provider hat nicht rechtzeitig geantwortet.",
        "Request timed out before the provider answered.",
      ),
    };
  }

  if (category === ERROR_CATEGORIES.NETWORK) {
    if (isOllama || isLocalProfile(settings)) {
      const ep = resolveProfileEndpoint(settings) || CONFIG.AI_OLLAMA_HOST_DEFAULT;
      return {
        errorCode: "offline",
        category,
        userMessage: localizedMsg(
          `Lokaler Server unter ${ep} ist nicht erreichbar. Läuft der Dienst?`,
          `Local server at ${ep} is unreachable. Is the service running?`,
        ),
      };
    }
    return {
      errorCode: "network_error",
      category,
      userMessage: localizedMsg(
        `Netzwerkfehler beim Verbinden mit dem Provider: ${rawMessage}`,
        `Network error connecting to provider: ${rawMessage}`,
      ),
    };
  }

  return {
    errorCode: category || "request_failed",
    category,
    userMessage: rawMessage || localizedMsg("Provider-Anfrage fehlgeschlagen.", "Provider request failed."),
  };
};

const shouldFailoverToSecondary = (err, errorCode = "") => {
  if (!err && !errorCode) return false;
  if (err?.requiresSignIn || err?.code === "chatgpt_sign_in_required" || errorCode === "chatgpt_sign_in_required") {
    return true;
  }
  const category = err ? classifyProviderError(err?.status, err?.body, err) : "";
  if (category === ERROR_CATEGORIES.ABORT || errorCode === "aborted") return false;
  return (
    category === ERROR_CATEGORIES.QUOTA ||
    category === ERROR_CATEGORIES.RATE_LIMIT ||
    category === ERROR_CATEGORIES.TRANSIENT ||
    category === ERROR_CATEGORIES.NETWORK ||
    category === ERROR_CATEGORIES.TIMEOUT ||
    errorCode === "quota_exceeded" ||
    errorCode === "rate_limit_429" ||
    errorCode === "offline" ||
    errorCode === "network_error" ||
    errorCode === "timeout"
  );
};

const maybeNotify = (message, { silent = false, type = "warning", notices = null } = {}) => {
  if (!message) return;
  if (Array.isArray(notices)) notices.push({ message, type });
  if (!silent) showToast(message, { type });
};

/**
 * Validate that a parsed JSON object from the Fallback-LLM strictly conforms to
 * our expected tab-grouping schema for `tabCount` tabs.
 *
 * Accepted schemas:
 *   1. Structured array schema: `{ "assignments": [{ "id": 0, "group": "..." }, ...] }`
 *   2. Primary flat map: `{ "0": "Group Name", "1": "skipped", ... }`
 *   3. Structured groups object: `{ "groups": [{ "name": string, "tabs": number[] }], "skipped"?: number[] }`
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export const validateFallbackSchema = (parsed, tabCount) => {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Response is not a JSON object" };
  }

  if (Array.isArray(parsed.assignments)) {
    const seen = new Set();
    for (let idx = 0; idx < parsed.assignments.length; idx++) {
      const item = parsed.assignments[idx];
      if (!item || typeof item !== "object") {
        return { ok: false, error: `assignments[${idx}] is not an object` };
      }
      const id = Number(item.id);
      if (!Number.isInteger(id) || id < 0 || id >= tabCount) {
        return { ok: false, error: `assignments[${idx}].id must be an integer in 0..${tabCount - 1}` };
      }
      if (typeof item.group !== "string") {
        return { ok: false, error: `assignments[${idx}].group must be a string` };
      }
      const trimmed = stripMetaPrefix(item.group.trim());
      if (!trimmed || trimmed.length > 80) {
        return { ok: false, error: `assignments[${idx}].group must be a non-empty string (<= 80 chars)` };
      }
      seen.add(id);
    }
    for (let i = 0; i < tabCount; i++) {
      if (!seen.has(i)) {
        return { ok: false, error: `Missing required tab index key "${i}" (expected all keys "0".."${tabCount - 1}")` };
      }
    }
    return { ok: true };
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

const extractValidAssignmentsMap = (parsed, tabCount) => {
  const flat = parseAssignmentsResponse(parsed, tabCount);
  const valid = new Map();
  for (let i = 0; i < tabCount; i++) {
    const raw = flat[String(i)];
    if (typeof raw !== "string") continue;
    const cleaned = stripMetaPrefix(raw.trim());
    if (!cleaned || cleaned.length > 80) continue;
    valid.set(i, cleaned);
  }
  return valid;
};

/**
 * 2-step Provider Connection Test:
 *   (a) Resets reasoning & model caches, checks reachability + auth + `/models` count + latency
 *   (b) Runs a minimal `jsonMode: true` probe to confirm generation works end-to-end
 * Returns actionable localized DE/EN diagnostics per status code.
 */
export const testProviderConnection = async (
  settings = readProviderSettings(globalThis.Services?.prefs),
  { fetchImpl, signal = null, resetCache = true } = {},
) => {
  if (resetCache) {
    resetProviderReasoningCache();
    clearProviderModelCache();
  }
  const readiness = getProviderReadiness(settings);
  if (!readiness.ok) {
    const userMessage = readiness.reason === "consent_required"
      ? localizedMsg(
          "Bitte zuerst die Datenfreigabe in den KI-Einstellungen aktivieren.",
          "Allow sending tab data in AI Sorting first.",
        )
      : localizedMsg(
          `Provider-Einstellungen unvollständig: ${(readiness.missingFields || [readiness.reason]).join(", ")}.`,
          `Complete provider settings: ${(readiness.missingFields || [readiness.reason]).join(", ")}.`,
        );
    return {
      ok: false,
      reason: readiness.reason,
      errorCode: readiness.reason,
      userMessage,
      missingFields: readiness.missingFields || [],
    };
  }

  const startedAt = performance.now();
  const profile = readiness.value;
  const preset = getProviderPreset(profile.provider);
  let modelCount = null;
  let effectiveProfile = profile;

  try {
    if (profile.provider === "chatgpt") {
      const freshToken = await ensureValidChatGPTToken(
        globalThis.Services?.prefs,
        fetchImpl,
        profile,
        { signal },
      );
      effectiveProfile = { ...profile, accessToken: freshToken };
    }

    // Step (a): reachability + auth + /models count (non-fatal on 404 / unsupported)
    if (!preset || preset.supportsModelList !== false) {
      const catalog = await listProviderModels(effectiveProfile, {
        forceRefresh: true,
        signal,
        fetchImpl,
        timeoutMs: 8000,
      });
      if (catalog.ok) {
        modelCount = catalog.models.length;
      } else if (
        catalog.category === ERROR_CATEGORIES.AUTH ||
        catalog.category === ERROR_CATEGORIES.QUOTA ||
        catalog.category === ERROR_CATEGORIES.ABORT ||
        (catalog.category === ERROR_CATEGORIES.NETWORK && isLocalProfile(effectiveProfile))
      ) {
        const latencyMs = Math.round(performance.now() - startedAt);
        const formatted = formatActionableProviderError(
          { message: catalog.error, category: catalog.category, provider: effectiveProfile.provider },
          effectiveProfile,
        );
        return {
          ok: false,
          reason: "request_failed",
          errorCode: formatted.errorCode,
          error: catalog.error || formatted.userMessage,
          userMessage: formatted.userMessage,
          latencyMs,
        };
      }
    }

    // Step (b): minimal JSON probe
    const reply = await providerText(
      effectiveProfile,
      'Reply with JSON: {"ok":true}',
      16,
      fetchImpl,
      { jsonMode: true, signal },
    );
    const latencyMs = Math.round(performance.now() - startedAt);
    const reasoning = await getEffectiveReasoning(effectiveProfile, fetchImpl, 600, signal);
    let jsonValid = false;
    try {
      const parsed = JSON.parse(extractJsonObjectText(reply));
      jsonValid = Boolean(parsed && typeof parsed === "object");
    } catch {}

    return {
      ok: true,
      reply: reply.slice(0, 60),
      latencyMs,
      modelCount,
      jsonValid,
      reasoning: describeReasoningSelection(reasoning.preference, reasoning.capabilities, reasoning.effort),
    };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const formatted = formatActionableProviderError(e, effectiveProfile);
    return {
      ok: false,
      reason: "request_failed",
      errorCode: formatted.errorCode,
      status: e?.status || 0,
      error: e?.message || String(e),
      userMessage: formatted.userMessage,
      latencyMs,
    };
  }
};

const dedupeGroupsBeforeMinSize = (groups) => {
  if (!Array.isArray(groups) || groups.length === 0) return [];
  const byNorm = new Map();
  const out = [];
  for (const group of groups) {
    const clonedTabs = Array.isArray(group.tabs) ? [...group.tabs] : [];
    const norm = normalizeNameForDedupe(group.name);
    if (!norm) {
      out.push({ name: group.name, tabs: clonedTabs });
      continue;
    }
    if (byNorm.has(norm)) {
      out[byNorm.get(norm)].tabs.push(...clonedTabs);
      continue;
    }
    byNorm.set(norm, out.length);
    out.push({ name: group.name, tabs: clonedTabs });
  }
  return out;
};

const resolveCandidateFallbackChain = ({ fallbackSettings, fallbackChain, taskProfile, prefs }) => {
  if (Array.isArray(fallbackChain) && fallbackChain.length > 0) {
    return fallbackChain.filter((item) => item && item.provider !== "off" && item.provider !== "none");
  }
  if (taskProfile) {
    const taskSettings = getTaskProfile(taskProfile, prefs);
    const chain = getFallbackChain(prefs);
    const merged = [taskSettings, ...chain].filter((item) => item && item.provider !== "off" && item.provider !== "none");
    const seen = new Set();
    return merged.filter((item) => {
      const k = `${item.id || item.provider}\0${resolveProfileEndpoint(item)}\0${item.model || ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (fallbackSettings) {
    const configuredChain = prefs ? getFallbackChain(prefs) : [];
    if (configuredChain.length > 1) {
      const primaryKey = `${fallbackSettings.id || fallbackSettings.provider}\0${resolveProfileEndpoint(fallbackSettings)}\0${fallbackSettings.model || ""}`;
      const rest = configuredChain.filter(
        (item) => `${item.id || item.provider}\0${resolveProfileEndpoint(item)}\0${item.model || ""}` !== primaryKey,
      );
      return [fallbackSettings, ...rest];
    }
    return [fallbackSettings];
  }
  const chain = getFallbackChain(prefs);
  return chain.length > 0 ? chain : [readFallbackProviderSettings(prefs)];
};

const runOneShotChunkWithProvider = async ({
  providerSettings,
  chunkTabs,
  chunkSnippets,
  chunkHintsByIndex,
  existingGroupNames,
  allowExistingGroups,
  establishedGroups,
  workspaceName,
  locale,
  maxAttempts,
  fetchImpl,
  hardDeadline,
  timeBudgetMs,
  signal,
}) => {
  const preset = getProviderPreset(providerSettings.provider);
  const useStructuredSchema = Boolean(preset ? preset.supportsJsonSchema !== false : true);
  const baseMessages = buildOneShotNewGroupsMessages(
    chunkTabs,
    chunkSnippets,
    existingGroupNames,
    {
      allowExistingGroups,
      establishedGroups,
      workspaceName,
      locale,
      jevHintsByIndex: chunkHintsByIndex,
      useStructuredSchema: false,
    },
  );
  const remainingMs = () => hardDeadline - Date.now();

  let validMap = null;
  let lastError = "";
  let lastException = null;
  let attemptsUsed = 0;
  let budgetHit = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new ProviderHttpError({ category: ERROR_CATEGORIES.ABORT, message: "Request aborted" });
    }
    if (remainingMs() < 800) {
      budgetHit = true;
      if (attempt === 1) {
        lastError = `time budget of ${Math.round(timeBudgetMs / 1000)}s exhausted before the model answered`;
      }
      break;
    }
    attemptsUsed = attempt;
    let currentPrompt = baseMessages;
    if (attempt > 1) {
      const retryMsgs = buildOneShotSchemaRetryMessages(baseMessages, lastError, attempt, chunkTabs.length);
      const retryHeader = `IMPORTANT — RETRY ATTEMPT ${attempt}/${maxAttempts} (PREVIOUS RESPONSE FAILED SCHEMA VALIDATION):\nReason: ${lastError}`;
      currentPrompt = {
        system: `${retryMsgs.system}\n\n${retryHeader}`,
        user: retryMsgs.user,
      };
    }

    try {
      const candidate = await providerJson(
        providerSettings,
        currentPrompt,
        PROVIDER_JSON_MAX_TOKENS,
        fetchImpl,
        {
          timeoutMs: remainingMs(),
          signal,
          deadlineAt: hardDeadline,
          ...(useStructuredSchema && attempt === 1 ? { jsonSchema: ASSIGNMENTS_JSON_SCHEMA } : {}),
        },
      );
      const validation = validateFallbackSchema(candidate, chunkTabs.length);
      if (validation.ok) {
        validMap = extractValidAssignmentsMap(candidate, chunkTabs.length);
        lastError = "";
        break;
      }

      // Partial-valid recovery: keep >=80% valid indices on >=5-tab chunks and
      // run a tiny delta-repair call only for the missing indices.
      const partial = extractValidAssignmentsMap(candidate, chunkTabs.length);
      if (
        chunkTabs.length >= PARTIAL_RECOVERY_MIN_TABS &&
        partial.size / chunkTabs.length >= PARTIAL_RECOVERY_MIN_RATIO
      ) {
        const missingIndices = [];
        for (let i = 0; i < chunkTabs.length; i++) {
          if (!partial.has(i)) missingIndices.push(i);
        }
        if (missingIndices.length > 0 && remainingMs() >= 1200 && !signal?.aborted) {
          const discoveredNames = [
            ...new Set([
              ...establishedGroups,
              ...[...partial.values()].filter((name) => {
                const l = name.toLowerCase();
                return l !== "skipped" && l !== "none" && !isCatchAllGroupName(name);
              }),
            ]),
          ];
          const missingTabs = missingIndices.map((i) => chunkTabs[i]);
          const missingSnippets = missingIndices.map((i) => chunkSnippets[i] || "");
          const deltaMessages = buildOneShotNewGroupsMessages(
            missingTabs,
            missingSnippets,
            existingGroupNames,
            {
              allowExistingGroups,
              establishedGroups: discoveredNames,
              workspaceName,
              locale,
              useStructuredSchema: false,
            },
          );
          try {
            const deltaCandidate = await providerJson(
              providerSettings,
              deltaMessages,
              Math.min(1024, PROVIDER_JSON_MAX_TOKENS),
              fetchImpl,
              { timeoutMs: remainingMs(), signal, deadlineAt: hardDeadline },
            );
            const deltaValid = extractValidAssignmentsMap(deltaCandidate, missingTabs.length);
            for (const [localIdx, label] of deltaValid.entries()) {
              partial.set(missingIndices[localIdx], label);
            }
          } catch (deltaErr) {
            recordDebugEvent("STAGE-2-DELTA-REPAIR-SKIP", `Delta repair skipped: ${deltaErr?.message || deltaErr}`);
          }
        }
        validMap = partial;
        lastError = "";
        break;
      }

      lastError = validation.error;
      console.warn(`${LOG} Fallback-LLM attempt ${attempt}/${maxAttempts} failed schema check: ${lastError}`);
    } catch (e) {
      lastException = e;
      lastError = e?.message || String(e);
      const category = classifyProviderError(e?.status, e?.body, e);
      if (category === ERROR_CATEGORIES.ABORT) throw e;
      if (e?.requiresSignIn || e?.code === "chatgpt_sign_in_required") {
        return { ok: false, error: e, errorCode: e.code || "chatgpt_sign_in_required", failedMessage: lastError, attempts: attempt };
      }
      recordDebugEvent("STAGE-2-ERROR", `Attempt ${attempt}/${maxAttempts} error: ${lastError}`);
      const quotaCheck = detectQuotaOrRateLimit(e?.status, e?.body, lastError);
      if (category === ERROR_CATEGORIES.QUOTA || quotaCheck.isQuota) {
        return {
          ok: false,
          error: e,
          errorCode: "quota_exceeded",
          failedMessage: quotaCheck.userMessage || formatActionableProviderError(e, providerSettings).userMessage,
          attempts: attempt,
        };
      }
      if (category === ERROR_CATEGORIES.AUTH || category === ERROR_CATEGORIES.NOT_FOUND) {
        const formatted = formatActionableProviderError(e, providerSettings);
        return {
          ok: false,
          error: e,
          errorCode: formatted.errorCode,
          failedMessage: formatted.userMessage,
          attempts: attempt,
        };
      }
      console.warn(`${LOG} Fallback-LLM attempt ${attempt}/${maxAttempts} failed: ${lastError}`);
    }
  }

  if (validMap) {
    return { ok: true, validMap, attempts: attemptsUsed };
  }
  return {
    ok: false,
    budgetHit,
    error: lastException,
    errorCode: budgetHit ? "time_budget_exceeded" : `schema_validation_failed: ${lastError}`,
    lastError,
    attempts: attemptsUsed,
  };
};

// Stage 2: One-Shot Fallback-LLM for tabs that JEV did not confidently place into
// an existing workspace group (or all ungrouped tabs when 0 groups exist).
// Supports token-aware chunking, establishedGroups continuity, JEV top-2 rescue
// hints, partial-valid (>=80%) delta-repair, catch-all denylist, deduplication
// before minGroupSize, and automatic Fallback Chain failover.
export const runOneShotFallbackNewGroups = async ({
  leftoverTabs,
  snippets = [],
  existingGroupNames = [],
  fallbackSettings,
  fallbackChain = null,
  taskProfile = null,
  minGroupSize = FALLBACK_MIN_NEW_GROUP_TABS,
  maxAttempts = MAX_FALLBACK_SCHEMA_ATTEMPTS,
  fetchImpl,
  deadlineAt,
  timeBudgetMs,
  signal = null,
  silent = false,
  allowExistingGroups = false,
  jevHintsByIndex = null,
  workspaceName = "",
  locale = getLocale(),
}) => {
  const notices = [];
  if (!Array.isArray(leftoverTabs) || leftoverTabs.length === 0) {
    return { ok: true, newGroups: [], rescuedExisting: [], skipped: [], notices };
  }

  const prefs = globalThis.Services?.prefs;
  const resolvedFallback = fallbackSettings !== undefined
    ? fallbackSettings
    : readFallbackProviderSettings(prefs);

  if (resolvedFallback?.provider === "off" || resolvedFallback?.provider === "none") {
    recordDebugEvent("STAGE-2-FALLBACK", "Fallback-LLM ist ausgeschaltet; überspringe neue Gruppen.");
    return { ok: true, newGroups: [], rescuedExisting: [], skipped: [...leftoverTabs], notices };
  }

  if (!allowExistingGroups && leftoverTabs.length < minGroupSize) {
    return { ok: true, newGroups: [], rescuedExisting: [], skipped: [...leftoverTabs], notices };
  }

  if (signal?.aborted) {
    return {
      ok: false,
      newGroups: [],
      rescuedExisting: [],
      skipped: [...leftoverTabs],
      failed: "aborted",
      errorCode: "aborted",
      userMessage: localizedMsg("Sortierung abgebrochen.", "Sorting cancelled."),
      notices,
    };
  }

  const candidateChain = resolveCandidateFallbackChain({
    fallbackSettings: resolvedFallback,
    fallbackChain,
    taskProfile,
    prefs,
  });

  const existingCanonicalByLower = new Map();
  for (const name of existingGroupNames || []) {
    const clean = String(name || "").trim();
    if (clean) existingCanonicalByLower.set(clean.toLowerCase(), clean);
  }

  // Deduplicate identical tabs before chunking and fan assignments back out.
  const { deduped, origToDeduped } = dedupeTabs(leftoverTabs);
  const dedupedSnippets = deduped.map((_, dIdx) => {
    for (let i = 0; i < origToDeduped.length; i++) {
      if (origToDeduped[i] === dIdx && snippets?.[i]) return snippets[i];
    }
    return "";
  });
  const dedupedHints = Array.isArray(jevHintsByIndex)
    ? deduped.map((_, dIdx) => {
        for (let i = 0; i < origToDeduped.length; i++) {
          if (origToDeduped[i] === dIdx && Array.isArray(jevHintsByIndex[i]) && jevHintsByIndex[i].length > 0) {
            return jevHintsByIndex[i];
          }
        }
        return [];
      })
    : null;

  const chunks = chunkTabsByBudget(deduped, {
    maxTabs: STAGE2_CHUNK_MAX_TABS,
    maxInputTokens: STAGE2_CHUNK_MAX_INPUT_TOKENS,
    snippets: dedupedSnippets,
  });

  let lastFailureResult = null;
  let totalAttempts = 0;

  for (let providerIdx = 0; providerIdx < candidateChain.length; providerIdx++) {
    const candidateSettings = candidateChain[providerIdx];
    const hasNextProvider = providerIdx + 1 < candidateChain.length;
    const readiness = getProviderReadiness(candidateSettings);

    if (!readiness.ok) {
      if (candidateSettings?.provider === "chatgpt" && readiness.missingFields?.includes("accessToken")) {
        const error = new ChatGPTSignInRequiredError();
        if (hasNextProvider) {
          recordDebugEvent("STAGE-2-FAILOVER", `Primary provider chatgpt not signed in; trying secondary provider.`);
          continue;
        }
        maybeNotify(error.message, { silent, type: "warning", notices });
        return {
          ok: false,
          newGroups: [],
          rescuedExisting: [],
          skipped: [...leftoverTabs],
          failed: error.code,
          errorCode: error.code,
          failedMessage: error.message,
          userMessage: error.message,
          notices,
        };
      }
      const msg = readiness.reason === "consent_required"
        ? localizedMsg(
            "Fallback-LLM benötigt Daten-Freigabe (Consent Checkbox) in den Einstellungen.",
            "Fallback LLM requires data-sending consent in settings.",
          )
        : localizedMsg(
            `Fallback-LLM (${candidateSettings?.provider || "unknown"}) ist nicht bereit: ${readiness.reason}`,
            `Fallback LLM (${candidateSettings?.provider || "unknown"}) is not ready: ${readiness.reason}`,
          );
      if (hasNextProvider) {
        recordDebugEvent("STAGE-2-FAILOVER", `Skipping unready provider ${candidateSettings?.provider}: ${readiness.reason}`);
        continue;
      }
      maybeNotify(msg, { silent, type: "warning", notices });
      return {
        ok: false,
        newGroups: [],
        rescuedExisting: [],
        skipped: [...leftoverTabs],
        failed: readiness.reason,
        errorCode: readiness.reason,
        failedMessage: msg,
        userMessage: msg,
        notices,
      };
    }

    const effectiveBudgetMs = Number.isFinite(timeBudgetMs)
      ? timeBudgetMs
      : resolveEffectiveTimeBudgetMs(readiness.value, prefs);
    const passStartedAt = Date.now();
    const hardDeadline = Number.isFinite(deadlineAt)
      ? deadlineAt
      : passStartedAt + Math.max(3000, effectiveBudgetMs);

    const assignedByDedupedIdx = new Map();
    const establishedGroups = [];
    const establishedLower = new Set();
    let providerFailed = null;
    let providerAttempts = 0;

    for (const chunk of chunks) {
      const chunkHints = dedupedHints
        ? chunk.tabs.map((_, i) => dedupedHints[chunk.start + i] || [])
        : null;

      let chunkRes;
      try {
        chunkRes = await runOneShotChunkWithProvider({
          providerSettings: readiness.value,
          chunkTabs: chunk.tabs,
          chunkSnippets: chunk.snippets,
          chunkHintsByIndex: chunkHints,
          existingGroupNames,
          allowExistingGroups,
          establishedGroups,
          workspaceName,
          locale,
          maxAttempts,
          fetchImpl,
          hardDeadline,
          timeBudgetMs: effectiveBudgetMs,
          signal,
        });
      } catch (e) {
        if (classifyProviderError(e?.status, e?.body, e) === ERROR_CATEGORIES.ABORT) {
          return {
            ok: false,
            newGroups: [],
            rescuedExisting: [],
            skipped: [...leftoverTabs],
            failed: "aborted",
            errorCode: "aborted",
            userMessage: localizedMsg("Sortierung abgebrochen.", "Sorting cancelled."),
            notices,
          };
        }
        chunkRes = { ok: false, error: e, errorCode: "request_failed", failedMessage: e?.message || String(e), attempts: 1 };
      }

      providerAttempts += chunkRes.attempts || 0;
      totalAttempts = providerAttempts;

      if (!chunkRes.ok) {
        providerFailed = chunkRes;
        break;
      }

      for (const [localIdx, label] of chunkRes.validMap.entries()) {
        assignedByDedupedIdx.set(chunk.start + localIdx, label);
        const lower = label.toLowerCase();
        if (
          lower !== "skipped" &&
          lower !== "none" &&
          !isCatchAllGroupName(label) &&
          !existingCanonicalByLower.has(lower) &&
          !establishedLower.has(lower)
        ) {
          establishedLower.add(lower);
          establishedGroups.push(label);
        }
      }
    }

    const stageTwoMs = Date.now() - passStartedAt;
    recordDebugEvent(
      "STAGE-2-TIMING",
      `Fallback-LLM (${readiness.value.provider}) finished in ${stageTwoMs}ms after ${providerAttempts} attempt(s)${providerFailed?.budgetHit ? " (time budget hit)" : ""}`,
      { attempts: providerAttempts, budgetHit: Boolean(providerFailed?.budgetHit), ms: stageTwoMs, tabs: leftoverTabs.length, model: readiness.value?.model },
    );

    if (providerFailed && assignedByDedupedIdx.size === 0) {
      if (hasNextProvider && shouldFailoverToSecondary(providerFailed.error, providerFailed.errorCode)) {
        const nextProvider = candidateChain[providerIdx + 1];
        recordDebugEvent(
          "STAGE-2-FAILOVER",
          `Provider ${readiness.value.provider} failed (${providerFailed.errorCode}); failing over to ${nextProvider.provider}.`,
        );
        lastFailureResult = providerFailed;
        continue;
      }

      if (providerFailed.budgetHit) {
        const budgetMessage = localizedMsg(
          `Zeitlimit von ${Math.round(effectiveBudgetMs / 1000)}s erreicht — ${leftoverTabs.length} Tab(s) bleiben ungruppiert.`,
          `Time limit of ${Math.round(effectiveBudgetMs / 1000)}s reached — ${leftoverTabs.length} tab(s) stay ungrouped.`,
        );
        recordDebugEvent("STAGE-2-BUDGET", budgetMessage);
        maybeNotify(budgetMessage, { silent, type: "info", notices });
        return {
          ok: false,
          newGroups: [],
          rescuedExisting: [],
          skipped: [...leftoverTabs],
          failed: "time_budget_exceeded",
          errorCode: "time_budget_exceeded",
          failedMessage: budgetMessage,
          userMessage: budgetMessage,
          attempts: providerAttempts,
          notices,
        };
      }

      if (providerFailed.errorCode === "chatgpt_sign_in_required" || providerFailed.errorCode === "quota_exceeded") {
        const msg = providerFailed.failedMessage || formatActionableProviderError(providerFailed.error, readiness.value).userMessage;
        maybeNotify(msg, { silent, type: "warning", notices });
        return {
          ok: false,
          newGroups: [],
          rescuedExisting: [],
          skipped: [...leftoverTabs],
          failed: providerFailed.errorCode,
          errorCode: providerFailed.errorCode,
          failedMessage: msg,
          userMessage: msg,
          attempts: providerAttempts,
          notices,
        };
      }

      const userMessage = providerFailed.failedMessage || localizedMsg(
        `Fallback-LLM Schema-Fehler nach ${providerAttempts} Versuchen (${providerFailed.lastError}). Übrige Tabs bleiben ungruppiert.`,
        `Fallback LLM schema error after ${providerAttempts} attempts (${providerFailed.lastError}). Remaining tabs stay ungrouped.`,
      );
      console.error(`${LOG} ${userMessage}`);
      maybeNotify(userMessage, { silent, type: "warning", notices });
      return {
        ok: false,
        newGroups: [],
        rescuedExisting: [],
        skipped: [...leftoverTabs],
        failed: providerFailed.errorCode || `schema_validation_failed: ${providerFailed.lastError}`,
        errorCode: providerFailed.errorCode || "schema_validation_failed",
        failedMessage: userMessage,
        userMessage,
        attempts: providerAttempts,
        notices,
      };
    }

    // Track recently used model on success
    try {
      if (readiness.value?.model) {
        recordRecentModel({ provider: readiness.value.provider, model: readiness.value.model }, prefs);
      }
    } catch {}

    // Fan assignments back out to original leftoverTabs
    const groupsByLower = new Map();
    const rescuedExisting = [];
    const skipped = [];

    for (let i = 0; i < leftoverTabs.length; i++) {
      const rawVal = assignedByDedupedIdx.get(origToDeduped[i]);
      const cleaned = stripMetaPrefix(rawVal == null ? "" : String(rawVal).trim());
      const lower = cleaned.toLowerCase();

      if (!cleaned || lower === "skipped" || lower === "none" || isCatchAllGroupName(cleaned)) {
        skipped.push(leftoverTabs[i]);
        continue;
      }

      const existingCanonical = existingCanonicalByLower.get(lower);
      if (existingCanonical) {
        if (allowExistingGroups) {
          rescuedExisting.push({ tabInfo: leftoverTabs[i], groupName: existingCanonical, similarity: 0.75 });
        } else {
          skipped.push(leftoverTabs[i]);
        }
        continue;
      }

      if (!groupsByLower.has(lower)) {
        groupsByLower.set(lower, { name: cleaned, tabs: [] });
      }
      groupsByLower.get(lower).tabs.push(leftoverTabs[i]);
    }

    // Run similar-name deduplication BEFORE minGroupSize filtering so synonymous
    // buckets across chunks combine before singletons are demoted!
    const dedupedGroups = dedupeGroupsBeforeMinSize([...groupsByLower.values()]);

    const newGroups = [];
    for (const group of dedupedGroups) {
      if (group.tabs.length < minGroupSize) {
        skipped.push(...group.tabs);
      } else {
        newGroups.push(group);
      }
    }

    return {
      ok: true,
      newGroups,
      rescuedExisting,
      skipped,
      attempts: providerAttempts,
      providerUsed: readiness.value.provider,
      modelUsed: readiness.value.model,
      notices,
    };
  }

  const fallbackErr = lastFailureResult?.failedMessage || localizedMsg(
    "Kein verfügbarer Fallback-LLM Provider in der Kette.",
    "No available fallback LLM provider in chain.",
  );
  maybeNotify(fallbackErr, { silent, type: "warning", notices });
  return {
    ok: false,
    newGroups: [],
    rescuedExisting: [],
    skipped: [...leftoverTabs],
    failed: lastFailureResult?.errorCode || "no_provider_available",
    errorCode: lastFailureResult?.errorCode || "no_provider_available",
    failedMessage: fallbackErr,
    userMessage: fallbackErr,
    attempts: totalAttempts,
    notices,
  };
};

// Complete 2-stage JEV + One-Shot Fallback-LLM pipeline:
export const runPass2JevHybrid = async (
  unmatchedTabs,
  existingGroups = [],
  {
    jevSettings = readJevSettings(globalThis.Services?.prefs),
    fallbackSettings,
    fallbackChain = null,
    taskProfile = null,
    minGroupSize = FALLBACK_MIN_NEW_GROUP_TABS,
    maxAttempts = MAX_FALLBACK_SCHEMA_ATTEMPTS,
    fetchImpl,
    preFetchedSnippets,
    deadlineAt,
    timeBudgetMs,
    signal = null,
    stage1Only = false,
    silent = false,
    isFreshMode = false,
    workspaceName = "",
    locale = getLocale(),
  } = {},
) => {
  const notices = [];
  const empty = { ok: true, assignedToExisting: [], newGroups: [], skipped: [], notices };
  if (!Array.isArray(unmatchedTabs) || unmatchedTabs.length === 0) return empty;
  if (signal?.aborted) {
    return {
      ok: false,
      assignedToExisting: [],
      newGroups: [],
      skipped: [...unmatchedTabs],
      failed: "aborted",
      errorCode: "aborted",
      userMessage: localizedMsg("Sortierung abgebrochen.", "Sorting cancelled."),
      notices,
    };
  }

  const prefs = globalThis.Services?.prefs;
  const resolvedFallback = fallbackSettings !== undefined
    ? fallbackSettings
    : readFallbackProviderSettings(prefs);

  const validExistingGroups = !isFreshMode && Array.isArray(existingGroups)
    ? existingGroups.filter((g) => g && typeof g.name === "string" && g.name.trim())
    : [];

  // Early-exit BEFORE snippet fetch when there are no existing groups and too
  // few tabs to form even one new group!
  if (validExistingGroups.length === 0 && unmatchedTabs.length < minGroupSize) {
    return { ok: true, assignedToExisting: [], newGroups: [], skipped: [...unmatchedTabs], notices };
  }

  // Also early-exit if stage1Only has no existing groups to classify into
  if (stage1Only && validExistingGroups.length === 0) {
    return { ok: true, assignedToExisting: [], newGroups: [], skipped: [...unmatchedTabs], notices };
  }

  const effectiveBudgetMs = Number.isFinite(timeBudgetMs)
    ? timeBudgetMs
    : resolveEffectiveTimeBudgetMs(resolvedFallback, prefs);
  const hybridStartedAt = Date.now();
  const hybridDeadline = Number.isFinite(deadlineAt)
    ? deadlineAt
    : hybridStartedAt + Math.max(3000, effectiveBudgetMs);

  // Deduplicate tabs before snippet fetch so duplicate open tabs only fetch once
  const { deduped, origToDeduped } = dedupeTabs(unmatchedTabs);
  let snippets;
  if (Array.isArray(preFetchedSnippets)) {
    snippets = preFetchedSnippets;
  } else {
    const dedupedSnippets = await fetchSnippets(deduped, "jev-hybrid", { signal });
    snippets = unmatchedTabs.map((_, i) => dedupedSnippets[origToDeduped[i]] || "");
  }

  if (signal?.aborted) {
    return {
      ok: false,
      assignedToExisting: [],
      newGroups: [],
      skipped: [...unmatchedTabs],
      failed: "aborted",
      errorCode: "aborted",
      userMessage: localizedMsg("Sortierung abgebrochen.", "Sorting cancelled."),
      notices,
    };
  }

  let assignedToExisting = [];
  let leftoverTabs = [...unmatchedTabs];
  let leftoverSnippets = [...snippets];
  let leftoverCandidates = unmatchedTabs.map(() => []);
  let stage1FailedOrSkipped = false;

  const fallbackReadiness = !stage1Only && resolvedFallback?.provider && !["off", "none"].includes(resolvedFallback.provider)
    ? getProviderReadiness(resolvedFallback)
    : null;
  const shouldWarmupReasoning = Boolean(
    fallbackReadiness?.ok && getProviderKind(fallbackReadiness.value) === "openai",
  );
  let reasoningWarmup = null;

  // Stage 1: JEV Decision Model (only when existing groups are present and not fresh mode)
  if (validExistingGroups.length > 0) {
    if (!jevSettings.consentToSendData) {
      const msg = localizedMsg(
        "Daten-Freigabe (Consent Checkbox) in den Zen Tab Sorting Einstellungen erforderlich.",
        "Data-sending consent is required in Zen Tab Sorting settings.",
      );
      recordDebugEvent("STAGE-1-ERROR", msg);
      maybeNotify(msg, { silent, type: "warning", notices });
      return {
        ok: false,
        assignedToExisting: [],
        newGroups: [],
        skipped: [...unmatchedTabs],
        failed: "consent_required",
        errorCode: "consent_required",
        userMessage: msg,
        notices,
      };
    }
    if (jevSettings.apiKey && jevSettings.apiKey.trim()) {
      try {
        if (shouldWarmupReasoning) {
          reasoningWarmup = getEffectiveReasoning(
            fallbackReadiness.value,
            fetchImpl,
            Math.min(MODEL_CAPABILITY_TIMEOUT_MS, Math.max(400, hybridDeadline - Date.now())),
            signal,
          ).catch(() => null);
        }
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
          deadlineAt: hybridDeadline,
          signal,
          workspaceContext: workspaceName ? { workspaceName } : null,
        });
        assignedToExisting = jevResult.assignedToExisting;
        leftoverTabs = jevResult.leftoverTabs;
        leftoverSnippets = jevResult.leftoverSnippets;
        leftoverCandidates = Array.isArray(jevResult.leftoverCandidates)
          ? jevResult.leftoverCandidates
          : leftoverTabs.map(() => []);
        if (leftoverTabs.some((t) => t?.jevSkipped)) {
          stage1FailedOrSkipped = true;
        }
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
        if (e?.name === "AbortError" || signal?.aborted) {
          return {
            ok: false,
            assignedToExisting: [],
            newGroups: [],
            skipped: [...unmatchedTabs],
            failed: "aborted",
            errorCode: "aborted",
            userMessage: localizedMsg("Sortierung abgebrochen.", "Sorting cancelled."),
            notices,
          };
        }
        stage1FailedOrSkipped = true;
        recordDebugEvent("STAGE-1-JEV-ERROR", `JEV Stage 1 error: ${e.message || e}`);
        console.error(`${LOG} JEV Stage 1 failed, falling through to Fallback-LLM:`, e);
        maybeNotify(
          localizedMsg(
            `JEV Fehler (Stufe 1): ${e.message || e} — übergebe an Fallback-LLM.`,
            `Jev error (Stage 1): ${e.message || e} — handing off to Fallback LLM.`,
          ),
          { silent, type: "warning", notices },
        );
      }
    } else {
      stage1FailedOrSkipped = true;
      recordDebugEvent("STAGE-1-ERROR", "JEV Stufe 1: API-Key fehlt in den Einstellungen; übergebe Tabs an Fallback-LLM.");
      console.warn(`${LOG} JEV key not configured; skipping Stage 1 and sending tabs to Fallback-LLM`);
      maybeNotify(
        localizedMsg(
          "JEV API-Key fehlt in den Einstellungen (Zen Tab Sorting).",
          "Jev API key is missing in Zen Tab Sorting settings.",
        ),
        { silent, type: "warning", notices },
      );
    }
  } else {
    recordDebugEvent("STAGE-1-SKIPPED", `JEV Stufe 1 übersprungen: Keine bestehenden Ordner im Workspace gefunden; übergebe ${leftoverTabs.length} Tab(s) an Fallback-LLM.`);
    console.log(`${LOG} JEV Stage 1 skipped: no existing groups in workspace; sending ${leftoverTabs.length} tab(s) to Fallback-LLM`);
  }

  // Stage 1 only mode (e.g. Preview Modal "Re-assign to planned/existing"):
  // NEVER fire Stage-2 LLM calls!
  if (stage1Only) {
    return {
      ok: true,
      assignedToExisting,
      newGroups: [],
      skipped: leftoverTabs,
      notices,
    };
  }

  // Stage 2: One-Shot Fallback-LLM for remaining ungrouped tabs
  if (leftoverTabs.length === 0) {
    recordDebugEvent("HYBRID-COMPLETE", "Alle Tabs wurden durch JEV Stufe 1 zugeordnet.");
    return { ok: true, assignedToExisting, newGroups: [], skipped: [], notices };
  }

  if (resolvedFallback?.provider === "off" || resolvedFallback?.provider === "none") {
    recordDebugEvent("STAGE-2-FALLBACK-OFF", "Fallback-LLM ist ausgeschaltet (off).");
    const msg = assignedToExisting.length > 0
      ? localizedMsg(
          `JEV: ${assignedToExisting.length} Tab(s) in bestehende Ordner einsortiert (Fallback deaktiviert).`,
          `Jev: sorted ${assignedToExisting.length} tab(s) into existing groups (Fallback disabled).`,
        )
      : localizedMsg(
          "JEV: Keine Tabs passten in bestehende Ordner (Fallback deaktiviert).",
          "Jev: no tabs matched existing groups (Fallback disabled).",
        );
    maybeNotify(msg, { silent, type: "info", notices });
    return { ok: true, assignedToExisting, newGroups: [], skipped: leftoverTabs, notices };
  }

  try {
    if (reasoningWarmup) await reasoningWarmup;
    const existingGroupNames = validExistingGroups.map((g) => g.name);
    const hasJevHints = leftoverCandidates.some((c) => Array.isArray(c) && c.length > 0);
    const allowExistingRescue = validExistingGroups.length > 0 && (stage1FailedOrSkipped || hasJevHints);

    const stage2 = await runOneShotFallbackNewGroups({
      leftoverTabs,
      snippets: leftoverSnippets,
      existingGroupNames,
      fallbackSettings: resolvedFallback,
      fallbackChain,
      taskProfile,
      minGroupSize,
      maxAttempts,
      fetchImpl,
      deadlineAt: hybridDeadline,
      timeBudgetMs: effectiveBudgetMs,
      signal,
      silent,
      allowExistingGroups: allowExistingRescue,
      jevHintsByIndex: hasJevHints ? leftoverCandidates : null,
      workspaceName,
      locale,
    });
    if (Array.isArray(stage2.notices)) notices.push(...stage2.notices);

    const mergedExisting = [
      ...assignedToExisting,
      ...(Array.isArray(stage2.rescuedExisting) ? stage2.rescuedExisting : []),
    ];

    console.log(
      `${LOG} Fallback-LLM Stage 2: created ${stage2.newGroups.length} new group(s), rescued ${stage2.rescuedExisting?.length || 0} to existing, skipped ${stage2.skipped.length} outlier tab(s)`,
    );

    if (stage2.failed) {
      const fallbackMsg = stage2.failedMessage || `Fallback-LLM nicht verfügbar (${stage2.failed})`;
      recordDebugEvent("STAGE-2-FALLBACK-ABORTED", `${fallbackMsg} — Bleibe im JEV-Modus: ${mergedExisting.length} Tab(s) zugeordnet, restliche Tabs bleiben ungruppiert.`);
      if (mergedExisting.length > 0 && stage2.failed !== "aborted") {
        maybeNotify(
          localizedMsg(
            `Fallback nicht verfügbar: ${mergedExisting.length} Tab(s) in bestehende Ordner sortiert. Restliche Tabs bleiben ungruppiert.`,
            `Fallback unavailable: sorted ${mergedExisting.length} tab(s) into existing groups. Remaining tabs stay ungrouped.`,
          ),
          { silent, type: "info", notices },
        );
      }
    }

    return {
      ok: !stage2.failed || mergedExisting.length > 0,
      assignedToExisting: mergedExisting,
      newGroups: stage2.newGroups,
      skipped: stage2.skipped,
      notices,
      ...(stage2.failed ? { failed: stage2.failed, errorCode: stage2.errorCode || stage2.failed, failedMessage: stage2.failedMessage, userMessage: stage2.userMessage || stage2.failedMessage } : {}),
      ...(stage2.attempts ? { attempts: stage2.attempts } : {}),
    };
  } catch (e) {
    recordDebugEvent("STAGE-2-ERROR", `Fallback-LLM Stage 2 exception: ${e.message || e}`);
    console.error(`${LOG} Fallback-LLM Stage 2 failed:`, e);
    const formatted = formatActionableProviderError(e, resolvedFallback);
    maybeNotify(formatted.userMessage, { silent, type: "warning", notices });
    recordDebugEvent("STAGE-2-FALLBACK-ABORTED", `${formatted.userMessage} — Bleibe im reinen JEV-Modus: ${assignedToExisting.length} Tab(s) zugeordnet.`);
    if (assignedToExisting.length > 0 && formatted.errorCode !== "aborted") {
      maybeNotify(
        localizedMsg(
          `Fallback-LLM nicht verfügbar: ${assignedToExisting.length} Tab(s) durch JEV sortiert, restliche Tabs bleiben ungruppiert.`,
          `Fallback LLM unavailable: sorted ${assignedToExisting.length} tab(s) with Jev; remaining tabs stay ungrouped.`,
        ),
        { silent, type: "info", notices },
      );
    }
    return {
      ok: false,
      assignedToExisting,
      newGroups: [],
      skipped: leftoverTabs,
      failed: e.message || String(e),
      errorCode: formatted.errorCode,
      failedMessage: formatted.userMessage,
      userMessage: formatted.userMessage,
      notices,
    };
  }
};

export const classifyExistingGroupsRemoteBatch = async (
  pendingTabs,
  rules,
  settings = readProviderSettings(globalThis.Services?.prefs),
  { signal = null, deadlineAt = null, silent = false, fetchImpl } = {},
) => {
  if (!pendingTabs?.length || !rules?.length) return new Map();
  const readiness = getProviderReadiness(settings);
  if (!readiness.ok) {
    maybeNotify(
      readiness.reason === "consent_required"
        ? localizedMsg("Remote-Provider benötigt Datenfreigabe vor dem Sortieren.", "Remote provider needs data-sending consent before sorting.")
        : localizedMsg(`Remote-Provider nicht bereit: ${readiness.reason}`, `Remote provider is not ready: ${readiness.reason}`),
      { silent, type: "warning" },
    );
    return skippedMap(pendingTabs);
  }

  const namesByLower = new Map(rules.map((r) => r?.name).filter(Boolean).map((name) => [name.toLowerCase(), name]));
  const out = new Map();

  for (const chunk of chunkTabsForProvider(pendingTabs)) {
    if (signal?.aborted) break;
    const parsed = await providerJson(
      readiness.value,
      buildClassifyPrompt(rules, chunk.tabs),
      PROVIDER_JSON_MAX_TOKENS,
      fetchImpl,
      { signal, deadlineAt },
    );
    const flat = parseAssignmentsResponse(parsed, chunk.tabs.length);
    for (const [key, value] of Object.entries(flat)) {
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

export const runPass2Remote = async (
  unmatched,
  rules,
  settings = readProviderSettings(globalThis.Services?.prefs),
  { signal = null, deadlineAt = null, silent = false, fetchImpl } = {},
) => {
  const notices = [];
  const empty = { ok: true, assignedToExisting: [], newGroups: [], skipped: [], notices };
  if (!unmatched?.length) return empty;

  try {
    const readiness = getProviderReadiness(settings);
    if (!readiness.ok) {
      const message = readiness.reason === "consent_required"
        ? localizedMsg("Remote-Provider benötigt Datenfreigabe vor dem Sortieren.", "Remote provider needs data-sending consent before sorting.")
        : localizedMsg(`Remote-Provider nicht bereit: ${readiness.reason}`, `Remote provider is not ready: ${readiness.reason}`);
      maybeNotify(message, { silent, type: "warning", notices });
      return { ...empty, ok: false, skipped: unmatched, failed: readiness.reason, errorCode: readiness.reason, userMessage: message };
    }

    const effectiveDeadline = Number.isFinite(deadlineAt)
      ? deadlineAt
      : Date.now() + resolveEffectiveTimeBudgetMs(readiness.value);

    if (!rules.some((r) => r?.name)) {
      const grouped = await clusterUnmatchedNewGroups(unmatched, readiness.value, { signal, deadlineAt: effectiveDeadline, fetchImpl });
      return { ok: true, assignedToExisting: [], newGroups: grouped.groups, skipped: grouped.skipped, notices };
    }

    const { deduped, origToDeduped } = dedupeTabs(unmatched);
    const snippets = await fetchSnippets(deduped, "remote", { signal });
    if (signal?.aborted) {
      return { ...empty, ok: false, skipped: unmatched, failed: "aborted", errorCode: "aborted" };
    }

    const ruleNameByLower = new Map(rules.filter((r) => r?.name).map((r) => [r.name.toLowerCase(), r.name]));
    const { parsedByIndex: parsedByDedupedIndex, failures, fatalError, aborted } = await collectProviderTabMap({
      tabs: deduped,
      snippets,
      initialBatchSize: PROVIDER_TAB_BATCH_SIZE,
      label: "remote provider",
      deadlineAt: effectiveDeadline,
      signal,
      isLocal: isLocalProfile(readiness.value),
      buildPrompt: (tabs, chunkSnippets, knownGroups) =>
        buildUnifiedPrompt(rules, tabs, chunkSnippets, { establishedGroups: knownGroups }),
      fetchJson: (inputStr, opts) =>
        providerJson(readiness.value, inputStr, PROVIDER_JSON_MAX_TOKENS, fetchImpl, {
          signal: opts?.signal || signal,
          deadlineAt: opts?.deadlineAt || effectiveDeadline,
        }),
    });

    if (aborted) {
      return { ...empty, ok: false, skipped: unmatched, failed: "aborted", errorCode: "aborted" };
    }

    const assignedToExisting = [];
    const newGroupsByKey = new Map();
    const skipped = [];

    for (let i = 0; i < unmatched.length; i++) {
      const value = parsedByDedupedIndex.get(origToDeduped[i]);
      const raw = stripMetaPrefix(value == null ? "" : String(value).trim());
      const lower = raw.toLowerCase();
      if (!raw || lower === "skipped" || lower === "none" || isCatchAllGroupName(raw)) {
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

    const newGroups = await consolidateNewGroups(
      [...newGroupsByKey.values()],
      (inputStr) => providerJson(readiness.value, inputStr, PROVIDER_JSON_MAX_TOKENS, fetchImpl, { signal, deadlineAt: effectiveDeadline }),
      "Remote provider",
      { existingGroupNames: [...ruleNameByLower.values()] },
    );

    if (fatalError) {
      const formatted = formatActionableProviderError(fatalError, readiness.value);
      maybeNotify(formatted.userMessage, { silent, type: "warning", notices });
      return {
        ok: assignedToExisting.length > 0 || newGroups.length > 0,
        assignedToExisting,
        newGroups,
        skipped,
        failed: fatalError.message || formatted.errorCode,
        errorCode: formatted.errorCode,
        userMessage: formatted.userMessage,
        notices,
      };
    }

    if (failures.length > 0) {
      maybeNotify(
        localizedMsg(
          `Remote-Provider hat unvollständige Batches wiederholt; ${skipped.length} Tab(s) blieben ungruppiert.`,
          `Remote provider retried incomplete batches; ${skipped.length} tab(s) still did not move.`,
        ),
        { silent, type: "info", notices },
      );
    }
    return { ok: true, assignedToExisting, newGroups, skipped, notices };
  } catch (e) {
    console.error(`${LOG} remote provider classification failed:`, e);
    const formatted = formatActionableProviderError(e, settings);
    maybeNotify(formatted.userMessage, { silent, type: "warning", notices });
    return {
      ...empty,
      ok: false,
      skipped: unmatched,
      failed: e.message || String(e),
      errorCode: formatted.errorCode,
      userMessage: formatted.userMessage,
    };
  }
};

export const runPass2RemoteFresh = async (
  allTabs,
  settings = readProviderSettings(globalThis.Services?.prefs),
  { signal = null, deadlineAt = null, silent = false, fetchImpl } = {},
) => {
  const notices = [];
  const empty = { ok: true, assignedToExisting: [], newGroups: [], skipped: [], notices };
  if (!allTabs?.length) return empty;

  try {
    const readiness = getProviderReadiness(settings);
    if (!readiness.ok) {
      const message = localizedMsg(`Remote-Provider nicht bereit: ${readiness.reason}`, `Remote provider is not ready: ${readiness.reason}`);
      maybeNotify(message, { silent, type: "warning", notices });
      return { ...empty, ok: false, skipped: allTabs, failed: readiness.reason, errorCode: readiness.reason, userMessage: message };
    }

    const effectiveDeadline = Number.isFinite(deadlineAt)
      ? deadlineAt
      : Date.now() + resolveEffectiveTimeBudgetMs(readiness.value);

    const { deduped, origToDeduped } = dedupeTabs(allTabs);
    const snippets = await fetchSnippets(deduped, "remote fresh", { signal });
    if (signal?.aborted) {
      return { ...empty, ok: false, skipped: allTabs, failed: "aborted", errorCode: "aborted" };
    }

    const { parsedByIndex: parsedByDedupedIndex, failures, fatalError, aborted } = await collectProviderTabMap({
      tabs: deduped,
      snippets,
      initialBatchSize: PROVIDER_FRESH_TAB_BATCH_SIZE,
      label: "remote provider fresh",
      deadlineAt: effectiveDeadline,
      signal,
      isLocal: isLocalProfile(readiness.value),
      buildPrompt: (tabs, chunkSnippets, knownGroups) =>
        buildFreshPrompt(tabs, chunkSnippets, { establishedGroups: knownGroups }),
      fetchJson: (inputStr, opts) =>
        providerJson(readiness.value, inputStr, PROVIDER_FRESH_JSON_MAX_TOKENS, fetchImpl, {
          signal: opts?.signal || signal,
          deadlineAt: opts?.deadlineAt || effectiveDeadline,
        }),
    });

    if (aborted) {
      return { ...empty, ok: false, skipped: allTabs, failed: "aborted", errorCode: "aborted" };
    }

    const newGroupsByKey = new Map();
    const skipped = [];

    for (let i = 0; i < allTabs.length; i++) {
      const value = parsedByDedupedIndex.get(origToDeduped[i]);
      const raw = stripMetaPrefix(value == null ? "" : String(value).trim());
      const lower = raw.toLowerCase();
      if (!raw || lower === "skipped" || lower === "none" || isCatchAllGroupName(raw)) {
        skipped.push(allTabs[i]);
        continue;
      }
      if (!newGroupsByKey.has(lower)) newGroupsByKey.set(lower, { name: raw, tabs: [] });
      newGroupsByKey.get(lower).tabs.push(allTabs[i]);
    }

    if (failures.length > 0 && !fatalError) {
      maybeNotify(
        localizedMsg(
          `Remote-Provider hat ${failures.length} Voll-KI-Batch(es) übersprungen. Versuche ggf. ein stärkeres Modell.`,
          `Remote provider skipped ${failures.length} full-AI batch(es). Try a stronger model if some tabs did not move.`,
        ),
        { silent, type: "info", notices },
      );
    }

    const newGroups = await consolidateNewGroups(
      [...newGroupsByKey.values()],
      (inputStr) => providerJson(readiness.value, inputStr, PROVIDER_FRESH_JSON_MAX_TOKENS, fetchImpl, { signal, deadlineAt: effectiveDeadline }),
      "Remote provider",
    );

    if (fatalError) {
      const formatted = formatActionableProviderError(fatalError, readiness.value);
      maybeNotify(formatted.userMessage, { silent, type: "warning", notices });
      return {
        ok: newGroups.length > 0,
        assignedToExisting: [],
        newGroups,
        skipped,
        failed: fatalError.message || formatted.errorCode,
        errorCode: formatted.errorCode,
        userMessage: formatted.userMessage,
        notices,
      };
    }

    return {
      ok: true,
      assignedToExisting: [],
      newGroups,
      skipped,
      notices,
      ...(failures.length > 0 ? { failed: failures.join("; ") } : {}),
    };
  } catch (e) {
    console.error(`${LOG} remote provider fresh classification failed:`, e);
    const formatted = formatActionableProviderError(e, settings);
    maybeNotify(formatted.userMessage, { silent, type: "warning", notices });
    return {
      ...empty,
      ok: false,
      skipped: allTabs,
      failed: e.message || String(e),
      errorCode: formatted.errorCode,
      userMessage: formatted.userMessage,
    };
  }
};

const clusterUnmatchedNewGroups = async (leftover, settings, { signal = null, deadlineAt = null, fetchImpl } = {}) => {
  const seen = new Set();
  const groupsByLower = new Map();

  for (const chunk of chunkTabsForProvider(leftover)) {
    if (signal?.aborted) break;
    const parsed = await providerJson(
      settings,
      buildClusterPrompt(chunk.tabs),
      PROVIDER_JSON_MAX_TOKENS,
      fetchImpl,
      { signal, deadlineAt },
    );
    const validIdx = (i) => Number.isFinite(i) && i >= 0 && i < chunk.tabs.length;

    for (const group of Array.isArray(parsed?.groups) ? parsed.groups : []) {
      const name = String(group?.name || "").trim();
      if (!name || isCatchAllGroupName(name)) continue;
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

const providerJson = async (settings, inputPayload, maxTokens = PROVIDER_JSON_MAX_TOKENS, fetchImpl, options = {}) => {
  const responseText = await providerText(settings, inputPayload, maxTokens, fetchImpl, { ...options, jsonMode: true });
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

const sendProviderRequest = async (request, fetchImpl, timeoutMs = CLOUD_DEFAULT_BUDGET_MS, signal = null, provider = "") => {
  if (signal?.aborted) {
    throw new ProviderHttpError({ category: ERROR_CATEGORIES.ABORT, message: "Request aborted", provider });
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onExternalAbort, { once: true });
  let timedOut = false;
  const boundedTimeout = Math.max(500, Math.round(timeoutMs));
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, boundedTimeout);
  try {
    const doFetch = resolveFetch(fetchImpl);
    const response = await doFetch(request.url, { ...request.init, signal: controller.signal });
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    const body = contentType.includes("event-stream")
      ? await streamSSEResponse(response, { signal: controller.signal })
      : await response.text();
    return { response, body };
  } catch (e) {
    if (e instanceof ProviderHttpError) throw e;
    if (timedOut) {
      throw new ProviderHttpError({
        category: ERROR_CATEGORIES.TIMEOUT,
        message: `timeout after ${boundedTimeout}ms`,
        provider,
        cause: e,
      });
    }
    if (signal?.aborted || e?.name === "AbortError") {
      throw new ProviderHttpError({
        category: ERROR_CATEGORIES.ABORT,
        message: "Request aborted",
        provider,
        cause: e,
      });
    }
    throw new ProviderHttpError({
      category: ERROR_CATEGORIES.NETWORK,
      message: e?.message || String(e),
      provider,
      cause: e,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onExternalAbort);
  }
};

const paramStyleByTarget = new Map();
const reasoningRejectedByTarget = new Set();
const responseFormatRejectedByTarget = new Set();
const jsonSchemaRejectedByTarget = new Set();
const temperatureRejectedByTarget = new Set();
const capabilityLookupExpiryByTarget = new Map();

const targetKey = (settings) => buildModelCacheKey(settings);

const discoverModelCapabilities = async (settings, fetchImpl, timeoutMs, signal = null) => {
  const key = targetKey(settings);
  const cached = getCachedModelCapabilities(settings);
  if (cached !== null) return cached;
  const negExpiry = capabilityLookupExpiryByTarget.get(key);
  if (negExpiry && negExpiry > Date.now()) return null;
  const endpoint = resolveProfileEndpoint(settings);
  if (!endpoint) return null;

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.min(MODEL_CAPABILITY_TIMEOUT_MS, Math.max(400, timeoutMs)));
  try {
    const doFetch = resolveFetch(fetchImpl);
    const url = `${endpoint.replace(/\/+$/, "")}/models`;
    const response = await doFetch(url, {
      method: "GET",
      headers: settings.apiKey
        ? { [AUTH_HEADER_NAME]: `Bearer ${settings.apiKey}`, accept: "application/json" }
        : { accept: "application/json" },
      signal: controller.signal,
    });
    const payload = response.ok ? JSON.parse(await response.text()) : null;
    const capabilities = payload ? parseModelReasoningCapabilities(payload, settings.model) : null;
    if (capabilities !== null) {
      setCachedModelCapabilities(settings, capabilities, MODEL_CAPABILITY_TTL_MS);
    } else {
      capabilityLookupExpiryByTarget.set(key, Date.now() + MODEL_CAPABILITY_TTL_MS);
    }
    return capabilities;
  } catch {
    capabilityLookupExpiryByTarget.set(key, Date.now() + MODEL_CAPABILITY_TTL_MS);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onExternalAbort);
  }
};

// Exposed for tests and for the settings connection test.
export const resetProviderReasoningCache = () => {
  paramStyleByTarget.clear();
  reasoningRejectedByTarget.clear();
  responseFormatRejectedByTarget.clear();
  jsonSchemaRejectedByTarget.clear();
  temperatureRejectedByTarget.clear();
  capabilityLookupExpiryByTarget.clear();
  clearProviderModelCache();
};

export const getEffectiveReasoning = async (
  settings,
  fetchImpl,
  timeoutMs = MODEL_CAPABILITY_TIMEOUT_MS,
  signal = null,
) => {
  const preference = settings?.reasoningPreference || readReasoningPreference();
  const kind = getProviderKind(settings);
  const catalogCapabilities = kind === "openai"
    ? await discoverModelCapabilities(settings, fetchImpl, timeoutMs, signal)
    : null;
  const capabilities = resolveCapabilitiesForModel({
    model: settings?.model || "",
    catalogCapabilities,
  });
  const key = targetKey(settings);
  const rejected = reasoningRejectedByTarget.has(key);
  let effort = rejected ? null : resolveReasoningEffort(preference, capabilities || {});
  const cachedEffort = getCachedResolvedEffort(settings, preference);
  if (!rejected && preference !== "default" && cachedEffort !== undefined) {
    effort = cachedEffort;
  }
  return { preference, capabilities, effort, rejected };
};

const providerText = async (settings, inputPayload, maxTokens, fetchImpl, options = {}) => {
  const startedAt = performance.now();
  const signal = options.signal || null;
  let effectiveSettings = settings;
  if (settings.provider === "chatgpt") {
    const freshToken = await ensureValidChatGPTToken(
      globalThis.Services?.prefs,
      fetchImpl,
      settings,
      { signal },
    );
    effectiveSettings = { ...settings, accessToken: freshToken };
  }

  const kind = getProviderKind(effectiveSettings);
  const adapterKind = resolveAdapterKind(effectiveSettings);
  const adapter = getAdapterForProfile(effectiveSettings);
  const adaptive = kind === "openai";
  const target = targetKey(effectiveSettings);
  const cachedStyle = adaptive ? paramStyleByTarget.get(target) : null;
  const ladder = !adaptive
    ? [PARAM_STYLE_CLASSIC]
    : cachedStyle
      ? [cachedStyle]
      : paramStyleLadder(effectiveSettings.model);

  const defaultBudgetMs = resolveEffectiveTimeBudgetMs(effectiveSettings);
  const requestedTimeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : Number.isFinite(options.deadlineAt)
      ? Math.max(800, options.deadlineAt - Date.now())
      : defaultBudgetMs;
  const budgetMs = Math.max(800, Math.min(requestedTimeoutMs, MAX_TIME_BUDGET_MS));
  const deadline = startedAt + budgetMs;
  const wallDeadline = Number.isFinite(options.deadlineAt) ? options.deadlineAt : Date.now() + budgetMs;
  const remaining = () => deadline - performance.now();

  const reasoning = options.reasoning
    || (await getEffectiveReasoning(effectiveSettings, fetchImpl, Math.min(MODEL_CAPABILITY_TIMEOUT_MS, budgetMs), signal));

  let state = {
    effort: reasoning.effort,
    thinkingBudget: adapterKind === "google-gemini" && reasoning.effort === "none" ? 0 : undefined,
    jsonMode: Boolean(options.jsonMode) && !responseFormatRejectedByTarget.has(target),
    jsonSchema: options.jsonSchema && !jsonSchemaRejectedByTarget.has(target) ? options.jsonSchema : null,
    disableJsonSchema: jsonSchemaRejectedByTarget.has(target),
    dropTemperature: temperatureRejectedByTarget.has(target),
    paramStyle: ladder[0],
  };

  let chatgpt401Retried = false;

  const executeOnce = async (reqSettings, reqTokens, reqState) => {
    return await withTransientRetry(
      async () => {
        if (remaining() < 500) {
          throw new ProviderHttpError({
            category: ERROR_CATEGORIES.TIMEOUT,
            message: "time budget exhausted while preparing the request",
            provider: reqSettings.provider,
          });
        }
        const request = buildProviderRequest(reqSettings, inputPayload, reqTokens, reqState.paramStyle, {
          reasoningEffort: reqState.effort,
          reasoningPreference: reasoning.preference,
          capabilities: reasoning.capabilities,
          jsonMode: reqState.jsonMode,
          jsonSchema: reqState.jsonSchema,
          disableJsonSchema: reqState.disableJsonSchema,
          dropTemperature: reqState.dropTemperature,
          ...(reqState.thinkingBudget !== undefined ? { thinkingBudget: reqState.thinkingBudget } : {}),
        });
        const { response, body } = await sendProviderRequest(
          request,
          fetchImpl,
          remaining(),
          signal,
          reqSettings.provider,
        );
        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
          const err = new ProviderHttpError({
            status: response.status,
            body,
            retryAfterMs,
            provider: reqSettings.provider,
          });
          // Retry transient/rate-limit inside withTransientRetry; return 400/401/422
          // immediately so the outer recovery loop can adapt parameters or refresh OAuth.
          if (err.retryable) throw err;
        }
        return { response, body };
      },
      {
        signal,
        deadlineAt: wallDeadline,
        maxAttempts: 3,
      },
    );
  };

  let response;
  let body;
  let style = ladder[0];

  for (const candidate of ladder) {
    style = candidate;
    state.paramStyle = candidate;

    ({ response, body } = await executeOnce(effectiveSettings, maxTokens, state));

    // Reactive 1x HTTP 401 -> forceRefreshChatGPTToken() -> retry on ChatGPT
    if (response.status === 401 && effectiveSettings.provider === "chatgpt" && !chatgpt401Retried) {
      chatgpt401Retried = true;
      const refreshed = await forceRefreshChatGPTToken(
        globalThis.Services?.prefs,
        fetchImpl,
        effectiveSettings,
        { signal },
      );
      effectiveSettings = { ...effectiveSettings, accessToken: refreshed };
      ({ response, body } = await executeOnce(effectiveSettings, maxTokens, state));
    }

    // Generalized HTTP 400/422 error-recovery ladder across all 5 adapters
    for (let recovery = 0; recovery < 4 && (response.status === 400 || response.status === 422); recovery++) {
      const step = nextReasoningRecoveryStep({
        adapter: adapterKind,
        status: response.status,
        body,
        currentState: state,
      });

      if (step.changed) {
        if (step.action === "downgrade_json_schema") {
          jsonSchemaRejectedByTarget.add(target);
        } else if (step.action === "disable_json_mode") {
          responseFormatRejectedByTarget.add(target);
          jsonSchemaRejectedByTarget.add(target);
        } else if (step.action === "drop_temperature") {
          temperatureRejectedByTarget.add(target);
        } else if (step.action === "drop_reasoning_effort") {
          reasoningRejectedByTarget.add(target);
        } else if (step.action?.startsWith("step_reasoning_effort_")) {
          // For ChatGPT, step none -> low; for OpenAI gateways that explicitly say
          // "does not support 'none'" with no accepted list, dropping avoids extra hops.
          if (effectiveSettings.provider === "chatgpt" && state.effort === "none") {
            step.nextState.effort = "low";
          } else if (adapterKind === "openai-chat" && !reasoning.capabilities?.accepted && state.effort === "none") {
            reasoningRejectedByTarget.add(target);
            step.nextState.effort = null;
          }
        } else if (step.action?.startsWith("switch_param_style_")) {
          // Only OpenAI-chat endpoints use classic <-> modern param shapes (handled by outer ladder);
          // Ollama / Gemini / Anthropic never retry parameter shapes.
          break;
        }
        state = step.nextState;
        style = state.paramStyle;
        ({ response, body } = await executeOnce(effectiveSettings, maxTokens, state));
        if (response.ok && state.effort !== reasoning.effort) {
          setCachedResolvedEffort(effectiveSettings, reasoning.preference, state.effort);
        }
        continue;
      }

      if (state.jsonMode && isResponseFormatError(response.status, body)) {
        responseFormatRejectedByTarget.add(target);
        jsonSchemaRejectedByTarget.add(target);
        state.jsonMode = false;
        state.jsonSchema = null;
        ({ response, body } = await executeOnce(effectiveSettings, maxTokens, state));
        continue;
      }

      if (state.effort && isReasoningParamError(response.status, body)) {
        reasoningRejectedByTarget.add(target);
        state.effort = null;
        ({ response, body } = await executeOnce(effectiveSettings, maxTokens, state));
        continue;
      }

      break;
    }

    if (response.ok || !isParamStyleError(response.status, body)) break;
    console.log(`${LOG} provider rejected the ${candidate} parameter shape`);
  }

  if (!response.ok) {
    throw new ProviderHttpError({
      status: response.status,
      body,
      retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
      provider: effectiveSettings.provider,
    });
  }

  if (adaptive) paramStyleByTarget.set(target, style);
  let text = adapter ? adapter.parseResponse(body) : parseProviderResponse(kind, body);
  if (isEmptyLengthResponse(kind, body) && remaining() > 2500) {
    const largerBudget = Math.min(16384, Math.max(4096, maxTokens * 2));
    ({ response, body } = await executeOnce(effectiveSettings, largerBudget, state));
    if (!response.ok) {
      throw new ProviderHttpError({
        status: response.status,
        body,
        retryAfterMs: parseRetryAfterMs(response.headers?.get?.("retry-after")),
        provider: effectiveSettings.provider,
      });
    }
    text = adapter ? adapter.parseResponse(body) : parseProviderResponse(kind, body);
  }

  if (typeof text !== "string" || !text.trim()) {
    const detail = describeEmptyResponse(kind, body);
    if (isEmptyLengthResponse(kind, body)) {
      throw new Error(`Provider output budget exhausted before a visible answer${detail ? ` (${detail})` : ""}`);
    }
    throw new Error(`Provider response did not contain text${detail ? ` (${detail})` : ""}`);
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  recordDebugEvent(
    "PROVIDER-TIMING",
    `${effectiveSettings.model || kind} answered in ${elapsedMs}ms (${describeReasoningSelection(reasoning.preference, reasoning.capabilities, state.effort)})`,
    { model: effectiveSettings.model, kind, effort: state.effort, style, elapsedMs },
  );
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

const fetchSnippets = async (tabs, label, { signal = null } = {}) => {
  const t0 = performance.now();
  const snippets = await fetchPageSnippets(tabs, signal ? { signal } : undefined);
  const hit = snippets.filter(Boolean).length;
  console.log(`${LOG} ${label}: fetched snippets for ${hit}/${tabs.length} tab(s) in ${Math.round(performance.now() - t0)}ms`);
  return snippets;
};

const skippedMap = (tabs) => new Map(tabs.map((_, idx) => [idx, null]));

export { classificationCache, invalidateClassificationCache };
