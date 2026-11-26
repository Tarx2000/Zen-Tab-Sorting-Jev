import { captureNewGroupAppearance } from "./group-appearance.mjs";
// Zen Tab Sorting — Pass 2 (local AI) using Firefox's bundled ML engine.
//
// Pipeline:
//   1. Embed each Pass-1-unmatched tab title + hostname (or local file:// label),
//      backed by the bounded in-memory `embeddingCache`.
//   2. For each existing rule-matched group in the workspace (excluding Library
//      sidebar copies via `isSidebarCopy`), embed each of its tabs and score
//      candidates by MAX cosine similarity against any individual tab in the group.
//   3. In Fresh mode (`runPass2Fresh`), cluster embeddings using agglomerative
//      average-linkage with a complete-linkage coherence guard (eliminating
//      single-linkage snowballing) and name clusters with Unicode DE+EN keywords
//      and 2-part TLD-aware hostnames.
//   4. `applyPass2` moves tabs into existing groups (reliably re-collapsing
//      previously collapsed groups, and creating evaporated target groups on
//      demand instead of silently dropping tabs) and creates new groups.

import { CONFIG, LOG, PRESET_COLORS } from "./config.mjs";
import {
  writeRulesPref,
  getAIExistingBehavior,
  getAINewGroupBehavior,
  getLocalAIBatchSize,
} from "./rules.mjs";
import { getTabTitle, getTabUrl, fetchPageSnippets } from "./tabs.mjs";
import {
  findExistingGroup,
  expandIfCollapsed,
  collapseGroup,
  applyGroupColor,
  findSafeInsertAnchor,
} from "./groups.mjs";
import { isSidebarCopy } from "./sidebar-elements.mjs";
import { showToast } from "./ui-toast.mjs";
import { embeddingCache, buildEmbeddingCacheKey } from "./classification-cache.mjs";

// Multi-topic platforms where different tabs on the same host belong to
// completely different topics/projects — never collapse all tabs on these hosts
// into a single host-only embedding.
export const MULTI_TOPIC_PLATFORMS = new Set([
  "youtube.com",
  "github.com",
  "docs.google.com",
  "reddit.com",
  "notion.so",
  "wikipedia.org",
  "medium.com",
  "substack.com",
]);

export const isMultiTopicPlatform = (hostname) => {
  const host = String(hostname || "").trim().toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  if (MULTI_TOPIC_PLATFORMS.has(host)) return true;
  for (const platform of MULTI_TOPIC_PLATFORMS) {
    if (host.endsWith("." + platform)) return true;
  }
  return false;
};

/**
 * Extract filename/stem/extension/parent info from a `file://` URL so hostless
 * local files (PDFs, HTML docs, etc.) are embedded and grouped instead of dropped.
 */
export const extractFileInfo = (rawUrl) => {
  const input = String(rawUrl || "").trim();
  if (!input || !input.toLowerCase().startsWith("file:")) return null;
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") return null;
    let pathname = parsed.pathname || "";
    try {
      pathname = decodeURIComponent(pathname);
    } catch {}
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const filename = segments[segments.length - 1];
    const parentDir = segments.length >= 2 ? segments[segments.length - 2] : "";
    const dotIdx = filename.lastIndexOf(".");
    const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
    const ext = dotIdx > 0 ? filename.slice(dotIdx + 1).toLowerCase() : "";
    const keyPath = segments.slice(-2).join("/").toLowerCase();
    return { filename, stem, ext, parentDir, keyPath };
  } catch {
    return null;
  }
};

const normalizeTitleForDedupe = (title) =>
  String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 120);

/**
 * Compute the dedupe key for embedding a tab:
 *   - Multi-topic platforms -> `(hostname, normalizedTitle)`
 *   - Regular websites      -> `hostname`
 *   - Local `file://` URLs  -> `file:<parent/filename>`
 *   - Other hostless URLs   -> `""` (skipped)
 */
export const tabEmbeddingDedupeKey = (tab) => {
  const host = String(tab?.hostname || "").trim().toLowerCase().replace(/^www\./, "");
  if (host) {
    if (isMultiTopicPlatform(host)) {
      const normTitle = normalizeTitleForDedupe(tab?.title);
      return `${host}\0${normTitle}`;
    }
    return host;
  }
  const fileInfo = extractFileInfo(tab?.url);
  if (fileInfo) {
    return `file:${fileInfo.keyPath}`;
  }
  return "";
};

// ─── Engine loaders (lazy + cached for the lifetime of the window) ───────────
//
// Zen ships Firefox's local ML engine but disables it by default (`browser.ml.enable`
// pref defaults to false in Zen).
const ensureMLEnginePref = () => {
  try {
    if (!Services.prefs.getBoolPref("browser.ml.enable", false)) {
      Services.prefs.setBoolPref("browser.ml.enable", true);
      console.log(`${LOG} AI: enabled browser.ml.enable pref`);
    }
  } catch (e) {
    console.warn(`${LOG} AI: could not toggle browser.ml.enable:`, e);
  }
};

let embeddingEnginePromise = null;

const loadEmbeddingEngine = () => {
  if (embeddingEnginePromise) return embeddingEnginePromise;
  embeddingEnginePromise = (async () => {
    ensureMLEnginePref();
    const { createEngine } = ChromeUtils.importESModule(
      "chrome://global/content/ml/EngineProcess.sys.mjs"
    );
    return createEngine({
      taskName: "feature-extraction",
      modelId: "Mozilla/smart-tab-embedding",
      modelHub: "huggingface",
      engineId: "zao-embedding",
    });
  })().catch((e) => {
    embeddingEnginePromise = null; // allow retry on next click
    throw e;
  });
  return embeddingEnginePromise;
};

// ─── Math + normalization helpers ─────────────────────────────────────────────

const poolEmbedding = (raw) => {
  if (!raw) return null;
  if (raw?.[0]?.embedding && Array.isArray(raw[0].embedding)) return averageVectors(raw[0].embedding);
  if (Array.isArray(raw?.[0])) return averageVectors(raw[0]);
  if (Array.isArray(raw)) return averageVectors(raw);
  return null;
};

const averageVectors = (arrays) => {
  if (!Array.isArray(arrays) || arrays.length === 0) return null;
  if (typeof arrays[0] === "number") return arrays; // already flat
  const len = arrays[0].length;
  const avg = new Array(len).fill(0);
  for (const a of arrays) {
    for (let i = 0; i < len; i++) avg[i] += a[i];
  }
  for (let i = 0; i < len; i++) avg[i] /= arrays.length;
  return avg;
};

const l2Normalize = (v) => {
  if (!Array.isArray(v) || v.length === 0) return v;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
};

export const cosineSimilarity = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

// Combine the title with the hostname (or local file:// filename/path) for the
// embedding input.
export const buildEmbedText = (titleOrInfo) => {
  if (typeof titleOrInfo === "string") return titleOrInfo;
  if (!titleOrInfo || typeof titleOrInfo !== "object") return "";
  const title = String(titleOrInfo.title || "").trim();
  const hostname = String(titleOrInfo.hostname || "").trim();
  if (hostname) return `${title} (${hostname})`.trim();
  const fileInfo = extractFileInfo(titleOrInfo.url);
  if (fileInfo) {
    const label = title || fileInfo.stem.replace(/[_-]+/g, " ");
    const folderHint = fileInfo.parentDir ? `${fileInfo.parentDir}/` : "";
    return `${label} (file: ${folderHint}${fileInfo.filename})`.trim();
  }
  return title;
};

const MAX_EMBED_INPUT_CHARS = 1000;
const DEAD_PORT_SENTINEL = Symbol("dead-port");

const embed = async (input, { bypassCache = false } = {}) => {
  let text = buildEmbedText(input);
  if (!text || typeof text !== "string") return null;
  if (text.length > MAX_EMBED_INPUT_CHARS) text = text.slice(0, MAX_EMBED_INPUT_CHARS);

  const cacheKey = buildEmbeddingCacheKey(text);
  if (!bypassCache && cacheKey) {
    const cached = embeddingCache.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const engine = await loadEmbeddingEngine();
    const result = await engine.run({ args: [text] });
    const pooled = poolEmbedding(result);
    const normalized = pooled ? l2Normalize(pooled) : null;
    if (normalized && !bypassCache && cacheKey) {
      embeddingCache.set(cacheKey, normalized);
    }
    return normalized;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("Port does not exist")) {
      return DEAD_PORT_SENTINEL;
    }
    console.error(`${LOG} embedding failed for "${text}":`, e);
    return null;
  }
};

const embedBatch = async (inputs, opts = {}) => {
  const batchSize = opts.batchSize ?? CONFIG.AI_EMBEDDING_BATCH_SIZE;
  const yieldBetween = !!opts.yieldBetween;
  const bypassCache = !!opts.bypassCache;
  const out = [];
  let alreadyRecreated = false;
  for (let i = 0; i < inputs.length; i += batchSize) {
    const chunk = inputs.slice(i, i + batchSize);
    let results = await Promise.all(chunk.map((item) => embed(item, { bypassCache })));
    const someDead = results.some((r) => r === DEAD_PORT_SENTINEL);
    const allDeadOrNull = results.every((r) => r === DEAD_PORT_SENTINEL || r === null);
    if (someDead && allDeadOrNull && !alreadyRecreated) {
      console.warn(`${LOG} embedBatch: every embed reported "Port does not exist" — invalidating engine cache and retrying chunk`);
      embeddingEnginePromise = null;
      alreadyRecreated = true;
      results = await Promise.all(chunk.map((item) => embed(item, { bypassCache })));
    }
    for (const r of results) out.push(r === DEAD_PORT_SENTINEL ? null : r);
    if (yieldBetween && i + batchSize < inputs.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return out;
};

// ─── Per-tab embeddings for existing rule-matched groups ─────────────────────

const computeExistingGroupTabEmbeddings = async (workspaceId, rules, excludeTabs = new Set(), opts = {}) => {
  const { batchSize, yieldBetween } = opts;
  const ruleNames = new Set(rules.map((r) => r.name));
  const groupEmbeddings = new Map(); // groupName → number[][]
  const groups = document.querySelectorAll(
    `tab-group:has(tab[zen-workspace-id="${workspaceId}"])`
  );
  for (const groupEl of groups) {
    // Filter out Library/sidebar copies so we never embed cloned sidebar groups.
    if (!groupEl?.isConnected || isSidebarCopy(groupEl)) continue;
    const label = groupEl.getAttribute("label");
    if (!label || !ruleNames.has(label)) continue;
    const tabsInGroup = Array.from(
      groupEl.querySelectorAll(`tab[zen-workspace-id="${workspaceId}"]`)
    ).filter((t) => !excludeTabs.has(t));
    if (tabsInGroup.length === 0) continue;

    const inputs = tabsInGroup.map((t) => {
      const url = getTabUrl(t) || t.linkedBrowser?.currentURI?.spec || "";
      return {
        title: getTabTitle(t),
        url,
        hostname: (() => {
          try { return new URL(url).hostname.replace(/^www\./, ""); }
          catch { return ""; }
        })(),
      };
    }).filter((i) => i.title || extractFileInfo(i.url));
    if (inputs.length === 0) continue;
    const embs = (await embedBatch(inputs, { batchSize, yieldBetween })).filter((v) => v);
    if (embs.length === 0) continue;
    groupEmbeddings.set(label, embs);
  }
  return groupEmbeddings;
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const runPass2 = async (unmatched, rules, workspaceId) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!unmatched || unmatched.length === 0) return empty;

  const useChunking = unmatched.length > CONFIG.AI_LOCAL_CHUNK_THRESHOLD;
  const batchSize = useChunking ? getLocalAIBatchSize() : CONFIG.AI_EMBEDDING_BATCH_SIZE;

  let getEmbeddingForTab;

  try {
    if (useChunking) {
      // Dedupe by key: regular hosts collapse per host, multi-topic platforms
      // (YouTube, GitHub, Reddit, Docs, etc.) dedupe by (host, normalizedTitle),
      // and hostless file:// tabs dedupe by file path instead of being dropped.
      const repByKey = new Map();
      for (const t of unmatched) {
        const key = tabEmbeddingDedupeKey(t);
        if (key && !repByKey.has(key)) repByKey.set(key, t);
      }
      const reps = [...repByKey.entries()];
      console.log(`${LOG} AI: large workspace (${unmatched.length} > ${CONFIG.AI_LOCAL_CHUNK_THRESHOLD}) — chunking on, deduped to ${reps.length} unique key(s), batchSize=${batchSize}`);

      const repEmbeddings = await embedBatch(
        reps.map(([, t]) => ({ title: t.title, hostname: t.hostname, url: t.url })),
        { batchSize, yieldBetween: true },
      );
      const keyToEmb = new Map();
      reps.forEach(([key], i) => {
        if (repEmbeddings[i]) keyToEmb.set(key, repEmbeddings[i]);
      });
      getEmbeddingForTab = (tabInfo) => {
        const key = tabEmbeddingDedupeKey(tabInfo);
        return key ? keyToEmb.get(key) : undefined;
      };
    } else {
      const tabEmbeddings = await embedBatch(
        unmatched.map((t) => ({ title: t.title, hostname: t.hostname, url: t.url })),
        { batchSize },
      );
      getEmbeddingForTab = (_tabInfo, idx) => tabEmbeddings[idx];
    }
  } catch (e) {
    console.error(`${LOG} AI: failed to load embedding engine:`, e);
    showToast("AI sorting unavailable — embedding model failed to load");
    return { ...empty, failed: "embedding engine load failed" };
  }

  const excludeSet = new Set(unmatched.map((t) => t._tab).filter((t) => t));
  const groupTabEmbeddings = await computeExistingGroupTabEmbeddings(workspaceId, rules, excludeSet, {
    batchSize: useChunking ? batchSize : undefined,
    yieldBetween: useChunking,
  });
  console.log(`${LOG} AI: collected per-tab embeddings for ${groupTabEmbeddings.size} existing group(s): ${[...groupTabEmbeddings.keys()].map((n) => `${n}(${groupTabEmbeddings.get(n).length})`).join(", ") || "(none)"}`);

  const assignedToExisting = [];
  const remainder = [];
  for (let i = 0; i < unmatched.length; i++) {
    const tabInfo = unmatched[i];
    const emb = getEmbeddingForTab(tabInfo, i);
    if (!emb) { empty.skipped.push(tabInfo); continue; }

    let best = null;
    const allSims = [];
    for (const [groupName, embs] of groupTabEmbeddings) {
      let rawMax = -Infinity;
      for (const tabEmb of embs) {
        const s = cosineSimilarity(emb, tabEmb);
        if (s > rawMax) rawMax = s;
      }
      const raw = rawMax === -Infinity ? 0 : rawMax;
      const sim = raw + CONFIG.AI_EXISTING_GROUP_BOOST;
      allSims.push(`${groupName}=${sim.toFixed(3)}(maxRaw ${raw.toFixed(3)})`);
      if (sim > CONFIG.AI_EXISTING_GROUP_THRESHOLD && (!best || sim > best.sim)) {
        best = { groupName, sim };
      }
    }
    if (allSims.length > 0) {
      const verdict = best
        ? `picked ${best.groupName} (${best.sim.toFixed(3)})`
        : `no match (threshold ${CONFIG.AI_EXISTING_GROUP_THRESHOLD})`;
      console.debug(`${LOG} AI sim for "${tabInfo.hostname || tabInfo.title}": ${allSims.join(", ")} → ${verdict}`);
    }
    if (best) {
      assignedToExisting.push({ tabInfo, groupName: best.groupName, similarity: best.sim });
    } else {
      remainder.push({ info: tabInfo, embedding: emb });
    }
  }

  return {
    assignedToExisting,
    newGroups: [],
    skipped: [...empty.skipped, ...remainder.map((r) => r.info)],
  };
};

// ─── Local Fresh: average/complete-linkage clustering with coherence guard ───

const FRESH_CLUSTER_THRESHOLD = 0.52; // average-linkage cosine threshold
const FRESH_MIN_COHERENCE = 0.35;     // complete-linkage floor preventing A-B-C snowball chains
const FRESH_MIN_CLUSTER_SIZE = 2;     // singletons demoted to skipped

// Common 2-part public suffixes so `bbc.co.uk` -> `bbc.co.uk` (not `co.uk`).
const TWO_PART_PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.nz", "org.nz", "govt.nz",
  "co.za", "org.za",
  "co.in", "org.in", "net.in",
  "co.kr", "or.kr",
  "com.br", "org.br", "net.br",
  "com.mx", "org.mx",
  "com.cn", "org.cn", "net.cn",
  "com.tw", "org.tw",
  "com.hk", "org.hk",
  "com.sg", "org.sg",
  "com.tr", "org.tr",
  "com.ar",
  "co.id", "co.il", "com.pl", "co.at", "or.at",
]);

export const etld1 = (hostname) => {
  if (!hostname) return "";
  const clean = String(hostname).trim().toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
  if (!clean) return "";
  const parts = clean.split(".").filter(Boolean);
  if (parts.length < 2) return clean;
  const lastTwo = parts.slice(-2).join(".");
  if (parts.length >= 3 && TWO_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
};

const titleCase = (s) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;

const nameClusterFromHostnames = (tabs) => {
  const counts = new Map();
  let fileCount = 0;
  const fileExts = new Set();

  for (const t of tabs) {
    const e = etld1(t.hostname);
    if (e) {
      counts.set(e, (counts.get(e) || 0) + 1);
      continue;
    }
    const fi = extractFileInfo(t.url);
    if (fi) {
      fileCount += 1;
      if (fi.ext) fileExts.add(fi.ext);
    }
  }

  if (counts.size === 0) {
    if (fileCount > 0) {
      if (fileExts.size === 1) {
        const onlyExt = [...fileExts][0].toUpperCase();
        return `Local ${onlyExt}s`;
      }
      return "Local Files";
    }
    return "Cluster";
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const baseOf = (e) => titleCase(e.split(".")[0]);
  if (counts.size === 1) return baseOf(sorted[0][0]);
  if (counts.size === 2) return `${baseOf(sorted[0][0])} & ${baseOf(sorted[1][0])}`;
  if (counts.size === 3) return `${baseOf(sorted[0][0])}, ${baseOf(sorted[1][0])} & ${baseOf(sorted[2][0])}`;
  return `${baseOf(sorted[0][0])} + ${counts.size - 1} more`;
};

const INTENT_BY_OG_TYPE = {
  article: "Reading",
  blog: "Reading",
  book: "Reading",
  website: null,
  video: "Watching",
  "video.movie": "Watching",
  "video.episode": "Watching",
  "video.tv_show": "Watching",
  "video.other": "Watching",
  music: "Listening",
  "music.song": "Listening",
  "music.album": "Listening",
  "music.playlist": "Listening",
  "music.radio_station": "Listening",
  product: "Shopping",
  "product.group": "Shopping",
  "product.item": "Shopping",
  profile: "Social",
  place: "Places",
  event: "Events",
};

const intentFromOgType = (type) => {
  if (!type) return null;
  const lower = type.toLowerCase().trim();
  if (INTENT_BY_OG_TYPE[lower] !== undefined) return INTENT_BY_OG_TYPE[lower];
  for (const [k, v] of Object.entries(INTENT_BY_OG_TYPE)) {
    if (lower.startsWith(k + ".")) return v;
  }
  return null;
};

const parseOgTypeFromSnippet = (snippet) => {
  if (!snippet) return null;
  const m = snippet.match(/\[type:\s*([^\]]+)\]/i);
  return m ? m[1].trim().toLowerCase() : null;
};

// English + German stopwords and page-chrome boilerplate.
const STOPWORDS = new Set([
  // English articles, pronouns, prepositions, common verbs
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by","from","as",
  "is","are","was","were","be","been","being","have","has","had","do","does","did","will",
  "would","could","should","may","might","can","this","that","these","those","you","your",
  "we","our","i","my","me","it","its","they","their","them","he","she","his","her","not",
  "into","about","over","under","out","how","what","why","when","where","who","which",
  // German articles, pronouns, prepositions, conjunctions, common verbs
  "der","die","das","den","dem","des","ein","eine","einer","einem","einen","eines",
  "und","oder","aber","doch","denn","weil","wenn","dass","als","wie","was","wer","wo","wann",
  "von","vom","zu","zum","zur","im","am","an","auf","für","fuer","mit","bei","beim","aus",
  "nach","über","ueber","unter","vor","bis","durch","ohne","gegen","um",
  "ist","sind","war","waren","sein","wird","werden","wurde","wurden","haben","hat","hatte",
  "kann","können","koennen","muss","müssen","muessen","soll","nicht","kein","keine","auch",
  "noch","nur","mehr","sehr","hier","dort","dies","diese","dieser","dieses","mein","meine",
  "dein","deine","ihr","ihre","unser","unsere","euer","sich","alle","alles","man","wir","sie",
  // EN + DE page chrome
  "page","home","site","website","official","login","sign","search","menu","welcome",
  "404","error","found","settings","preferences","dashboard","profile","account",
  "startseite","anmelden","suche","konto","einstellungen","übersicht","uebersicht","willkommen","fehler",
  // Generic ranking / filler adjectives (EN + DE)
  "best","top","latest","new","more","less","free","all","most","least","good","great",
  "neu","neue","neuer","neues","beste","kostenlos","gratis",
]);

export const tokenizeForKeywords = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

const parseTopicFromSnippet = (snippet) => {
  if (!snippet) return "";
  const m = snippet.match(/\[topic:\s*([^\]]+)\]/i);
  return m ? m[1].trim() : "";
};

const extractClusterKeywords = (tabs, snippetByKey) => {
  const tokensByUnit = new Map();
  for (const t of tabs) {
    const dedupeKey = tabEmbeddingDedupeKey(t);
    if (!dedupeKey) continue;
    const topic = parseTopicFromSnippet(snippetByKey.get(dedupeKey));
    const fileInfo = !t.hostname ? extractFileInfo(t.url) : null;
    const fileWords = fileInfo ? `${fileInfo.stem.replace(/[_-]+/g, " ")} ${fileInfo.parentDir}` : "";
    const text = `${t.title || ""} ${topic} ${fileWords}`;
    const tokens = new Set(tokenizeForKeywords(text));
    if (t.hostname) {
      const hostBaseTokens = tokenizeForKeywords(t.hostname.replace(/\./g, " "));
      for (const ht of hostBaseTokens) tokens.delete(ht);
    }
    const unitKey = isMultiTopicPlatform(t.hostname) || fileInfo ? dedupeKey : t.hostname;
    if (!tokensByUnit.has(unitKey)) tokensByUnit.set(unitKey, new Set());
    const acc = tokensByUnit.get(unitKey);
    for (const tok of tokens) acc.add(tok);
  }

  const wordToUnits = new Map();
  for (const [unitKey, tokens] of tokensByUnit) {
    for (const tok of tokens) {
      if (!wordToUnits.has(tok)) wordToUnits.set(tok, new Set());
      wordToUnits.get(tok).add(unitKey);
    }
  }
  const uniqueUnits = tokensByUnit.size;
  const minShare = Math.max(2, Math.ceil(uniqueUnits / 2));
  return [...wordToUnits.entries()]
    .filter(([, units]) => units.size >= minShare)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 2)
    .map(([word]) => word);
};

const titleCaseToken = (s) =>
  s.split(/(\s|-|')/).map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p)).join("");

const nameClusterFromSignals = (tabs, snippetByKey) => {
  const intentCounts = new Map();
  for (const t of tabs) {
    const key = tabEmbeddingDedupeKey(t);
    const snip = key ? snippetByKey.get(key) : "";
    const ogType = parseOgTypeFromSnippet(snip);
    const intent = intentFromOgType(ogType);
    if (intent) intentCounts.set(intent, (intentCounts.get(intent) || 0) + 1);
  }
  let intentName = null;
  if (intentCounts.size > 0) {
    const sorted = [...intentCounts.entries()].sort((a, b) => b[1] - a[1]);
    const [topIntent, topCount] = sorted[0];
    if (topCount >= Math.ceil(tabs.length / 2)) intentName = topIntent;
  }

  const keywords = extractClusterKeywords(tabs, snippetByKey);
  if (keywords.length > 0 && intentName) {
    return `${titleCaseToken(keywords[0])} ${intentName}`;
  }
  if (keywords.length > 0) {
    return keywords.map(titleCaseToken).join(" ");
  }
  if (intentName) return intentName;
  return nameClusterFromHostnames(tabs);
};

/**
 * Agglomerative average-linkage clustering with complete-linkage coherence guard.
 * Eliminates the single-linkage snowball effect (where A~B and B~C merge A and C
 * even when sim(A, C) is near zero).
 *
 * @param {number[][]} embeddings — array of unit-length embedding vectors
 * @param {object} [opts]
 * @param {number} [opts.mergeThreshold=0.52] — minimum average pairwise similarity between clusters
 * @param {number} [opts.minCoherence=0.35]   — minimum pairwise similarity across all pairs (complete-linkage guard)
 * @returns {number[][]} clusters as arrays of indices into `embeddings`
 */
export const clusterEmbeddings = (
  embeddings,
  {
    mergeThreshold = FRESH_CLUSTER_THRESHOLD,
    minCoherence = FRESH_MIN_COHERENCE,
  } = {},
) => {
  const n = Array.isArray(embeddings) ? embeddings.length : 0;
  if (n === 0) return [];
  if (n === 1) return [[0]];

  // Precompute symmetric pairwise cosine similarity matrix.
  const simMatrix = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    simMatrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(embeddings[i], embeddings[j]);
      simMatrix[i][j] = s;
      simMatrix[j][i] = s;
    }
  }

  // Start with each embedding in its own singleton cluster.
  const clusters = Array.from({ length: n }, (_, i) => [i]);

  while (clusters.length > 1) {
    let bestI = -1;
    let bestJ = -1;
    let bestAvg = -Infinity;

    for (let i = 0; i < clusters.length; i++) {
      const ca = clusters[i];
      for (let j = i + 1; j < clusters.length; j++) {
        const cb = clusters[j];
        let sum = 0;
        let minPair = Infinity;
        let blocked = false;

        for (let a = 0; a < ca.length; a++) {
          const row = simMatrix[ca[a]];
          for (let b = 0; b < cb.length; b++) {
            const s = row[cb[b]];
            if (s < minPair) minPair = s;
            if (s < minCoherence) {
              blocked = true;
              break;
            }
            sum += s;
          }
          if (blocked) break;
        }

        if (blocked || minPair < minCoherence) continue;
        const avg = sum / (ca.length * cb.length);
        if (avg >= mergeThreshold && avg > bestAvg) {
          bestAvg = avg;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestI === -1 || bestJ === -1) break;
    // Merge cluster bestJ into cluster bestI.
    clusters[bestI].push(...clusters[bestJ]);
    clusters.splice(bestJ, 1);
  }

  return clusters;
};

/**
 * Cluster eligible tabs into NEW groups using embedding similarity alone.
 *
 * @param {Array} tabs — all eligible tab info objects
 */
export const runPass2Fresh = async (tabs) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!tabs || tabs.length === 0) return empty;

  // Dedupe using multi-topic-aware + file://-aware keys so YouTube/GitHub/Docs
  // tabs keep distinct embeddings and local file:// tabs are included.
  const repByKey = new Map();
  for (const t of tabs) {
    const key = tabEmbeddingDedupeKey(t);
    if (key && !repByKey.has(key)) repByKey.set(key, t);
  }
  const repEntries = [...repByKey.entries()];
  const reps = repEntries.map(([, t]) => t);
  const useChunking = tabs.length > CONFIG.AI_LOCAL_CHUNK_THRESHOLD;
  const batchSize = useChunking ? getLocalAIBatchSize() : CONFIG.AI_EMBEDDING_BATCH_SIZE;
  console.log(
    `${LOG} Local Fresh: ${tabs.length} tab(s) → ${reps.length} unique embedding key(s), batchSize=${batchSize}, chunking=${useChunking}`
  );

  const snippetT0 = performance.now();
  const snippets = await fetchPageSnippets(reps);
  const hitCount = snippets.filter((s) => s).length;
  console.log(
    `${LOG} Local Fresh: fetched page snippets for ${hitCount}/${reps.length} tab(s) in ${Math.round(performance.now() - snippetT0)}ms`
  );

  const snippetByKey = new Map();
  repEntries.forEach(([key], i) => {
    if (snippets[i]) snippetByKey.set(key, snippets[i]);
  });

  const validKeys = [];
  const validEmbeddings = [];
  try {
    const repInputs = reps.map((t, i) => {
      const base = buildEmbedText({ title: t.title, hostname: t.hostname, url: t.url });
      const parts = [];
      if (base) parts.push(base);
      if (snippets[i]) parts.push(snippets[i]);
      return parts.join(" ").trim() || t.hostname || t.title || "";
    });
    const repEmbeddings = await embedBatch(repInputs, { batchSize, yieldBetween: useChunking });
    repEntries.forEach(([key], i) => {
      if (repEmbeddings[i]) {
        validKeys.push(key);
        validEmbeddings.push(repEmbeddings[i]);
      }
    });
  } catch (e) {
    console.error(`${LOG} Local Fresh: embedding engine failed:`, e);
    showToast("Local clustering unavailable — embedding model failed to load");
    return { ...empty, skipped: tabs, failed: "embedding engine load failed" };
  }

  // Agglomerative average-linkage clustering with coherence guard.
  const indexClusters = clusterEmbeddings(validEmbeddings, {
    mergeThreshold: FRESH_CLUSTER_THRESHOLD,
    minCoherence: FRESH_MIN_COHERENCE,
  });

  const keyToCluster = new Map();
  indexClusters.forEach((memberIndices, cid) => {
    for (const idx of memberIndices) {
      keyToCluster.set(validKeys[idx], cid);
    }
  });

  const clusters = new Map();
  const skipped = [];
  for (const t of tabs) {
    const key = tabEmbeddingDedupeKey(t);
    const cid = key ? keyToCluster.get(key) : undefined;
    if (cid === undefined) { skipped.push(t); continue; }
    if (!clusters.has(cid)) clusters.set(cid, []);
    clusters.get(cid).push(t);
  }

  const rawGroups = [];
  for (const members of clusters.values()) {
    if (members.length < FRESH_MIN_CLUSTER_SIZE) {
      skipped.push(...members);
    } else {
      rawGroups.push({ name: nameClusterFromSignals(members, snippetByKey), tabs: members });
    }
  }

  const byName = new Map();
  const newGroups = [];
  let nameDedupes = 0;
  for (const g of rawGroups) {
    const lower = g.name.toLowerCase();
    if (byName.has(lower)) {
      byName.get(lower).tabs.push(...g.tabs);
      nameDedupes++;
    } else {
      byName.set(lower, g);
      newGroups.push(g);
    }
  }
  if (nameDedupes > 0) {
    console.log(`${LOG} Local Fresh: deduped ${nameDedupes} duplicate-named cluster(s)`);
  }

  console.log(
    `${LOG} Local Fresh: ${newGroups.length} cluster(s), ${skipped.length} singleton(s)/no-host tab(s) skipped`
  );
  return { assignedToExisting: [], newGroups, skipped };
};

// ─── Apply the AI decisions ───────────────────────────────────────────────────

const addDomainToRule = (ruleName, hostname, rules) => {
  const lower = String(ruleName || "").trim().toLowerCase();
  const rule = (rules || []).find((r) => String(r?.name || "").trim().toLowerCase() === lower);
  if (!rule) return false;
  const host = String(hostname || "").trim().toLowerCase();
  if (!host || (rule.domains || []).some((d) => String(d).toLowerCase() === host)) return false;
  rule.domains.push(host);
  return true;
};

const pickAvailableColor = (usedSet) => {
  const available = PRESET_COLORS.filter((c) => !usedSet.has(c.name));
  const pool = available.length > 0 ? available : PRESET_COLORS;
  const pick = pool[Math.floor(Math.random() * pool.length)].name;
  usedSet.add(pick);
  return pick;
};

const openZenEditModalForGroup = (groupEl) => {
  try {
    const tgm = window.gBrowser?.tabGroupMenu;
    if (tgm) {
      if (typeof tgm.openEditModal === "function") { tgm.openEditModal(groupEl); return true; }
      if (typeof tgm.openCreate === "function")    { tgm.openCreate(groupEl); return true; }
    }
    const label = groupEl.querySelector(".tab-group-label");
    if (label) { label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return true; }
  } catch (e) {
    console.warn(`${LOG} could not open Zen edit modal:`, e);
  }
  return false;
};

export const applyPass2 = (pass2Result, workspaceId, rules, options = {}) => {
  const existingBehavior = options.existingBehavior || getAIExistingBehavior();
  const newGroupBehavior = options.newGroupBehavior || getAINewGroupBehavior();
  const persistRules = options.persistRules !== false;

  let movedToExisting = 0;
  let rulesGrown = 0;
  let newGroupsCreated = 0;
  let newRulesCreated = 0;

  const safeRules = Array.isArray(rules) ? rules : [];
  const ruleColorByLower = new Map(
    safeRules
      .filter((r) => r?.name && typeof r.color === "string" && r.color.trim())
      .map((r) => [r.name.trim().toLowerCase(), r.color.trim()]),
  );

  const usedColors = new Set(
    safeRules.map((r) => r.color).filter((c) => typeof c === "string" && c.length > 0)
  );
  if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
    try {
      const selector = workspaceId
        ? `tab-group:has(tab[zen-workspace-id="${workspaceId}"]), tab-group[zen-workspace-id="${workspaceId}"]`
        : "tab-group";
      for (const groupEl of document.querySelectorAll(selector)) {
        if (isSidebarCopy(groupEl)) continue;
        const color = groupEl.color || groupEl.getAttribute?.("color");
        if (typeof color === "string" && color.trim()) usedColors.add(color.trim());
      }
    } catch {}
  }

  const ungroupApi = typeof gBrowser?.ungroupTab === "function" ? gBrowser.ungroupTab.bind(gBrowser) : null;

  // 1. Move tabs into existing groups (batching per group so collapse state is
  //    preserved once per group AND evaporated target groups are created on demand).
  const existingBuckets = new Map(); // lowerName -> { groupName, items[] }
  for (const a of pass2Result?.assignedToExisting || []) {
    const groupName = String(a?.groupName || "").trim();
    if (!groupName) continue;
    const key = groupName.toLowerCase();
    if (!existingBuckets.has(key)) {
      existingBuckets.set(key, { groupName, items: [] });
    }
    existingBuckets.get(key).items.push(a);
  }

  for (const [lowerName, bucket] of existingBuckets) {
    const { groupName, items } = bucket;
    const validItems = items.filter((a) => a?.tabInfo?._tab?.isConnected);
    if (validItems.length === 0) continue;

    const groupEl = findExistingGroup(groupName, workspaceId);

    if (groupEl?.isConnected) {
      try {
        const wasCollapsed = expandIfCollapsed(groupEl);
        for (const a of validItems) {
          const tab = a.tabInfo._tab;
          if (tab?.isConnected && tab.closest("tab-group") !== groupEl) {
            gBrowser.moveTabToExistingGroup(tab, groupEl);
            movedToExisting++;
          }
          if (existingBehavior === "always-add") {
            if (addDomainToRule(groupName, a.tabInfo.hostname, safeRules)) rulesGrown++;
          }
        }
        if (wasCollapsed) {
          collapseGroup(groupEl);
        }
      } catch (e) {
        console.error(`${LOG} AI: failed to move tab(s) into "${groupName}":`, e);
      }
    } else {
      // XCUT-04: target group evaporated (e.g., planned Pass-1 rule group not yet in DOM
      // or dissolved before applyPass2). Create it on demand instead of silently dropping tabs.
      const tabsToGroup = validItems.map((a) => a.tabInfo._tab);
      const color = ruleColorByLower.get(lowerName) || pickAvailableColor(usedColors);
      usedColors.add(color);
      try {
        if (ungroupApi) {
          for (const tab of tabsToGroup) {
            if (tab.closest("tab-group")) {
              try { ungroupApi(tab); } catch (e) {
                console.warn(`${LOG} AI: ungroupTab failed before on-demand group "${groupName}", continuing:`, e);
              }
            }
          }
        }
        const createdGroup = gBrowser.addTabGroup(tabsToGroup, {
          label: groupName,
          insertBefore: findSafeInsertAnchor(),
          color,
        });
        if (createdGroup) {
          newGroupsCreated++;
          movedToExisting += tabsToGroup.length;
          applyGroupColor(createdGroup, color);
          captureNewGroupAppearance(createdGroup);
          if (existingBehavior === "always-add") {
            for (const a of validItems) {
              if (addDomainToRule(groupName, a.tabInfo.hostname, safeRules)) rulesGrown++;
            }
          }
        } else {
          console.warn(`${LOG} AI: on-demand addTabGroup returned no element for "${groupName}" (${tabsToGroup.length} tab(s))`);
        }
      } catch (e) {
        console.error(`${LOG} AI: failed to create missing existing group "${groupName}" on demand:`, e);
      }
    }
  }

  // 2. Create new groups from each cluster.
  for (const cluster of pass2Result?.newGroups || []) {
    const tabs = (cluster?.tabs || []).map((t) => t._tab).filter((t) => t?.isConnected);
    if (tabs.length === 0) continue;

    const color = pickAvailableColor(usedColors);

    try {
      if (ungroupApi) {
        for (const tab of tabs) {
          if (tab.closest("tab-group")) {
            try { ungroupApi(tab); } catch (e) {
              console.warn(`${LOG} AI: ungroupTab failed before creating "${cluster.name}", continuing:`, e);
            }
          }
        }
      }

      const newGroup = gBrowser.addTabGroup(tabs, {
        label: cluster.name,
        insertBefore: findSafeInsertAnchor(),
        color,
      });
      if (!newGroup) {
        console.warn(`${LOG} AI: addTabGroup returned no element for "${cluster.name}" (${tabs.length} tab(s))`);
        continue;
      }
      newGroupsCreated++;

      applyGroupColor(newGroup, color);
      captureNewGroupAppearance(newGroup);

      if (newGroupBehavior === "auto-add") {
        const hostnames = [...new Set(cluster.tabs.map((t) => t.hostname).filter((h) => h))];
        if (hostnames.length > 0 && !safeRules.some((r) => r.name.toLowerCase() === cluster.name.toLowerCase())) {
          safeRules.push({ name: cluster.name, domains: hostnames, color });
          newRulesCreated++;
        }
      } else if (newGroupBehavior === "prompt") {
        openZenEditModalForGroup(newGroup);
      }
    } catch (e) {
      console.error(`${LOG} AI: failed to create new group "${cluster.name}":`, e);
    }
  }

  if (persistRules && (rulesGrown > 0 || newRulesCreated > 0)) writeRulesPref(safeRules);

  return { movedToExisting, rulesGrown, newGroupsCreated, newRulesCreated };
};
