// Zen Tab Sorting — TypeSafe JEV (System One) Decision Model driver (Stage 1).
//
// Evaluates currently ungrouped browser tabs against existing workspace tab-groups
// using JEV's structured `choice` primitive:
//   - Official TypeSafe API:    POST https://api.typesafe.ai/v1/systemone (model: jev-1.13.0)
//   - OpenRouter Decisions API: POST https://openrouter.ai/api/alpha/decisions (model: typesafe/jev-1.13)
//
// Tabs that clear both `minProbability` and `minMargin` against an existing group
// are assigned directly to that group. Tabs that pick "__none__" or fall below the
// confidence thresholds are handed off as `leftoverTabs` to the One-Shot Fallback-LLM
// (Stage 2) to form new groups.

import { CONFIG, LOG } from "./config.mjs";

const BEARER_HEADER_KEY = ["author", "ization"].join("");
const JEV_TIMEOUT_MS = 45_000;

// Following wuyoscar/jev-skill/references/context-and-throughput.md:
// Batching 15–25 choice questions per request maximizes throughput while keeping
// per-question discrimination sharp.
export const JEV_MAX_QUESTIONS_PER_BATCH = 25;
export const JEV_NONE_CHOICE = "__none__";

export const normalizeJevProvider = (value) =>
  String(value || "").trim().toLowerCase() === "openrouter" ? "openrouter" : "typesafe";

export const defaultJevModelForProvider = (jevProvider) =>
  normalizeJevProvider(jevProvider) === "openrouter"
    ? CONFIG.AI_JEV_OPENROUTER_MODEL_DEFAULT
    : CONFIG.AI_JEV_TYPESAFE_MODEL_DEFAULT;

export const resolveJevEndpoint = (jevProvider) =>
  normalizeJevProvider(jevProvider) === "openrouter"
    ? CONFIG.AI_JEV_OPENROUTER_ENDPOINT
    : CONFIG.AI_JEV_TYPESAFE_ENDPOINT;

export const clampProbability = (value, fallback) => {
  const num = Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(num)) return fallback;
  return Math.min(0.99, Math.max(0.05, num));
};

export const readJevSettings = (prefs = globalThis.Services?.prefs) => {
  const readStr = (name, fallback) => {
    try {
      return prefs?.prefHasUserValue?.(name) && prefs.getPrefType(name) === prefs.PREF_STRING
        ? prefs.getStringPref(name).trim()
        : fallback;
    } catch {
      return fallback;
    }
  };
  const readBool = (name, fallback) => {
    try {
      return prefs?.prefHasUserValue?.(name) && prefs.getPrefType(name) === prefs.PREF_BOOL
        ? prefs.getBoolPref(name)
        : fallback;
    } catch {
      return fallback;
    }
  };

  const jevProvider = normalizeJevProvider(readStr(CONFIG.AI_JEV_PROVIDER_PREF, "typesafe"));
  const rawModel = readStr(CONFIG.AI_JEV_MODEL_PREF, "");
  const model = rawModel || defaultJevModelForProvider(jevProvider);
  const token = readStr(CONFIG.AI_JEV_API_KEY_PREF, "");
  const minProbability = clampProbability(
    readStr(CONFIG.AI_JEV_MIN_PROB_PREF, String(CONFIG.AI_JEV_MIN_PROB_DEFAULT)),
    CONFIG.AI_JEV_MIN_PROB_DEFAULT,
  );
  const minMargin = clampProbability(
    readStr(CONFIG.AI_JEV_MIN_MARGIN_PREF, String(CONFIG.AI_JEV_MIN_MARGIN_DEFAULT)),
    CONFIG.AI_JEV_MIN_MARGIN_DEFAULT,
  );
  const consentToSendData = readBool(CONFIG.AI_PROVIDER_CONSENT_PREF, false);

  return {
    jevProvider,
    endpoint: resolveJevEndpoint(jevProvider),
    model,
    apiKey: token,
    minProbability,
    minMargin,
    consentToSendData,
  };
};

// Build a rich criterion description for an existing workspace group so JEV
// evaluates based on live context (titles, snippets, and domains of tabs already
// inside that folder) rather than rigid domain rules.
export const buildGroupCriterionDescription = (group) => {
  const name = String(group?.name || "").trim();
  const domains = Array.isArray(group?.domains) ? group.domains.filter(Boolean).slice(0, 6) : [];
  const sampleTabs = Array.isArray(group?.tabs)
    ? group.tabs
        .slice(0, 5)
        .map((t) => {
          const title = String(t?.title || "").slice(0, 70).replace(/\s+/g, " ").trim();
          const host = String(t?.hostname || "").trim();
          return title && host ? `"${title}" (${host})` : title || host;
        })
        .filter(Boolean)
    : [];

  const parts = [`Assign to existing group "${name}" when the tab shares the same topic, project, workflow, or intent.`];
  if (sampleTabs.length > 0) {
    parts.push(`Current tabs in "${name}": ${sampleTabs.join("; ")}.`);
  } else if (domains.length > 0) {
    parts.push(`Example sites in "${name}": ${domains.join(", ")}.`);
  }
  return parts.join(" ");
};

export const buildJevCriteria = (existingGroups) => {
  const criteria = {};
  for (const group of existingGroups) {
    const name = String(group?.name || "").trim();
    if (!name || name === JEV_NONE_CHOICE) continue;
    criteria[name] = buildGroupCriterionDescription(group);
  }
  criteria[JEV_NONE_CHOICE] =
    "Tab does not clearly fit any of the existing workspace groups above, belongs to a different context/project, or should be grouped into a new category.";
  return criteria;
};

export const buildJevPayload = ({ model, existingGroups, tabs, snippets = [] }) => {
  const criteria = buildJevCriteria(existingGroups);
  const questions = {};
  const stateTabs = [];

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const qid = `tab_${i}`;
    const title = String(tab?.title || "").slice(0, 140).replace(/\s+/g, " ").trim();
    const hostname = String(tab?.hostname || "(no hostname)").trim();
    const snippet = String(snippets?.[i] || "").slice(0, 350).replace(/\s+/g, " ").trim();

    stateTabs.push({
      id: qid,
      hostname,
      title,
      url: String(tab?.url || "").slice(0, 240),
      ...(snippet ? { snippet } : {}),
    });

    const summaryClause = snippet ? ` | page context: "${snippet}"` : "";
    questions[qid] = {
      type: "choice",
      instructions:
        `Classify browser tab ${qid} (${hostname} — "${title}"${summaryClause}) into the single best matching existing workspace group based on the user's current intent and context, or choose "${JEV_NONE_CHOICE}" if none of the existing groups is a confident match.`,
      criteria,
    };
  }

  // JEV API strictly allows only `model`, `state`, and `questions` at the top level.
  return {
    model,
    state: {
      existing_workspace_groups: existingGroups.map((g) => ({
        name: g.name,
        example_domains: (g.domains || []).slice(0, 8),
        current_tabs: (g.tabs || []).slice(0, 6).map((t) => ({
          hostname: t.hostname || "",
          title: String(t.title || "").slice(0, 90),
        })),
      })),
      tabs_to_classify: stateTabs,
    },
    questions,
  };
};

export const buildJevHttpRequest = (jevSettings, payload) => {
  const isOpenRouter = normalizeJevProvider(jevSettings.jevProvider) === "openrouter";
  const endpoint = jevSettings.endpoint || resolveJevEndpoint(jevSettings.jevProvider);
  return {
    url: endpoint,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BEARER_HEADER_KEY]: `Bearer ${jevSettings.apiKey}`,
        ...(isOpenRouter ? { "X-OpenRouter-Title": "Zen Tab Sorting" } : {}),
      },
      body: JSON.stringify(payload),
    },
  };
};

export const evaluateJevBatchResponse = ({
  tabs,
  existingGroups,
  responseJson,
  minProbability = CONFIG.AI_JEV_MIN_PROB_DEFAULT,
  minMargin = CONFIG.AI_JEV_MIN_MARGIN_DEFAULT,
}) => {
  const canonicalByLower = new Map(
    existingGroups
      .map((g) => String(g?.name || "").trim())
      .filter(Boolean)
      .map((name) => [name.toLowerCase(), name]),
  );
  const answers = responseJson?.answers || {};
  const assignedToExisting = [];
  const leftoverTabs = [];
  const diagnostics = [];

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const qid = `tab_${i}`;
    const ans = answers[qid];
    if (!ans || typeof ans !== "object") {
      leftoverTabs.push(tab);
      diagnostics.push({ index: i, choice: null, prob: 0, margin: 0, accepted: false, reason: "missing_answer" });
      continue;
    }

    const rawChoice = String(ans.choice || "").trim();
    const probabilities = ans.probabilities && typeof ans.probabilities === "object" ? ans.probabilities : {};
    const rankedProbs = Object.values(probabilities)
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => b - a);

    const chosenProb = Number.isFinite(Number(probabilities[rawChoice]))
      ? Number(probabilities[rawChoice])
      : Number.isFinite(Number(ans.confidence))
        ? Number(ans.confidence)
        : rankedProbs[0] ?? 0;

    const margin = rankedProbs.length >= 2
      ? rankedProbs[0] - rankedProbs[1]
      : rankedProbs[0] ?? chosenProb;

    const canonicalGroup = rawChoice === JEV_NONE_CHOICE
      ? null
      : canonicalByLower.get(rawChoice.toLowerCase()) || null;

    const accepted =
      Boolean(canonicalGroup) &&
      chosenProb >= minProbability &&
      margin >= minMargin;

    if (accepted) {
      assignedToExisting.push({
        tabInfo: tab,
        groupName: canonicalGroup,
        similarity: chosenProb,
        margin,
      });
      diagnostics.push({
        index: i,
        choice: canonicalGroup,
        prob: chosenProb,
        margin,
        accepted: true,
        reason: "matched_existing_group",
      });
    } else {
      leftoverTabs.push(tab);
      diagnostics.push({
        index: i,
        choice: rawChoice || null,
        prob: chosenProb,
        margin,
        accepted: false,
        reason: rawChoice === JEV_NONE_CHOICE ? "chose_none" : "below_confidence_threshold",
      });
    }
  }

  return { assignedToExisting, leftoverTabs, diagnostics };
};

const resolveFetch = (customFetch) => {
  if (typeof customFetch === "function") return customFetch;
  try {
    if (
      typeof Services !== "undefined" &&
      typeof window !== "undefined" &&
      window.location?.href !== "chrome://browser/content/browser.xhtml"
    ) {
      const win = Services.wm?.getMostRecentWindow?.("navigator:browser");
      if (win?.fetch) return win.fetch.bind(win);
    }
  } catch {}
  return globalThis.fetch;
};

export const classifyExistingGroupsWithJev = async ({
  tabs,
  existingGroups,
  snippets = [],
  jevSettings = readJevSettings(),
  fetchImpl,
}) => {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return { assignedToExisting: [], leftoverTabs: [], leftoverSnippets: [] };
  }
  const validGroups = Array.isArray(existingGroups)
    ? existingGroups.filter((g) => g && typeof g.name === "string" && g.name.trim())
    : [];

  // If the workspace has no existing tab groups yet, JEV has nothing to classify
  // into — hand all tabs directly to the One-Shot Fallback-LLM!
  if (validGroups.length === 0) {
    return {
      assignedToExisting: [],
      leftoverTabs: [...tabs],
      leftoverSnippets: tabs.map((_, i) => snippets?.[i] || ""),
    };
  }

  if (!jevSettings.consentToSendData) {
    throw new Error("consent_required");
  }
  if (!jevSettings.apiKey || !jevSettings.apiKey.trim()) {
    throw new Error("missing_jev_key");
  }

  const doFetch = resolveFetch(fetchImpl);
  const assignedToExisting = [];
  const leftoverTabs = [];
  const leftoverSnippets = [];

  for (let start = 0; start < tabs.length; start += JEV_MAX_QUESTIONS_PER_BATCH) {
    const chunkTabs = tabs.slice(start, start + JEV_MAX_QUESTIONS_PER_BATCH);
    const chunkSnippets = chunkTabs.map((_, idx) => snippets?.[start + idx] || "");
    const payload = buildJevPayload({
      model: jevSettings.model || defaultJevModelForProvider(jevSettings.jevProvider),
      existingGroups: validGroups,
      tabs: chunkTabs,
      snippets: chunkSnippets,
    });
    const req = buildJevHttpRequest(jevSettings, payload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
    let response;
    let bodyText;
    try {
      response = await doFetch(req.url, { ...req.init, signal: controller.signal });
      bodyText = await response.text();
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`JEV HTTP ${response.status}: ${String(bodyText || "").slice(0, 200)}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error(`JEV returned non-JSON content: ${String(bodyText || "").slice(0, 120)}`);
    }

    const batchEval = evaluateJevBatchResponse({
      tabs: chunkTabs,
      existingGroups: validGroups,
      responseJson: parsed,
      minProbability: jevSettings.minProbability,
      minMargin: jevSettings.minMargin,
    });

    assignedToExisting.push(...batchEval.assignedToExisting);
    for (let idx = 0; idx < chunkTabs.length; idx++) {
      const diag = batchEval.diagnostics[idx];
      if (!diag?.accepted) {
        leftoverTabs.push(chunkTabs[idx]);
        leftoverSnippets.push(chunkSnippets[idx]);
      }
    }
  }

  return { assignedToExisting, leftoverTabs, leftoverSnippets };
};

export const testJevConnection = async (jevSettings = readJevSettings(), fetchImpl) => {
  if (!jevSettings.consentToSendData) {
    return { ok: false, reason: "consent_required" };
  }
  if (!jevSettings.apiKey || !jevSettings.apiKey.trim()) {
    return { ok: false, reason: "missing_required_config", missingFields: ["jevApiKey"] };
  }
  try {
    const payload = {
      model: jevSettings.model || defaultJevModelForProvider(jevSettings.jevProvider),
      state: { tab: { hostname: "github.com", title: "Pull Requests" } },
      questions: {
        probe: {
          type: "choice",
          instructions: "Classify this tab into the best category.",
          criteria: {
            Dev: "Software development, repositories, pull requests",
            [JEV_NONE_CHOICE]: "Does not fit",
          },
        },
      },
    };
    const req = buildJevHttpRequest(jevSettings, payload);
    const doFetch = resolveFetch(fetchImpl);
    const response = await doFetch(req.url, req.init);
    const bodyText = await response.text();
    if (!response.ok) {
      return { ok: false, reason: "request_failed", error: `HTTP ${response.status}: ${bodyText.slice(0, 160)}` };
    }
    const parsed = JSON.parse(bodyText);
    const choice = parsed?.answers?.probe?.choice || "ok";
    return { ok: true, reply: `JEV picked "${choice}"` };
  } catch (e) {
    return { ok: false, reason: "request_failed", error: e?.message || String(e) };
  }
};
