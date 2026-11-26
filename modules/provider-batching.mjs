// Zen Tab Sorting — provider request batching (count-based + token-aware).
//
// Remote/provider LLMs should not receive a 300-tab prompt in one shot. Keep
// chunks bounded by BOTH tab count and estimated input token budget, then merge
// chunk-local JSON maps back onto original tabs.

export const PROVIDER_TAB_BATCH_SIZE = 75;
export const DEFAULT_MAX_INPUT_TOKENS = 6000;
export const DEFAULT_OVERHEAD_TOKENS = 600;

const CHARS_PER_TOKEN = 3.5;
const PER_TAB_FORMAT_TOKENS = 12;

export const chunkTabsForProvider = (tabs, batchSize = PROVIDER_TAB_BATCH_SIZE) => {
  if (!Array.isArray(tabs) || tabs.length === 0) return [];
  const width = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : PROVIDER_TAB_BATCH_SIZE;
  const chunks = [];
  for (let start = 0; start < tabs.length; start += width) {
    chunks.push({
      start,
      tabs: tabs.slice(start, start + width),
    });
  }
  return chunks;
};

// Backward-compatible / concise alias
export const chunkTabs = chunkTabsForProvider;

/**
 * Estimate prompt tokens consumed by a single tab entry (hostname, title,
 * optional sanitized path/URL, and optional page snippet).
 */
export const estimateTabTokens = (tab, snippet = "") => {
  if (!tab || typeof tab !== "object") return PER_TAB_FORMAT_TOKENS;
  const hostLen = String(tab.hostname || "").length;
  const titleLen = String(tab.title || "").length;
  const pathLen = String(tab.cleanPath || tab.path || "").length;
  const snippetLen = String(snippet || tab.snippet || "").length;
  const textChars = hostLen + titleLen + pathLen + snippetLen;
  return PER_TAB_FORMAT_TOKENS + Math.ceil(textChars / CHARS_PER_TOKEN);
};

/**
 * Token-aware tab chunking: packs tabs into chunks that respect BOTH `maxTabs`
 * and `maxInputTokens` (after subtracting `overheadTokens`). Always places at
 * least 1 tab in a chunk even if an individual tab exceeds the budget.
 */
export const chunkTabsByBudget = (
  tabs,
  {
    maxTabs = PROVIDER_TAB_BATCH_SIZE,
    maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
    overheadTokens = DEFAULT_OVERHEAD_TOKENS,
    snippets = [],
  } = {},
) => {
  if (!Array.isArray(tabs) || tabs.length === 0) return [];
  const tabCap = Number.isFinite(maxTabs) && maxTabs > 0 ? Math.floor(maxTabs) : PROVIDER_TAB_BATCH_SIZE;
  const inputBudget = Number.isFinite(maxInputTokens) && maxInputTokens > 0
    ? Math.floor(maxInputTokens)
    : DEFAULT_MAX_INPUT_TOKENS;
  const overhead = Number.isFinite(overheadTokens) && overheadTokens >= 0
    ? Math.floor(overheadTokens)
    : DEFAULT_OVERHEAD_TOKENS;
  const availableForTabs = Math.max(100, inputBudget - overhead);

  const chunks = [];
  let currentTabs = [];
  let currentSnippets = [];
  let currentStart = 0;
  let currentTokens = 0;

  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    const snippet = Array.isArray(snippets) ? (snippets[i] || "") : "";
    const tabTokens = estimateTabTokens(tab, snippet);

    const wouldExceedTabs = currentTabs.length >= tabCap;
    const wouldExceedTokens = currentTabs.length > 0 && currentTokens + tabTokens > availableForTabs;

    if (wouldExceedTabs || wouldExceedTokens) {
      chunks.push({
        start: currentStart,
        tabs: currentTabs,
        snippets: currentSnippets,
        estimatedTokens: overhead + currentTokens,
      });
      currentStart = i;
      currentTabs = [];
      currentSnippets = [];
      currentTokens = 0;
    }

    currentTabs.push(tab);
    currentSnippets.push(snippet);
    currentTokens += tabTokens;
  }

  if (currentTabs.length > 0) {
    chunks.push({
      start: currentStart,
      tabs: currentTabs,
      snippets: currentSnippets,
      estimatedTokens: overhead + currentTokens,
    });
  }

  return chunks;
};
