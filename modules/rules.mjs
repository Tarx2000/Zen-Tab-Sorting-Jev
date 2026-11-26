// Zen Tab Sorting — rules data layer.
// Reads/writes the rules JSON pref, validates rules.json file contents, and exposes
// the precedence chain (pref > file > built-in defaults).

import { CONFIG, DEFAULT_RULES, LOG, ZEN_COLOR_NAMES, isValidHex, normalizePipSize, pipSizePrefFor } from "./config.mjs";
import { normalizeSortingMode } from "./sorting-mode.mjs";

// Opt-in starter rule presets (Dev, Docs, Social, Shopping, Finance, Media).
// Never auto-applied unless the user explicitly imports or selects them.
export const STARTER_RULE_PRESETS = Object.freeze([
  Object.freeze({
    name: "Dev",
    color: "blue",
    domains: [
      "github.com",
      "gitlab.com",
      "stackoverflow.com",
      "developer.mozilla.org",
      "npmjs.com",
      "linear.app",
      "vercel.com",
      "localhost",
    ],
  }),
  Object.freeze({
    name: "Docs",
    color: "cyan",
    domains: [
      "docs.google.com",
      "drive.google.com",
      "notion.so",
      "coda.io",
      "dropbox.com",
      "confluence.atlassian.com",
    ],
  }),
  Object.freeze({
    name: "Social",
    color: "pink",
    domains: [
      "reddit.com",
      "x.com",
      "twitter.com",
      "linkedin.com",
      "instagram.com",
      "bsky.app",
      "mastodon.social",
    ],
  }),
  Object.freeze({
    name: "Shopping",
    color: "orange",
    domains: [
      "amazon.com",
      "amazon.de",
      "ebay.com",
      "ebay.de",
      "etsy.com",
      "idealo.de",
      "zalando.de",
    ],
  }),
  Object.freeze({
    name: "Finance",
    color: "green",
    domains: [
      "paypal.com",
      "stripe.com",
      "wise.com",
      "revolut.com",
      "chase.com",
      "n26.com",
      "ing.de",
    ],
  }),
  Object.freeze({
    name: "Media",
    color: "purple",
    domains: [
      "youtube.com",
      "netflix.com",
      "spotify.com",
      "twitch.tv",
      "soundcloud.com",
      "vimeo.com",
      "disneyplus.com",
    ],
  }),
]);

/**
 * Normalize a domain entry: trim, lowercase, strip protocol (`https://`),
 * strip leading `www.`, strip path/query/hash/trailing slashes and ports,
 * while preserving a leading `*.` wildcard prefix.
 */
export const normalizeDomainPattern = (raw) => {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  let s = String(raw).trim();
  if (!s) return "";

  const isWildcard = s.startsWith("*.");
  if (isWildcard) s = s.slice(2).trim();

  // Strip protocol if someone pasted a full URL (e.g. "https://www.GitHub.com/org/repo/")
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Strip userinfo if present
  const atIdx = s.indexOf("@");
  const slashIdx = s.search(/[/?#]/);
  if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
    s = s.slice(atIdx + 1);
  }
  // Keep only host portion (drop path/query/hash)
  s = s.split(/[/?#]/)[0];
  // Strip optional port (e.g. localhost:3000 -> localhost)
  s = s.replace(/:\d+$/, "");
  // Trim trailing dots & lowercase
  s = s.replace(/\.+$/, "").trim().toLowerCase();
  // Strip leading www.
  if (s.startsWith("www.")) s = s.slice(4);
  if (!s) return "";
  return isWildcard ? `*.${s}` : s;
};

/**
 * Normalize a URL pattern (e.g., "https://www.GitHub.com/MyOrg/*" -> "github.com/myorg/*"
 * preserving path case sensitivity only as lowercase for consistent matching).
 */
export const normalizeUrlPattern = (raw) => {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Strip query/fragment unless pattern explicitly uses them? Keep host+path clean.
  s = s.split("#")[0].trim();
  if (!s) return "";
  const slashPos = s.indexOf("/");
  if (slashPos === -1) {
    const host = s.toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
    return host;
  }
  let host = s.slice(0, slashPos).toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
  let path = s.slice(slashPos).replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${host}${path}`;
};

const dedupeStrings = (arr) => {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

export const normalizeRule = (r) => {
  const name = typeof r?.name === "string" ? r.name.trim() : "";
  const domains = Array.isArray(r?.domains)
    ? dedupeStrings(r.domains.map(normalizeDomainPattern).filter(Boolean))
    : [];

  const out = { name, domains };

  if (typeof r?.color === "string") {
    const c = r.color.trim();
    if (ZEN_COLOR_NAMES.has(c) || isValidHex(c)) out.color = c;
  }

  if (Array.isArray(r?.urlPatterns)) {
    const urlPatterns = dedupeStrings(r.urlPatterns.map(normalizeUrlPattern).filter(Boolean));
    if (urlPatterns.length > 0) out.urlPatterns = urlPatterns;
  }

  if (Array.isArray(r?.titlePatterns)) {
    const titlePatterns = dedupeStrings(
      r.titlePatterns.map((p) => String(p ?? "").trim()).filter(Boolean),
    );
    if (titlePatterns.length > 0) out.titlePatterns = titlePatterns;
  }

  if (Array.isArray(r?.containers)) {
    const containers = dedupeStrings(
      r.containers.map((c) => String(c ?? "").trim()).filter(Boolean),
    );
    if (containers.length > 0) out.containers = containers;
  }

  return out;
};

const hasAnyRuleMatcher = (rule) =>
  (Array.isArray(rule.domains) && rule.domains.length > 0) ||
  (Array.isArray(rule.urlPatterns) && rule.urlPatterns.length > 0) ||
  (Array.isArray(rule.titlePatterns) && rule.titlePatterns.length > 0) ||
  (Array.isArray(rule.containers) && rule.containers.length > 0);

/**
 * Whether deterministic domain rules (Pass 1) are enabled.
 * Off by default (`false`) so sorting relies purely on JEV + Fallback-LLM
 * unless the user explicitly ticks the optional domain-rules checkbox.
 */
export const isDomainRulesEnabled = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.USE_DOMAIN_RULES_PREF, false);
  } catch {
    return false;
  }
};

/**
 * Read the rules pref written by the settings widget.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.keepIncomplete=false]
 */
export const readRulesPref = ({ keepIncomplete = false } = {}) => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.RULES_PREF, "");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed.map(normalizeRule);
    return keepIncomplete
      ? cleaned
      : cleaned.filter((r) => r.name.length > 0 && hasAnyRuleMatcher(r));
  } catch (e) {
    console.warn(`${LOG} rules pref parse failed:`, e);
    return null;
  }
};

export const writeRulesPref = (rules) => {
  try {
    const normalized = Array.isArray(rules) ? rules.map(normalizeRule) : [];
    Services.prefs.setStringPref(CONFIG.RULES_PREF, JSON.stringify(normalized));
  } catch (e) {
    console.error(`${LOG} failed to write rules pref:`, e);
  }
};

// Skip-domain list: hostnames or `*.host` patterns the tidy click never touches.
export const readSkipDomainsPref = () => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.SKIP_DOMAINS_PREF, "");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeStrings(parsed.map(normalizeDomainPattern).filter(Boolean));
  } catch (e) {
    console.warn(`${LOG} skip-domains pref parse failed:`, e);
    return [];
  }
};

export const writeSkipDomainsPref = (domains) => {
  try {
    const normalized = Array.isArray(domains)
      ? dedupeStrings(domains.map(normalizeDomainPattern).filter(Boolean))
      : [];
    Services.prefs.setStringPref(CONFIG.SKIP_DOMAINS_PREF, JSON.stringify(normalized));
  } catch (e) {
    console.error(`${LOG} failed to write skip-domains pref:`, e);
  }
};

// Collapsed-group persistence.
export const readCollapsedGroupsPref = () => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.COLLAPSED_GROUPS_PREF, "");
    if (!raw.trim()) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : []);
  } catch (e) {
    console.warn(`${LOG} collapsed-groups pref parse failed:`, e);
    return new Set();
  }
};

export const writeCollapsedGroupsPref = (labels) => {
  try {
    const arr = Array.from(labels);
    Services.prefs.setStringPref(CONFIG.COLLAPSED_GROUPS_PREF, JSON.stringify(arr));
  } catch (e) {
    console.error(`${LOG} failed to write collapsed-groups pref:`, e);
  }
};

// Validate the structure of a rules.json file payload. Throws on bad input.
export const validateRules = (data) => {
  if (!data || !Array.isArray(data.rules)) {
    throw new Error("rules.json must have a top-level 'rules' array");
  }
  const normalized = [];
  for (const [i, rule] of data.rules.entries()) {
    if (!rule || typeof rule.name !== "string" || !rule.name.trim()) {
      throw new Error(`rule[${i}] missing or empty 'name'`);
    }
    const hasExtended =
      (Array.isArray(rule.urlPatterns) && rule.urlPatterns.length > 0) ||
      (Array.isArray(rule.titlePatterns) && rule.titlePatterns.length > 0) ||
      (Array.isArray(rule.containers) && rule.containers.length > 0);

    if (rule.domains !== undefined) {
      if (!Array.isArray(rule.domains) || rule.domains.some((d) => typeof d !== "string")) {
        throw new Error(`rule[${i}] '${rule.name}': 'domains' must be a string array`);
      }
    } else if (!hasExtended) {
      throw new Error(`rule[${i}] '${rule.name}': 'domains' must be a string array`);
    }

    for (const field of ["urlPatterns", "titlePatterns", "containers"]) {
      if (rule[field] !== undefined) {
        if (!Array.isArray(rule[field]) || rule[field].some((v) => typeof v !== "string")) {
          throw new Error(`rule[${i}] '${rule.name}': '${field}' must be a string array`);
        }
      }
    }

    normalized.push(normalizeRule(rule));
  }
  return normalized;
};

const loadRulesFromFile = async () => {
  const url = `${CONFIG.RULES_URL}?t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return validateRules(await res.json());
};

// Deterministic domain rules are disabled by default unless the user opts in via
// `use-domain-rules` (or when an explicit non-JEV rule test sets `rules-json`).
export const loadRules = async () => {
  const engine = getAIEngine();
  if (!isDomainRulesEnabled() && (engine === "jev" || engine === "chatgpt" || engine === "primalabs")) {
    return [];
  }
  const prefRules = readRulesPref();
  if (prefRules && prefRules.length > 0) {
    console.log(`${LOG} loaded ${prefRules.length} rule(s) from settings widget`);
    return prefRules;
  }
  if (!isDomainRulesEnabled()) {
    return [];
  }
  try {
    const fileRules = await loadRulesFromFile();
    console.log(`${LOG} loaded ${fileRules.length} rule(s) from rules.json`);
    return fileRules;
  } catch {
    return DEFAULT_RULES;
  }
};

export const isMinimalStyle = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.MINIMAL_STYLE_PREF, false);
  } catch {
    return false;
  }
};

export const getPipShape = () => {
  try {
    const value = Services.prefs.getStringPref(CONFIG.PIP_SHAPE_PREF, "circle");
    return value === "square" || value === "none" ? value : "circle";
  } catch {
    return "circle";
  }
};

export const getPipOpenBehavior = () => {
  try {
    const value = Services.prefs.getStringPref(CONFIG.PIP_OPEN_BEHAVIOR_PREF, "smaller");
    return value === "same" || value === "hidden" ? value : "smaller";
  } catch {
    return "smaller";
  }
};

export const getPipSize = (shape = getPipShape()) => {
  try {
    const prefs = Services.prefs;
    const name = pipSizePrefFor(shape);
    if (prefs.prefHasUserValue(name)) return normalizePipSize(prefs.getStringPref(name, ""));
    if (prefs.prefHasUserValue(CONFIG.PIP_SIZE_LEGACY_PREF)) {
      return normalizePipSize(prefs.getStringPref(CONFIG.PIP_SIZE_LEGACY_PREF, ""));
    }
    return CONFIG.PIP_SIZE_DEFAULT;
  } catch {
    return CONFIG.PIP_SIZE_DEFAULT;
  }
};

export const isStrictRulesEnforced = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.STRICT_RULES_PREF, false);
  } catch {
    return false;
  }
};

// Which AI engine is selected. Returns one of:
// "off" | "jev" | "chatgpt" | "primalabs" | "local" | "ollama" | "openai" | "gemini" | "custom".
export const getAIEngine = () => {
  try {
    const engine = Services.prefs.getStringPref(CONFIG.AI_ENGINE_PREF, "");
    if (["jev", "chatgpt", "primalabs", "local", "ollama", "openai", "gemini", "custom"].includes(engine)) {
      return engine;
    }
    return "off";
  } catch {
    return "off";
  }
};

export const getAISortMode = () => {
  try {
    return normalizeSortingMode(Services.prefs.getStringPref(CONFIG.AI_SORT_MODE_PREF, ""));
  } catch {
    return normalizeSortingMode("");
  }
};

export const getOllamaHost = () => {
  try {
    const v = Services.prefs.getStringPref(CONFIG.AI_OLLAMA_HOST_PREF, "").trim();
    return v || CONFIG.AI_OLLAMA_HOST_DEFAULT;
  } catch {
    return CONFIG.AI_OLLAMA_HOST_DEFAULT;
  }
};

export const getOllamaModel = () => {
  try {
    const v = Services.prefs.getStringPref(CONFIG.AI_OLLAMA_MODEL_PREF, "").trim();
    return v || CONFIG.AI_OLLAMA_MODEL_DEFAULT;
  } catch {
    return CONFIG.AI_OLLAMA_MODEL_DEFAULT;
  }
};

export const isOllamaWarmupEnabled = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.AI_OLLAMA_WARMUP_PREF, true);
  } catch {
    return true;
  }
};

export const getLocalAIBatchSize = () => {
  try {
    const raw = Services.prefs.getStringPref(
      CONFIG.AI_LOCAL_BATCH_SIZE_PREF,
      String(CONFIG.AI_LOCAL_BATCH_SIZE_DEFAULT),
    );
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 1) return CONFIG.AI_LOCAL_BATCH_SIZE_DEFAULT;
    return Math.min(200, Math.max(1, v));
  } catch {
    return CONFIG.AI_LOCAL_BATCH_SIZE_DEFAULT;
  }
};

// Never auto-append domains into rules unless the user explicitly enabled
// deterministic domain rules and selected "always-add".
export const getAIExistingBehavior = () => {
  try {
    if (!isDomainRulesEnabled()) return "transient";
    if (getAIEngine() === "local") {
      return getAINewGroupBehavior() === "auto-add" ? "always-add" : "transient";
    }
    return Services.prefs.getStringPref(CONFIG.AI_EXISTING_BEHAVIOR_PREF, "transient");
  } catch {
    return "transient";
  }
};

// Never auto-create domain rules unless the user explicitly enabled domain rules.
export const getAINewGroupBehavior = () => {
  try {
    const raw = Services.prefs.getStringPref(CONFIG.AI_NEW_GROUP_BEHAVIOR_PREF, "transient");
    if (!isDomainRulesEnabled() && raw === "auto-add") return "transient";
    return raw;
  } catch {
    return "transient";
  }
};
