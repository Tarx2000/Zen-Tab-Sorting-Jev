// Zen Tab Sorting — sorting mode decisions.
//
// Single authority for sorting mode normalization, freshLike, preview, and
// Pass 1 application decisions. Keeps SORTING_MODES.HYBRID as a backward-compat
// alias unified with RULES_FIRST.

export const SORTING_MODES = {
  RULES_FIRST: "rules-first",
  HYBRID: "rules-first",
  FULL_AI: "full-ai",
};

export const normalizeSortingMode = (mode) => {
  if (mode === SORTING_MODES.FULL_AI) return SORTING_MODES.FULL_AI;
  if (mode === SORTING_MODES.RULES_FIRST || mode === "hybrid") return SORTING_MODES.RULES_FIRST;
  return SORTING_MODES.RULES_FIRST;
};

export const resolveEffectiveSortingMode = ({ aiEngine, preferredMode }) =>
  aiEngine === "off" ? SORTING_MODES.RULES_FIRST : normalizeSortingMode(preferredMode);

export const isFullAIMode = (mode) => normalizeSortingMode(mode) === SORTING_MODES.FULL_AI;

export const resolvePass2ApplyOptions = (mode) =>
  isFullAIMode(mode)
    ? {
        existingBehavior: "transient",
        newGroupBehavior: "transient",
        persistRules: false,
      }
    : {};

export const resolveSortingPlan = ({
  mode,
  tabs = [],
  pass1,
  newGroupBehavior = "",
  domainRulesEnabled = true,
} = {}) => {
  const resolvedMode = normalizeSortingMode(mode);
  const fullAI = resolvedMode === SORTING_MODES.FULL_AI;
  const emptyByGroup = new Map();
  const unmatched = Array.isArray(pass1?.unmatched) ? pass1.unmatched : [];
  const shouldApplyPass1 = !fullAI && Boolean(domainRulesEnabled);
  const isFreshCategories = newGroupBehavior === "fresh-categories";
  const isIdentifyOnly = newGroupBehavior === "identify-only";
  const freshLike = fullAI || isFreshCategories || isIdentifyOnly;
  const preview = newGroupBehavior === "preview" || isIdentifyOnly;

  return {
    mode: resolvedMode,
    applyPass1: shouldApplyPass1,
    shouldApplyPass1,
    pass1ByGroup: shouldApplyPass1 && pass1?.byGroup instanceof Map ? pass1.byGroup : emptyByGroup,
    tabsForAI: freshLike ? tabs : unmatched,
    aiInputLabel: freshLike ? "ALL eligible tab(s)" : "unmatched tab(s)",
    freshLike,
    preview,
  };
};
