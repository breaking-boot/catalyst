#!/usr/bin/env node
// Unit checks for the Training Grounds difficulty filter's pure helpers,
// exercised against the REAL shipped code: bootdev-extension/src/injected.js
// is evaluated in a vm sandbox with a stubbed window, and the helpers are
// pulled off the __BOOTDEV_ENHANCER_TEST__ hook (which is inert in production
// because that global never exists on the real page).
//
// Run from anywhere:  node scripts/check_challenge_filter.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Fixture note: the distribution checks use the real 2026-07-14 response
// captures under reference_data/ (gitignored, local-only); when those files
// are absent the fixture section is skipped and the synthetic checks still
// run.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const INJECTED = new URL("../bootdev-extension/src/injected.js", import.meta.url);
const FIXTURE_DIR = new URL(
  "../reference_data/catalyst_versions/v0.10.0_challenge_difficulty_filter/",
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
const { tierOfDifficulty, filterChallengeSearchArray, parseTierList, isChallengeSearchUrl } = hooks;

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

// --- tierOfDifficulty: boundaries and junk ----------------------------------

check("tier 1 -> easy", tierOfDifficulty(1), "easy");
check("tier 4 -> easy", tierOfDifficulty(4), "easy");
check("tier 5 -> medium", tierOfDifficulty(5), "medium");
check("tier 7 -> medium", tierOfDifficulty(7), "medium");
check("tier 8 -> hard", tierOfDifficulty(8), "hard");
check("tier 10 -> hard", tierOfDifficulty(10), "hard");
check("tier 0 -> null (out of range)", tierOfDifficulty(0), null);
check("tier 11 -> null (out of range)", tierOfDifficulty(11), null);
check('tier "7" -> medium (numeric string coerces)', tierOfDifficulty("7"), "medium");
check("tier 7.5 -> null (non-integer)", tierOfDifficulty(7.5), null);
check("tier null -> null", tierOfDifficulty(null), null);
check("tier undefined -> null", tierOfDifficulty(undefined), null);
check('tier "x" -> null', tierOfDifficulty("x"), null);

// --- filterChallengeSearchArray: keep-on-unknown, order, non-mutation -------

const rec = (uuid, difficulty) => ({ UUID: uuid, Topics: { Difficulty: difficulty } });
const sample = [
  rec("a", 1),
  rec("b", 4),
  rec("c", 5),
  rec("d", 7),
  rec("e", 8),
  rec("f", 10),
  { UUID: "g" }, // no Topics at all
  rec("h", null), // null difficulty
  rec("i", 42), // out of range
];

const hardOnly = filterChallengeSearchArray(sample, new Set(["hard"]));
check(
  "hard-only keeps hard + unresolvable, in order",
  hardOnly.map((r) => r.UUID),
  ["e", "f", "g", "h", "i"]
);
check("kept records are the original references", hardOnly[0] === sample[4], true);
check("input array is not mutated", sample.length, 9);

const easyMedium = filterChallengeSearchArray(sample, new Set(["easy", "medium"]));
check(
  "easy+medium keeps 1-7 + unresolvable",
  easyMedium.map((r) => r.UUID),
  ["a", "b", "c", "d", "g", "h", "i"]
);

check(
  "empty tier set keeps only unresolvable (callers gate on active-ness first)",
  filterChallengeSearchArray(sample, new Set()).map((r) => r.UUID),
  ["g", "h", "i"]
);

check("empty input -> empty output", filterChallengeSearchArray([], new Set(["easy"])), []);

// --- parseTierList (data-be-diff / diff= values): validation + canonical order

check("parse drops unknown tiers, dedupes, canonical order", parseTierList("hard,banana,easy,hard"), ["easy", "hard"]);
check("parse of empty string -> no tiers", parseTierList(""), []);
check("parse of junk -> no tiers", parseTierList("EASY; 3"), []);
check("parse handles null/undefined", parseTierList(null), []);
check("parse all three, any order -> canonical", parseTierList("hard,easy,medium"), ["easy", "medium", "hard"]);

// --- isChallengeSearchUrl: exact endpoint only -------------------------------

check(
  "matches absolute search URL with query",
  isChallengeSearchUrl("https://api.boot.dev/v1/challenges/search?q=*&t=type_code&l=py"),
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

const FIXTURES = [
  ["challenges_search_response_code_python.json", { easy: 22, medium: 13, hard: 15 }],
  ["challenges_search_response_interview_nolang.json", { easy: 8, medium: 11, hard: 31 }],
  ["challenges_search_response_quiz_go.json", { easy: 11, medium: 4, hard: 0 }],
];

let fixturesRun = 0;
for (const [name, expected] of FIXTURES) {
  const url = new URL(name, FIXTURE_DIR);
  if (!existsSync(url)) continue;
  fixturesRun += 1;
  const records = JSON.parse(readFileSync(url, "utf8"));
  const total = records.length;
  const counts = {};
  let keptTotal = 0;
  for (const tier of ["easy", "medium", "hard"]) {
    counts[tier] = filterChallengeSearchArray(records, new Set([tier])).length;
    keptTotal += counts[tier];
  }
  check(`${name} per-tier counts`, counts, expected);
  check(`${name} tiers partition the set (no unknown difficulties)`, keptTotal, total);
  check(
    `${name} all-tiers set keeps everything`,
    filterChallengeSearchArray(records, new Set(["easy", "medium", "hard"])).length,
    total
  );
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
