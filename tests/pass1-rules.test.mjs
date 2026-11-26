import test from "node:test";
import assert from "node:assert/strict";

import {
  findGroupForTab,
  matchesDomain,
  matchesTitlePattern,
  matchesUrlPattern,
  runPass1,
} from "../modules/pass1.mjs";
import {
  normalizeDomainPattern,
  normalizeRule,
  normalizeUrlPattern,
  readCollapsedGroupsPref,
  readRulesPref,
  readSkipDomainsPref,
  STARTER_RULE_PRESETS,
  validateRules,
  writeCollapsedGroupsPref,
  writeRulesPref,
  writeSkipDomainsPref,
} from "../modules/rules.mjs";
import {
  buildClassificationCacheKey,
  buildEmbeddingCacheKey,
  buildGroupsSignature,
  classificationCache,
  createLRUCache,
  embeddingCache,
  hashCacheKey,
  invalidateClassificationCache,
  invalidateEmbeddingCache,
} from "../modules/classification-cache.mjs";

// ─── 1. pass1.mjs ────────────────────────────────────────────────────────────

test("pass1: case-insensitive domain matching and specificity ranking (urlPatterns > exact host > *.sub > parent domain > title > container)", () => {
  // Case-insensitive domain matching
  assert.equal(matchesDomain("API.GitHub.COM", "github.com"), true);
  assert.equal(matchesDomain("sub.Example.ORG", "*.example.org"), true);
  assert.equal(matchesDomain("example.org", "*.example.org"), false, "Wildcard *.host must not match bare host");
  assert.equal(matchesUrlPattern({ url: "https://www.GitHub.com/MyOrg/repo/pulls" }, "github.com/myorg/*"), true);
  assert.equal(matchesTitlePattern("PR #42: Fix Auth", "*fix auth*"), true);
  assert.equal(matchesTitlePattern("Weekly Standup", "standup"), true);

  const rules = [
    { name: "ContainerOnly", domains: [], containers: ["work"] },
    { name: "TitleMatch", domains: [], titlePatterns: ["pull request"] },
    { name: "ParentDomain", domains: ["github.com"] },
    { name: "WildcardSub", domains: ["*.github.com"] },
    { name: "ExactHost", domains: ["gist.github.com"] },
    { name: "UrlPattern", domains: [], urlPatterns: ["gist.github.com/team/*"] },
  ];

  // URL pattern beats exact host, wildcard, parent, title, and container
  assert.equal(
    findGroupForTab(
      { hostname: "gist.github.com", url: "https://gist.github.com/team/spec", title: "Pull Request", containerLabel: "Work" },
      rules,
    ),
    "UrlPattern",
  );

  // Exact host beats *.sub and parent domain
  assert.equal(
    findGroupForTab(
      { hostname: "gist.github.com", url: "https://gist.github.com/other/spec", title: "Note" },
      rules,
    ),
    "ExactHost",
  );

  // *.sub beats parent domain
  assert.equal(
    findGroupForTab(
      { hostname: "docs.github.com", url: "https://docs.github.com/en", title: "Docs" },
      rules,
    ),
    "WildcardSub",
  );

  // Bare host matches parent domain (not *.sub)
  assert.equal(
    findGroupForTab(
      { hostname: "github.com", url: "https://github.com/explore", title: "Explore" },
      rules,
    ),
    "ParentDomain",
  );

  // Title pattern beats container-only rule
  assert.equal(
    findGroupForTab(
      { hostname: "gitlab.com", url: "https://gitlab.com/mr/1", title: "Review Pull Request", containerLabel: "Work" },
      rules,
    ),
    "TitleMatch",
  );

  // Container-only rule matches when no other matcher matches
  assert.equal(
    findGroupForTab(
      { hostname: "intranet.local", url: "https://intranet.local", title: "Home", containerLabel: "Work" },
      rules,
    ),
    "ContainerOnly",
  );

  // Container constraint + domain adds +10 bonus over unconstrained domain rule
  const containerScopedRules = [
    { name: "General GitHub", domains: ["github.com"] },
    { name: "Work GitHub", domains: ["github.com"], containers: ["Work"] },
  ];
  assert.equal(
    findGroupForTab({ hostname: "github.com", url: "https://github.com/a", containerLabel: "Work" }, containerScopedRules),
    "Work GitHub",
  );
  assert.equal(
    findGroupForTab({ hostname: "github.com", url: "https://github.com/a", containerLabel: "Personal" }, containerScopedRules),
    "General GitHub",
  );
});

test("pass1: runPass1 performs case-insensitive existing group matching", () => {
  const rules = [
    { name: "Dev", domains: ["github.com"] },
    { name: "News", domains: ["news.ycombinator.com"] },
  ];
  const tabs = [
    { id: 0, hostname: "github.com", url: "https://github.com", title: "GH", currentGroup: "dev" },
    { id: 1, hostname: "news.ycombinator.com", url: "https://news.ycombinator.com", title: "HN", currentGroup: null },
    { id: 2, hostname: "unknown.example", url: "https://unknown.example", title: "Other", currentGroup: null },
  ];

  const plan = runPass1(tabs, rules);
  assert.equal(plan.alreadyCorrect.length, 1);
  assert.equal(plan.alreadyCorrect[0].id, 0);
  assert.equal(plan.byGroup.get("News")?.length, 1);
  assert.equal(plan.unmatched.length, 1);
  assert.equal(plan.unmatched[0].id, 2);
});

// ─── 2. rules.mjs ────────────────────────────────────────────────────────────

test("rules: URL-to-domain normalization, extended schema validation, starter presets, and pref persistence", () => {
  assert.equal(normalizeDomainPattern("https://www.GitHub.com:443/org/repo?x=1#top"), "github.com");
  assert.equal(normalizeDomainPattern("*.https://www.Sub.Example.ORG/path"), "*.sub.example.org");
  assert.equal(normalizeDomainPattern("user@LocalHost:3000/app"), "localhost");
  assert.equal(normalizeDomainPattern("   "), "");

  assert.equal(normalizeUrlPattern("https://www.GitHub.com/MyOrg//Repo/#frag"), "github.com/MyOrg/Repo");
  assert.equal(normalizeUrlPattern("https://www.Example.com/"), "example.com/");

  const normalized = normalizeRule({
    name: "  Work  ",
    color: "#336699",
    domains: ["https://www.GitHub.com/a", "github.com"],
    urlPatterns: ["https://www.GitHub.com/org/*"],
    titlePatterns: ["Sprint *", "sprint *"],
    containers: ["Work", "work"],
  });
  assert.deepEqual(normalized, {
    name: "Work",
    color: "#336699",
    domains: ["github.com"],
    urlPatterns: ["github.com/org/*"],
    titlePatterns: ["Sprint *"],
    containers: ["Work"],
  });

  // Extended schema validation
  const validated = validateRules({
    rules: [
      { name: "TitleOnly", titlePatterns: ["Invoice"] },
      { name: "UrlOnly", urlPatterns: ["docs.google.com/spreadsheets/*"] },
      { name: "ContainerOnly", containers: ["Banking"] },
      { name: "DomainRule", domains: ["https://www.npmjs.com/package/foo"], color: "red" },
    ],
  });
  assert.equal(validated.length, 4);
  assert.deepEqual(validated[3].domains, ["npmjs.com"]);

  assert.throws(() => validateRules({}), /top-level 'rules' array/);
  assert.throws(() => validateRules({ rules: [{ name: "  " }] }), /missing or empty 'name'/);
  assert.throws(() => validateRules({ rules: [{ name: "NoMatchers" }] }), /'domains' must be a string array/);
  assert.throws(() => validateRules({ rules: [{ name: "BadTitle", titlePatterns: [123] }] }), /'titlePatterns' must be a string array/);

  // Starter presets are frozen and valid
  assert.ok(Object.isFrozen(STARTER_RULE_PRESETS));
  assert.ok(STARTER_RULE_PRESETS.length >= 6);
  assert.doesNotThrow(() => validateRules({ rules: [...STARTER_RULE_PRESETS] }));

  // Pref read/write round-trips
  const prevServices = globalThis.Services;
  const store = new Map();
  globalThis.Services = {
    prefs: {
      getStringPref: (k, def = "") => (store.has(k) ? store.get(k) : def),
      setStringPref: (k, v) => store.set(k, String(v)),
    },
  };
  try {
    writeRulesPref([{ name: "Dev", domains: ["https://www.GitHub.com/x"] }]);
    assert.deepEqual(readRulesPref(), [{ name: "Dev", domains: ["github.com"] }]);

    writeSkipDomainsPref(["https://www.Bank.DE/login", "bank.de"]);
    assert.deepEqual(readSkipDomainsPref(), ["bank.de"]);

    writeCollapsedGroupsPref(new Set(["id:g1", "id:g2"]));
    assert.deepEqual([...readCollapsedGroupsPref()], ["id:g1", "id:g2"]);
  } finally {
    globalThis.Services = prevServices;
  }
});

// ─── 3. classification-cache.mjs ─────────────────────────────────────────────

test("classification-cache: LRU eviction, TTL expiry, deterministic signature hashing & invalidation", () => {
  let clock = 1000;
  const cache = createLRUCache({ maxEntries: 2, ttlMs: 500, now: () => clock });

  cache.set("a", 1);
  cache.set("b", 2);
  // Touch "a" so "b" becomes least-recently-used
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.has("b"), false, "LRU entry evicted");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);

  // Advance clock past TTL
  clock += 600;
  assert.equal(cache.get("a"), undefined, "Expired entry returns undefined");
  assert.equal(cache.has("c"), false, "Expired entry reports has=false");
  cache.set("d", 4);
  clock += 600;
  assert.equal(cache.pruneExpired(), 1, "pruneExpired removes stale entries");
  assert.equal(cache.size, 0);
  const stats = cache.stats();
  assert.ok(stats.hits >= 3 && stats.misses >= 1);

  // Deterministic hashing & group signature order-independence
  assert.equal(hashCacheKey("abc"), hashCacheKey("abc"));
  assert.notEqual(hashCacheKey("abc"), hashCacheKey("abd"));

  const sig1 = buildGroupsSignature([
    { name: "Dev", domains: ["github.com", "npmjs.com"], tabs: [{ hostname: "github.com", title: "PR 1" }] },
    { name: "News", domains: ["reuters.com"], tabs: [] },
  ]);
  const sig2 = buildGroupsSignature([
    { name: "News", domains: ["REUTERS.COM"], tabs: [] },
    { name: "Dev", domains: ["npmjs.com", "github.com"], tabs: [{ hostname: "github.com", title: "PR 1" }] },
  ]);
  const sig3 = buildGroupsSignature([
    { name: "News", domains: ["reuters.com"], tabs: [] },
    { name: "Dev", domains: ["github.com", "gitlab.com"], tabs: [{ hostname: "github.com", title: "PR 1" }] },
  ]);
  assert.equal(sig1, sig2, "Signature is deterministic across group/domain order and casing");
  assert.notEqual(sig1, sig3, "Signature invalidates when group domains change");
  assert.equal(buildGroupsSignature([]), "empty");

  const keyA = buildClassificationCacheKey({ url: "https://github.com/a", title: "PR", groupsSignature: sig1, model: "jev-1.13", minProbability: 0.7 });
  const keyB = buildClassificationCacheKey({ url: "https://github.com/a", title: "PR", groupsSignature: sig3, model: "jev-1.13", minProbability: 0.7 });
  assert.notEqual(keyA, keyB);
  assert.equal(buildEmbeddingCacheKey({ title: "Docs", hostname: "mdn.dev" }), "Docs (mdn.dev)");

  // Singleton invalidation helpers
  classificationCache.set("k1", { group: "Dev" });
  embeddingCache.set("e1", [0.1, 0.2]);
  invalidateClassificationCache();
  invalidateEmbeddingCache();
  assert.equal(classificationCache.size, 0);
  assert.equal(embeddingCache.size, 0);
});
