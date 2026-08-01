#!/usr/bin/env node
// Unit checks for the Training Grounds difficulty LEVEL filter's pure helpers,
// exercised against the REAL shipped code: bootdev-extension/src/injected.js
// is evaluated in a vm sandbox with a stubbed window, and the helpers are
// pulled off the __BOOTDEV_ENHANCER_TEST__ hook (which is inert in production
// because that global never exists on the real page).
//
// Run from anywhere:  node scripts/check_challenge_filter.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Fixture note: the distribution checks use real response captures under
// reference_data/ (gitignored, local-only); when those files are absent the
// fixture section is skipped and the synthetic checks still run.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const INJECTED = new URL("../bootdev-extension/src/injected.js", import.meta.url);
const FIXTURE_DIR = new URL(
  "../reference_data/catalyst_versions/v0.10.0_challenge_difficulty_filter/",
  import.meta.url
);
// Boot.dev flipped the response to camelCase on 2026-07-30; this capture is the
// post-flip ground truth (see the v0.12.1 bundle's README).
const FIXTURE_DIR_CAMEL = new URL(
  "../reference_data/catalyst_versions/v0.12.1_training_grounds_filter_repair/api/responses/",
  import.meta.url
);
// Captures taken after Boot.dev shipped its own d=easy|medium|hard filter
// (2026-08-01). These are what the level filter actually operates on.
const FIXTURE_DIR_NATIVE = new URL(
  "../reference_data/catalyst_versions/v0.13.0_challenge_level_filter/api/responses/",
  import.meta.url
);

// --- evaluate injected.js in a sandbox -------------------------------------

const testHook = {};
const windowStub = {
  __BOOTDEV_ENHANCER_TEST__: testHook,
  location: { origin: "https://www.boot.dev" },
  addEventListener() {},
  postMessage() {},
  fetch: async () => {
    throw new Error("network disabled in tests");
  },
};
function XMLHttpRequestStub() {}
XMLHttpRequestStub.prototype.open = function () {};
XMLHttpRequestStub.prototype.setRequestHeader = function () {};
XMLHttpRequestStub.prototype.send = function () {};

const sandbox = {
  window: windowStub,
  XMLHttpRequest: XMLHttpRequestStub,
  URL,
  console,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(INJECTED, "utf8"), sandbox, {
  filename: fileURLToPath(INJECTED),
});

const hooks = testHook.hooks;
if (!hooks) {
  console.error("FAIL: injected.js did not expose test hooks");
  process.exit(1);
}
const {
  challengeLevel,
  challengeDifficulty,
  filterChallengeSearchArray,
  countResolvedLevels,
  challengeSearchRecords,
  parseLevelList,
  isChallengeSearchUrl,
  requiresAuth,
} = hooks;

// --- tiny assert ------------------------------------------------------------

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`FAIL: ${label}\n  expected ${e}\n  got      ${a}`);
  }
}

// --- challengeLevel: bounds and junk ----------------------------------------
// Anything that is not an integer 1-10 is "unresolvable", which the filter
// treats as keep. That preserves the tier version's behavior, where an
// out-of-range value tiered to null and was therefore kept.

check("level 1 resolves", challengeLevel(1), 1);
check("level 10 resolves", challengeLevel(10), 10);
check("level 0 -> null (out of range)", challengeLevel(0), null);
check("level 11 -> null (out of range)", challengeLevel(11), null);
check('level "7" -> 7 (numeric string coerces)', challengeLevel("7"), 7);
check("level 7.5 -> null (non-integer)", challengeLevel(7.5), null);
check("level null -> null", challengeLevel(null), null);
check("level undefined -> null", challengeLevel(undefined), null);
check('level "x" -> null', challengeLevel("x"), null);
check('level "" -> null (empty string must not coerce to 0)', challengeLevel(""), null);

// --- challengeDifficulty: response casing ------------------------------------
// Boot.dev served PascalCase (Topics.Difficulty) through 2026-07-14 and
// camelCase (topics.difficulty) by 2026-07-30. Both must resolve, or the
// "keep records with no resolvable level" rule silently disables the filter.

check("PascalCase Topics.Difficulty", challengeDifficulty({ Topics: { Difficulty: 6 } }), 6);
check("camelCase topics.difficulty", challengeDifficulty({ topics: { difficulty: 6 } }), 6);
check("difficulty 0 is read, not skipped", challengeDifficulty({ topics: { difficulty: 0 } }), 0);
check("PascalCase wins when a record carries both", challengeDifficulty({ Topics: { Difficulty: 3 }, topics: { difficulty: 9 } }), 3);
check("no topics container -> undefined", challengeDifficulty({ UUID: "x" }), undefined);
check("null topics -> undefined", challengeDifficulty({ topics: null }), undefined);
check("non-object topics -> undefined", challengeDifficulty({ topics: "nope" }), undefined);
check("topics without a difficulty key -> undefined", challengeDifficulty({ topics: { mainTopic: "Loops" } }), undefined);
check("null record -> undefined", challengeDifficulty(null), undefined);

// The v0.12.1 regression, in level form: a camelCase-only record must be
// FILTERED, not waved through by the keep-on-unknown rule. Before v0.12.1 this
// returned both records, so every selection rendered the full result set.
const camelRecs = [
  { uuid: "a", topics: { difficulty: 2 } },
  { uuid: "b", topics: { difficulty: 9 } },
];
check(
  "camelCase records filter by level (v0.12.1 regression)",
  filterChallengeSearchArray(camelRecs, new Set([2])).map((r) => r.uuid),
  ["a"]
);
check(
  "camelCase records are not all kept when no level matches",
  filterChallengeSearchArray(camelRecs, new Set([5])).map((r) => r.uuid),
  []
);
check(
  "mixed-casing result set filters correctly",
  filterChallengeSearchArray(
    [{ uuid: "camel", topics: { difficulty: 10 } }, { UUID: "pascal", Topics: { Difficulty: 10 } }],
    new Set([10])
  ).length,
  2
);

// --- filterChallengeSearchArray: keep-on-unknown, order, non-mutation -------

const rec = (uuid, difficulty) => ({ UUID: uuid, Topics: { Difficulty: difficulty } });
const sample = [
  rec("a", 1),
  rec("b", 4),
  rec("c", 5),
  rec("d", 8),
  rec("e", 9),
  rec("f", 10),
  { UUID: "g" }, // no Topics at all
  rec("h", null), // null difficulty
  rec("i", 42), // out of range
];

const tenOnly = filterChallengeSearchArray(sample, new Set([10]));
check(
  "level 10 only keeps 10 + unresolvable, in order",
  tenOnly.map((r) => r.UUID),
  ["f", "g", "h", "i"]
);
check("kept records are the original references", tenOnly[0] === sample[5], true);
check("input array is not mutated", sample.length, 9);

check(
  "a multi-level selection keeps exactly those levels + unresolvable",
  filterChallengeSearchArray(sample, new Set([9, 10])).map((r) => r.UUID),
  ["e", "f", "g", "h", "i"]
);
check(
  "an adjacent level is not swept in (8 does not imply 9/10)",
  filterChallengeSearchArray(sample, new Set([8])).map((r) => r.UUID),
  ["d", "g", "h", "i"]
);
check(
  "empty level set keeps only unresolvable (callers gate on active-ness first)",
  filterChallengeSearchArray(sample, new Set()).map((r) => r.UUID),
  ["g", "h", "i"]
);
check("empty input -> empty output", filterChallengeSearchArray([], new Set([10])), []);

// --- countResolvedLevels: the rename tripwire --------------------------------
// The keep-on-unknown rule means a renamed difficulty field cannot fail
// visibly, so this count is what trainingGrounds.js warns on. 0-of-N is the
// exact signature of the v0.12.1 regression.

check("census counts records with a readable level", countResolvedLevels(camelRecs), 2);
check(
  "census is 0 when the difficulty field is unreadable (the v0.12.1 signature)",
  countResolvedLevels([{ uuid: "a", topics: { hardness: 2 } }, { uuid: "b", topics: { hardness: 9 } }]),
  0
);
check("census ignores out-of-range difficulties", countResolvedLevels([{ topics: { difficulty: 42 } }]), 0);
check("census of an empty result set", countResolvedLevels([]), 0);

// --- challengeSearchRecords: shape tolerance --------------------------------
// Every capture (2026-07-14 through 2026-08-01) is a bare array. A wrapper
// appearing later must not silently disable the filter the way the casing flip
// did.

const bare = [{ uuid: "a" }];
check("bare array is recognized", challengeSearchRecords(bare).records, bare);
check("bare array round-trips unwrapped", challengeSearchRecords(bare).rewrap([{ uuid: "b" }]), [{ uuid: "b" }]);

const wrapped = { data: [{ uuid: "a" }, { uuid: "b" }], meta: { page: 1 } };
check("data-wrapped array is recognized", challengeSearchRecords(wrapped).records.length, 2);
check(
  "data-wrapped array is re-wrapped with siblings intact",
  challengeSearchRecords(wrapped).rewrap([{ uuid: "a" }]),
  { data: [{ uuid: "a" }], meta: { page: 1 } }
);
check("results-wrapped array is recognized", challengeSearchRecords({ results: [1, 2] }).records.length, 2);
check("challenges-wrapped array is recognized", challengeSearchRecords({ challenges: [1] }).records.length, 1);
check("object with no record array -> null (fails open)", challengeSearchRecords({ meta: {} }), null);
check("null -> null", challengeSearchRecords(null), null);
check("string -> null", challengeSearchRecords("nope"), null);

// --- requiresAuth: which paths must be queued rather than sent bare ---------
// Measured 2026-07-31: a cookie-only GET returns 401 for these and 200 for the
// rest. The league boards were missing here, so on a cold server-rendered
// /leaderboard (nothing fetched, so no Authorization header harvested) both
// League comparison boards silently failed with no retry.

check("boss progress requires auth", requiresAuth("/v1/boss_events_progress"), true);
check("dashboard content requires auth", requiresAuth("/v1/dashboard_content"), true);
check("league daily requires auth", requiresAuth("/v1/league_leaderboard_xp/day"), true);
check("league alltime requires auth", requiresAuth("/v1/league_leaderboard_xp/alltime"), true);
check("global XP board does not", requiresAuth("/v1/leaderboard_xp/day"), false);
check("global karma board does not", requiresAuth("/v1/leaderboard_karma/alltime"), false);
check("public profile does not", requiresAuth("/v1/users/public/a-fleming"), false);
check("challenge search does not", requiresAuth("/v1/challenges/search"), false);
check("league pattern does not over-match a deeper path", requiresAuth("/v1/league_leaderboard_xp/day/extra"), false);

// --- parseLevelList (data-be-dl / dl= values): validation + canonical order --

check("parse drops junk, dedupes, sorts ascending", parseLevelList("10,banana,8,10"), [8, 10]);
check("parse tolerates whitespace", parseLevelList(" 9 , 8 "), [8, 9]);
check("parse drops out-of-range levels", parseLevelList("0,5,11"), [5]);
check("parse drops non-integers", parseLevelList("5.5,6"), [6]);
check("parse of empty string -> no levels", parseLevelList(""), []);
check("parse of legacy tier names -> no levels (old diff= links fail open)", parseLevelList("easy,hard"), []);
check("parse handles null/undefined", parseLevelList(null), []);
check("parse of a full tier, any order -> canonical", parseLevelList("10,8,9"), [8, 9, 10]);

// --- isChallengeSearchUrl: exact endpoint only -------------------------------

check(
  "matches absolute search URL with query",
  isChallengeSearchUrl("https://api.boot.dev/v1/challenges/search?q=*&t=type_code&l=py&d=hard"),
  true
);
check("matches relative search URL", isChallengeSearchUrl("/v1/challenges/search?q=test"), true);
check("rejects /v1/challenges", isChallengeSearchUrl("https://api.boot.dev/v1/challenges"), false);
check(
  "rejects deeper path",
  isChallengeSearchUrl("https://api.boot.dev/v1/challenges/search/extra"),
  false
);
check("rejects lessons search", isChallengeSearchUrl("https://api.boot.dev/v1/lessons/search?q=x"), false);
check("rejects garbage", isChallengeSearchUrl("::not a url::"), false);

// --- real capture fixtures (skipped when reference_data is absent) ----------
// Each entry is the exact per-level histogram of a captured response. These
// double as the rename tripwire on real data: if the difficulty field moves
// again, every count collapses to 0 and these fail loudly.

const histogram = (records) => {
  const counts = {};
  for (const record of records) {
    const level = challengeLevel(challengeDifficulty(record));
    if (level !== null) counts[level] = (counts[level] || 0) + 1;
  }
  return counts;
};

const FIXTURES = [
  // Pre-native-filter captures: unfiltered searches spanning all tiers.
  [FIXTURE_DIR, "challenges_search_response_code_python.json", 50,
    { 1: 5, 2: 5, 3: 8, 4: 4, 5: 7, 6: 3, 7: 3, 8: 3, 9: 6, 10: 6 }],
  [FIXTURE_DIR, "challenges_search_response_interview_nolang.json", 50,
    { 1: 2, 2: 1, 3: 4, 4: 1, 5: 2, 6: 5, 7: 4, 8: 14, 9: 10, 10: 7 }],
  [FIXTURE_DIR, "challenges_search_response_quiz_go.json", 15,
    { 1: 1, 2: 4, 3: 3, 4: 3, 6: 1, 7: 3 }],
  // Post-camelCase-flip capture (q=loops, 2026-07-30).
  [FIXTURE_DIR_CAMEL, "challenges_search_response_raw_2026-07-30.json", 28,
    { 2: 4, 3: 2, 4: 1, 5: 2, 6: 7, 7: 6, 8: 1, 9: 1, 10: 4 }],
  // Native tier-filtered captures (2026-08-01). Every record falls inside its
  // tier — easy 1-4, medium 5-7, hard 8-10 — with zero leakage, which is what
  // lets Catalyst offer exactly those levels for the selected tier.
  [FIXTURE_DIR_NATIVE, "challenges_search_d_easy_closures_py.json", 50,
    { 1: 17, 2: 10, 3: 11, 4: 12 }],
  [FIXTURE_DIR_NATIVE, "challenges_search_d_medium_closures_py.json", 41,
    { 5: 17, 6: 13, 7: 11 }],
  [FIXTURE_DIR_NATIVE, "challenges_search_d_hard_closures_py.json", 44,
    { 8: 17, 9: 13, 10: 14 }],
  [FIXTURE_DIR_NATIVE, "challenges_search_d_hard_wildcard_py.json", 44,
    { 8: 16, 9: 16, 10: 12 }],
  // A deliberately broad unfiltered query: spreads thinly across all ten
  // levels, which is why level pills are only offered once a tier is picked.
  [FIXTURE_DIR_NATIVE, "challenges_search_broad_query_unfiltered.json", 46,
    { 1: 4, 2: 2, 3: 4, 4: 3, 5: 5, 6: 5, 7: 4, 8: 7, 9: 5, 10: 7 }],
];

let fixturesRun = 0;
for (const [dir, name, total, expected] of FIXTURES) {
  const url = new URL(name, dir);
  if (!existsSync(url)) continue;
  fixturesRun += 1;
  const records = JSON.parse(readFileSync(url, "utf8"));
  check(`${name} record count`, records.length, total);
  check(`${name} per-level histogram`, histogram(records), expected);
  // Every record in a healthy capture yields a level, so a 0 here would mean
  // the difficulty field moved again.
  check(`${name} every record has a readable level (rename tripwire)`, countResolvedLevels(records), records.length);
  // Selecting every level present filters nothing.
  const allLevels = new Set(Object.keys(expected).map(Number));
  check(
    `${name} selecting every present level keeps everything`,
    filterChallengeSearchArray(records, allLevels).length,
    records.length
  );
  // Each single level narrows to exactly its own count.
  for (const [level, count] of Object.entries(expected)) {
    check(
      `${name} level ${level} narrows to ${count}`,
      filterChallengeSearchArray(records, new Set([Number(level)])).length,
      count
    );
  }
}
if (!fixturesRun) {
  console.log("note: reference_data fixtures not present; skipped distribution checks");
}

// -----------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures}/${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed${fixturesRun ? ` (incl. ${fixturesRun} capture fixtures)` : ""}`);
