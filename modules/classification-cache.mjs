// Zen Tab Sorting — Bounded in-memory LRU caches for classification & embeddings.
//
// Pure in-memory caches (no disk I/O, no external dependencies):
//   - classificationCache (20 min TTL, max 500 entries) — caches JEV decisions
//     keyed by deterministic hash of tab identity + workspace group signature +
//     model + thresholds.
//   - embeddingCache (30 min TTL, max 800 entries) — caches normalized local ML
//     embeddings keyed by embedding input text.

const DEFAULT_CLASSIFICATION_MAX_ENTRIES = 500;
const DEFAULT_CLASSIFICATION_TTL_MS = 20 * 60 * 1000;

const DEFAULT_EMBEDDING_MAX_ENTRIES = 800;
const DEFAULT_EMBEDDING_TTL_MS = 30 * 60 * 1000;

/**
 * Create a bounded in-memory LRU cache with per-entry TTL expiration.
 *
 * @param {object} [options]
 * @param {number} [options.maxEntries=500]
 * @param {number} [options.ttlMs=1200000]
 * @param {() => number} [options.now]
 */
export const createLRUCache = ({
  maxEntries = 500,
  ttlMs = 20 * 60 * 1000,
  now = () => Date.now(),
} = {}) => {
  const limit = Math.max(1, Number.isFinite(maxEntries) ? Math.floor(maxEntries) : 500);
  const ttl = Math.max(0, Number.isFinite(ttlMs) ? ttlMs : 0);
  const store = new Map();
  let hits = 0;
  let misses = 0;

  const isExpired = (entry, timestamp) => ttl > 0 && timestamp > entry.expiresAt;

  const get = (key) => {
    if (!store.has(key)) {
      misses += 1;
      return undefined;
    }
    const entry = store.get(key);
    const ts = now();
    if (isExpired(entry, ts)) {
      store.delete(key);
      misses += 1;
      return undefined;
    }
    // Promote to most-recently-used position.
    store.delete(key);
    store.set(key, entry);
    hits += 1;
    return entry.value;
  };

  const has = (key) => {
    if (!store.has(key)) return false;
    const entry = store.get(key);
    if (isExpired(entry, now())) {
      store.delete(key);
      return false;
    }
    return true;
  };

  const set = (key, value) => {
    const ts = now();
    if (store.has(key)) {
      store.delete(key);
    }
    store.set(key, {
      value,
      expiresAt: ttl > 0 ? ts + ttl : Infinity,
    });
    while (store.size > limit) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
    return value;
  };

  const del = (key) => store.delete(key);

  const clear = () => {
    store.clear();
  };

  const pruneExpired = () => {
    if (ttl <= 0) return 0;
    const ts = now();
    let removed = 0;
    for (const [key, entry] of store) {
      if (isExpired(entry, ts)) {
        store.delete(key);
        removed += 1;
      }
    }
    return removed;
  };

  const stats = () => ({
    size: store.size,
    maxEntries: limit,
    ttlMs: ttl,
    hits,
    misses,
  });

  return {
    get,
    set,
    has,
    delete: del,
    clear,
    pruneExpired,
    stats,
    get size() {
      return store.size;
    },
  };
};

// Fast deterministic 64-bit (dual FNV-1a 32-bit) hex digest with zero Node-only
// crypto imports so it works identically in Zen chrome JS and Node tests.
export const hashCacheKey = (input) => {
  const str = typeof input === "string" ? input : JSON.stringify(input ?? "");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (code + i) & 0xffff;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
};

/**
 * Deterministic signature representing the current workspace groups (names,
 * domains, and sample tab context). Changes whenever a group is added, removed,
 * renamed, or materially changed so cached decisions naturally miss.
 *
 * @param {Array<{ name?: string, domains?: string[], tabs?: Array<{ title?: string, hostname?: string }> }>} existingGroups
 * @returns {string}
 */
export const buildGroupsSignature = (existingGroups) => {
  if (!Array.isArray(existingGroups) || existingGroups.length === 0) return "empty";
  const normalized = existingGroups
    .filter((g) => g && typeof g.name === "string" && g.name.trim())
    .map((g) => {
      const name = g.name.trim();
      const domains = Array.isArray(g.domains)
        ? [...new Set(g.domains.map((d) => String(d || "").trim().toLowerCase()).filter(Boolean))].sort().slice(0, 8)
        : [];
      const tabSignals = Array.isArray(g.tabs)
        ? g.tabs
            .map((t) => `${String(t?.hostname || "").trim().toLowerCase()}|${String(t?.title || "").replace(/\s+/g, " ").trim().slice(0, 60)}`)
            .filter((s) => s !== "|")
            .sort()
            .slice(0, 6)
        : [];
      return { n: name, d: domains, t: tabSignals };
    })
    .sort((a, b) => a.n.toLowerCase().localeCompare(b.n.toLowerCase()) || a.n.localeCompare(b.n));

  return hashCacheKey(normalized);
};

/**
 * Deterministic cache key for a single tab classification decision.
 */
export const buildClassificationCacheKey = ({
  url = "",
  hostname = "",
  title = "",
  groupsSignature = "",
  model = "",
  minProbability = 0,
  minMargin = 0,
  workspaceName = "",
  containerLabel = "",
} = {}) => {
  const normUrl = String(url || "").trim();
  const normHost = String(hostname || "").trim().toLowerCase();
  const normTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const normProb = Number.isFinite(Number(minProbability)) ? Number(minProbability).toFixed(4) : "0";
  const normMargin = Number.isFinite(Number(minMargin)) ? Number(minMargin).toFixed(4) : "0";
  return hashCacheKey([
    normUrl || normHost,
    normTitle,
    String(groupsSignature || ""),
    String(model || "").trim(),
    normProb,
    normMargin,
    String(workspaceName || "").trim(),
    String(containerLabel || "").trim(),
  ]);
};

export const MAX_EMBED_CACHE_KEY_CHARS = 1000;

/**
 * Build canonical text key for the embedding cache, matching `buildEmbedText`.
 */
export const buildEmbeddingCacheKey = (input) => {
  if (typeof input === "string") {
    return input.trim().slice(0, MAX_EMBED_CACHE_KEY_CHARS);
  }
  if (!input || typeof input !== "object") return "";
  const title = String(input.title || "").trim();
  const hostname = String(input.hostname || "").trim();
  const text = hostname ? `${title} (${hostname})`.trim() : title;
  return text.slice(0, MAX_EMBED_CACHE_KEY_CHARS);
};

// Exported singletons
export const classificationCache = createLRUCache({
  maxEntries: DEFAULT_CLASSIFICATION_MAX_ENTRIES,
  ttlMs: DEFAULT_CLASSIFICATION_TTL_MS,
});

export const embeddingCache = createLRUCache({
  maxEntries: DEFAULT_EMBEDDING_MAX_ENTRIES,
  ttlMs: DEFAULT_EMBEDDING_TTL_MS,
});

export const invalidateClassificationCache = () => {
  classificationCache.clear();
};

export const invalidateEmbeddingCache = () => {
  embeddingCache.clear();
};
