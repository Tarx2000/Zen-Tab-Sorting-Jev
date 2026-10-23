// Zen Tab Sorting — Ollama & Fallback-LLM prompt builders.
//
// Pure string-building functions for the prompts we send to LLMs:
//   - classifyExisting         → "fit each tab into one of the existing categories"
//   - cluster                  → "these tabs don't fit existing categories, invent new ones"
//   - unified                  → single-call combination of the above two
//   - fresh                    → Arc-Tidy: ignore existing categories, re-cluster everything
//   - merge                    → "consolidate these over-specialized categories"
//   - buildOneShotNewGroupsPrompt → Stage 2 One-Shot Fallback-LLM for tabs JEV did not place
//
// No side effects, no I/O, no `await`. Pulled out of ollama.mjs to keep the
// orchestrator file focused on flow rather than prose.

const MAX_DOMAINS_PER_CATEGORY = 6;
const TITLE_LIMIT = 120;

// "- Shopping: amazon.com, costco.com" lines for each rule with examples.
const renderCategoryList = (rules) =>
  rules
    .filter((r) => r?.name)
    .map((r) => {
      const examples = (r.domains || []).slice(0, MAX_DOMAINS_PER_CATEGORY).join(", ");
      return examples ? `- ${r.name}: ${examples}` : `- ${r.name}`;
    })
    .join("\n");

// "0. amazon.com — "Amazon.com — Spend less. Smile more."" with an optional
// indented "Summary:" line when a page snippet is provided.
const renderTabLine = (t, i, snippet) => {
  const title = (t.title || "").slice(0, TITLE_LIMIT).replace(/\s+/g, " ").trim();
  const host = t.hostname || "(no hostname)";
  const summaryLine = snippet ? `\n   Summary: "${snippet}"` : "";
  return `${i}. ${host} — "${title}"${summaryLine}`;
};

const renderTabList = (tabs, snippets) =>
  tabs.map((t, i) => renderTabLine(t, i, snippets?.[i])).join("\n");

// ─── One-Shot Fallback-LLM (Stage 2 after JEV) ─────────────────────────────
//
// Receives ALL remaining ungrouped tabs in a single call after JEV has already
// placed any tabs that belonged in existing workspace groups. Creates new group
// names and assigns tabs in one shot, requiring at least 2 related tabs per new
// group and leaving isolated exotic/singleton tabs as "skipped".

export const buildOneShotNewGroupsPrompt = (leftoverTabs, snippets = [], existingGroupNames = []) => {
  const existingNote = Array.isArray(existingGroupNames) && existingGroupNames.length > 0
    ? `\nAlready existing workspace groups (do NOT reuse these names; create NEW group names for the remaining tabs):\n${existingGroupNames.map((n) => `- ${n}`).join("\n")}\n`
    : "";

  const lastIdx = Math.max(0, leftoverTabs.length - 1);
  const exampleObj = leftoverTabs.length >= 3
    ? `{"0": "Project Alpha", "1": "Project Alpha", "2": "skipped"}`
    : `{"0": "Project Alpha", "1": "Project Alpha"}`;

  return `You are organizing browser tabs that did not fit into any existing tab group. Look at ALL of the ungrouped tabs below together in one shot, invent sensible NEW group names for related tabs, and assign each tab to its new group.
${existingNote}
Ungrouped Tabs (indices 0 to ${lastIdx}):
${renderTabList(leftoverTabs, snippets)}

Each tab line may include a Summary with bracketed page signals:
- [type: ...] — page type (article, video, product, document, website, etc.)
- [site: ...] — site or brand name
- [topic: ...] — main heading / document title on the page

Guidelines:
- Group tabs by the user's current CONTEXT, PROJECT, or INTENT (using the page title, topic, and summary), not rigid domain-only rules. For example, a Canva or Google Docs tab about a business pitch belongs with Business/Work tabs, whereas a personal invitation belongs with Personal/Event tabs.
- Invent short, clear, natural category names in Title Case (1-3 words).
- Only create a new group when AT LEAST 2 tabs clearly belong together in that group.
- If a tab is an isolated outlier/exotic singleton that does not share a meaningful group with any other tab in this list, assign it "skipped" so it stays ungrouped.
- Do not echo a tab's full title or raw hostname as the group name.
- Do not include meta words like "new", "category", "label", "topic", or "group" in the group name.

STRICT OUTPUT SCHEMA:
- Return ONLY a valid raw JSON object (no markdown fences, no \`\`\`json, no prose before or after).
- Every tab index from "0" to "${lastIdx}" MUST be present as a string key.
- Every value MUST be a non-empty string: either the new group name (1-3 words, Title Case) or "skipped".
- Example valid output: ${exampleObj}`;
};

export const buildOneShotSchemaRetryPrompt = (baseInput, schemaError, attemptNumber, tabCount) => {
  const lastIdx = Math.max(0, tabCount - 1);
  return `${baseInput}

IMPORTANT — RETRY ATTEMPT ${attemptNumber}/3 (PREVIOUS RESPONSE FAILED SCHEMA VALIDATION):
Reason: ${schemaError}
You MUST respond with ONLY a single flat JSON object mapping every string key from "0" through "${lastIdx}" to a non-empty string value (either a 1-3 word Title Case group name or "skipped"). Do not wrap in markdown code blocks and do not omit any index.`;
};

// ─── Classify (Phase 3: fit into existing) ──────────────────────────────────

export const buildClassifyPrompt = (rules, unmatched) =>
  `Categorize each browser tab into one of the existing categories below. Pick the category whose example domains are most similar to the tab's hostname or topic.

Categories:
${renderCategoryList(rules)}

Tabs:
${renderTabList(unmatched)}

Output ONLY a JSON object mapping each tab number (as a string key) to the chosen category name. Use "none" ONLY for tabs that are genuinely unrelated to every category — most tabs should match a category.`;

// ─── Cluster (older fallback: invent new groups for unmatched) ──────────────

export const buildClusterPrompt = (leftover) =>
  `These browser tabs don't fit any existing category. Group them into one or more NEW categories.

Guidelines:
- Use short, clear category names in Title Case (1-3 words)
- Group tabs together when they share a clear topic, type of site, or purpose
- A single tab can be its own category if it's clearly its own topic
- Put tabs that have no meaningful category in "skipped"

Tabs:
${renderTabList(leftover)}

Output ONLY a JSON object with this exact shape:
{
  "groups": [
    {"name": "Gaming", "tabs": [0, 3]},
    {"name": "Recipes", "tabs": [1]}
  ],
  "skipped": [2, 4]
}`;

// ─── Unified (Phase 4b: single-call classify + invent) ──────────────────────

export const buildUnifiedPrompt = (rules, unmatched, snippets) =>
  `Sort the tabs below into a small number of buckets. Look at all of them together before deciding.

For each tab, pick a single label that is one of:
- One of the existing labels listed (matched exactly)
- A short new label of your choosing (1-3 words, plain Title Case)
- "skipped" if the tab really doesn't fit with anything

Guidance:
- Use an existing label only when the tab is the SAME KIND of thing as that label's example domains — same service, same provider, or a near-equivalent substitute. The example domains define what the label means. Do NOT use an existing label as a generic catch-all because its name sounds related. If no existing label closely fits, create a new label or "skipped".
- Several tabs about the same topic should share the SAME label. For example, three different gaming sites (news, marketplace, ranking) all belong under ONE shared label.
- Aim for 4-10 stable intent buckets across a normal workspace. For this batch, add at most 1-2 new labels when possible. Broad but coherent buckets beat narrow one-tab labels.
- Keep adjacent intent families separate unless the tabs clearly share the same exact task: Docs (files, documents, writing) vs Research (articles, papers, reference reading) vs Work (trackers, admin, ops, business tools).
- Keep Shopping (products, carts, stores) separate from Finance (banking, payments, taxes, invoices) and Planning (calendar, maps, bookings, trips, events).
- Keep Communication (email, chat, messages, meetings) separate from Media (video, music, podcasts, streaming). Watching or listening is not the same as messaging.
- Keep Internal/Tools (browser settings, extensions, dashboards, dev/admin utilities) separate from user-facing content.
- A new label that covers only one tab is unusual — only pick one if that tab is clearly its own distinct topic with no siblings here.
- Do not echo the tab's title or hostname as the label.
- Do not include any of these words in the label: "new", "category", "label", "topic", "skipped".

Existing labels (with example domains):
${renderCategoryList(rules)}

Tabs:
${renderTabList(unmatched, snippets)}

Output raw JSON only: a JSON object mapping EVERY tab number shown above (string key) to exactly one chosen label. Do not omit any tab.`;

// ─── Fresh (Phase 4c: Arc-Tidy — ignore existing, re-cluster all) ───────────

export const buildFreshPrompt = (tabs, snippets) =>
  `Look at all these browser tabs and cluster them into a small number of new categories that you invent. Ignore any current grouping — start fresh.

Tabs:
${renderTabList(tabs, snippets)}

Each tab line may include a Summary with bracketed signals:
- [type: ...] — the page type (article, video, product, profile, website, book, music.song, etc.). This is the strongest signal for intent: 'article' tabs are reading, 'video' tabs are watching, 'product' tabs are shopping.
- [site: ...] — the site's brand name (e.g. "BBC News", "Vimeo").
- [topic: ...] — the page's main heading.

Guidelines:
- Use the signals above to infer what the user is DOING with each tab, not just what website they're on. Prefer category names that reflect that intent — "Reading", "Watching", "Research", "Shopping", "Work tools" — over narrow topic labels like "BBC", "Vimeo Videos".
- When multiple tabs share a [type:] or describe the same underlying activity, they belong in the same category even if their hostnames differ.
- Pick short, broad category names (1-3 words, Title Case).
- Aim for 4-10 stable intent buckets across a normal workspace. Broad but coherent buckets beat narrow one-tab categories.
- Keep adjacent intent families separate unless the tabs clearly share the same exact task: Docs (files, documents, writing) vs Research (articles, papers, reference reading) vs Work (trackers, admin, ops, business tools).
- Keep Shopping (products, carts, stores) separate from Finance (banking, payments, taxes, invoices) and Planning (calendar, maps, bookings, trips, events).
- Keep Communication (email, chat, messages, meetings) separate from Media (video, music, podcasts, streaming). Watching or listening is not the same as messaging.
- Keep Internal/Tools (browser settings, extensions, dashboards, dev/admin utilities) separate from user-facing content.
- Assign every normal web tab to a category. Single-tab categories are allowed when a tab has no clear sibling.
- Use "skipped" only for tabs that are empty, internal browser pages, unreadable placeholders, or otherwise impossible to classify.
- Do not echo a tab's title or hostname as a category name.
- Return raw JSON only. Do not use markdown fences, prose, comments, or explanations.

Output ONLY a JSON object mapping EVERY tab number shown above (string key) to the chosen category name or "skipped". Do not omit any tab.`;

// ─── Merge (Phase 4b polish: consolidate over-specialized categories) ───────

export const buildMergePrompt = (newGroups) => {
  const categoryLines = newGroups.map((g) => {
    const tabSummaries = g.tabs.map((t) => {
      const host = t.hostname || "(no host)";
      const title = (t.title || "").slice(0, 60).replace(/\s+/g, " ").trim();
      return title ? `${host}: ${title}` : host;
    }).join("; ");
    return `- "${g.name}" — ${tabSummaries}`;
  }).join("\n");
  return `These browser tabs are split across too many narrow categories. For each category below, decide what BROADER category it should merge into.

Categories to review (with their tabs):
${categoryLines}

Rules:
- Tabs from the SAME provider belong together. For example, multiple google.com subdomains (calendar/drive/meet/docs/gmail/...) should all map to ONE category like "Google" or "Google Services". Same for any shared provider.
- Categories sharing a BROAD topic should map to the same target. Gaming-news, indie-games, streaming-services — all map to "Gaming". Multiple shopping-flavors — all map to "Shopping".
- Merge label variants that describe the same intent: Work / Work Management / Project Management; Planning / Planning & Tasks / Planning & Scheduling; Tools / Developer Tools / Admin & Tools / Admin & Settings.
- Aim for 4-10 stable intent buckets across a normal workspace. Broad but coherent buckets beat narrow one-tab categories.
- Keep adjacent intent families separate unless the tabs clearly share the same exact task: Docs (files, documents, writing) vs Research (articles, papers, reference reading) vs Work (trackers, admin, ops, business tools).
- Keep Shopping (products, carts, stores) separate from Finance (banking, payments, taxes, invoices) and Planning (calendar, maps, bookings, trips, events).
- Keep Communication (email, chat, messages, meetings) separate from Media (video, music, podcasts, streaming). Watching or listening is not the same as messaging.
- Keep Internal/Tools (browser settings, extensions, dashboards, dev/admin utilities) separate from user-facing content.
- A category that's genuinely standalone can map to itself.

Output ONLY a JSON object mapping each original category name (left side) to its target category name (right side). Use the EXACT original names from the list above as keys.

{
  "Calendar": "Google Services",
  "Cloud Storage": "Google Services",
  "Video Conferencing": "Google Services",
  "Games": "Gaming",
  "Gaming News": "Gaming",
  "Streaming Services": "Gaming",
  "Shopping": "Shopping",
  "Office Supplies": "Shopping"
}`;
};
