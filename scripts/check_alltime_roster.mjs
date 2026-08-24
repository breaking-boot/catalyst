#!/usr/bin/env node
// Unit checks for the all-time roster, exercised against the REAL shipped code:
// bootdev-extension/src/{utils,alltime-seed,allTimeRoster}.js are evaluated in a
// vm sandbox and the helpers are pulled off the __BOOTDEV_ENHANCER_TEST__ hook
// (inert in production because that global never exists on the real page).
//
// Run from anywhere:  node scripts/check_alltime_roster.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: /v1/leaderboard_xp/alltime was removed on 2026-08-14, so the
// board is now assembled from per-user rank observations plus a bundled seed.
// Four of its rules are the kind that fail silently and look healthy:
//
//   1. Entries NEVER expire. A TTL schedules a refresh; it must never turn a
//      known learner into an unknown, or a board left alone for a month decays
//      into a page of gaps.
//   2. Ordering comes from lifetime XP ALONE. Boot.dev removed the per-user
//      rank on 2026-08-20, so a stored rank is provenance and must never
//      influence the displayed order.
//   3. Equal XP orders deterministically, or rows swap between renders.
//   4. A falling XP is stored, not clamped. Staff can reduce XP for cheating;
//      a Math.max "fix" would freeze that row wrong forever.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);

const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null },
  location: { origin: "https://www.boot.dev", pathname: "/leaderboard" },
  console,
  URL,
  chrome: { runtime: { getURL: (p) => `chrome-extension://catalyst-test/${p}` } },
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
};
vm.createContext(sandbox);
for (const file of ["utils.js", "alltime-seed.js", "allTimeRoster.js"]) {
  const url = new URL(file, SRC);
  vm.runInContext(readFileSync(url, "utf8"), sandbox, { filename: fileURLToPath(url) });
}

const R = testHook.allTimeRoster;
if (!R) {
  console.error("FAIL: allTimeRoster.js did not expose test hooks");
  process.exit(1);
}
// ALLTIME_SEED is a top-level `const`, so it lives in the context's global
// lexical scope rather than on the sandbox object — read it by evaluating its
// name in the same context.
const SEED = vm.runInContext("ALLTIME_SEED", sandbox);

// --- tiny assert -------------------------------------------------------------

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) return;
  failures += 1;
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-01T12:00:00Z");

// A complete, freshly observed board: ranks 1..25, XP descending, plus the
// watchlist. Mirrors the shape the bundled seed produces.
function fullRoster({ rankAt = NOW - HOUR, profileAt = NOW - HOUR, through = 30 } = {}) {
  const roster = R.emptyRoster();
  for (let rank = 1; rank <= through; rank++) {
    const handle = `user${rank}`;
    roster.entries[handle] = {
      ...R.blankEntry(handle),
      FirstName: `User${rank}`,
      Role: "Archmage",
      Level: 200 - rank,
      XP: 2_000_000 - rank * 10_000,
      rank,
      rankAt,
      profileAt,
    };
  }
  return roster;
}

// --- 1. seed integrity -------------------------------------------------------

check("seed exists", Boolean(SEED && Array.isArray(SEED.entries)));
check("seed generatedAt parses", Number.isFinite(Date.parse(SEED.generatedAt)));
eq("seed cutoff is documented", SEED.cutoffRank, 30);
check("seed is trimmed to the cutoff", SEED.entries.every((e) => e.rank <= SEED.cutoffRank),
  "the raw snapshot also holds handles at ranks 402-977; those must not ship");
check("seed ranks are unique", new Set(SEED.entries.map((e) => e.rank)).size === SEED.entries.length);
check("seed entries all have a handle and integer rank",
  SEED.entries.every((e) => typeof e.handle === "string" && e.handle && Number.isInteger(e.rank)));
const seedTop = new Set(SEED.entries.filter((e) => e.rank <= 25).map((e) => e.rank));
eq("seed covers all 25 board positions", seedTop.size, 25);
check("seed carries no unexpected fields", SEED.entries.every((e) =>
  Object.keys(e).every((k) =>
    ["handle", "rank", "rankAt", "xp", "firstName", "lastName", "role", "level", "profileImageURL"].includes(k))));

// --- 2. merge: newest observation wins ---------------------------------------

{
  const older = { handle: "a", rank: 5, rankAt: NOW - DAY, XP: 100, profileAt: NOW - DAY };
  const newer = { handle: "a", rank: 6, rankAt: NOW, XP: 200, profileAt: NOW };

  const forward = R.mergeRosterObservation(R.mergeRosterObservation(null, older), newer);
  eq("newer rank wins", forward.rank, 6);
  eq("newer XP wins", forward.XP, 200);

  const backward = R.mergeRosterObservation(R.mergeRosterObservation(null, newer), older);
  eq("older rank loses", backward.rank, 6);
  eq("older XP loses", backward.XP, 200);
}

{
  // A fresher bundled seed must upgrade a stale stored row; a stale seed must
  // never clobber fresher data. Both fall out of the same comparison.
  const roster = R.emptyRoster();
  const seed = { generatedAt: new Date(NOW).toISOString(), entries: [{ handle: "a", rank: 3, xp: 500, role: "Archmage", level: 150 }] };

  roster.entries.a = { ...R.blankEntry("a"), rank: 9, rankAt: NOW - DAY, XP: 100, profileAt: NOW - DAY };
  R.applySeedToRoster(roster, seed);
  eq("fresher seed upgrades a stale row", roster.entries.a.rank, 3);

  const roster2 = R.emptyRoster();
  roster2.entries.a = { ...R.blankEntry("a"), rank: 9, rankAt: NOW + DAY, XP: 100, profileAt: NOW + DAY };
  R.applySeedToRoster(roster2, seed);
  eq("stale seed loses to fresher data", roster2.entries.a.rank, 9);
}


// --- 3. ordering, and the no-decay invariant ---------------------------------

{
  const board = R.buildAllTimeBoardRows(fullRoster(), "user2");
  eq("25 rows rendered", board.rows.filter((r) => !r.outsideBoard).length, 25);
  eq("observed count reports the whole roster", board.observed, 30);
  eq("shown is capped at the board size", board.shown, 25);
  eq("positions are 1..25 exactly once",
    JSON.stringify(board.rows.filter((r) => !r.outsideBoard).map((r) => r.position)),
    JSON.stringify(Array.from({ length: 25 }, (_, i) => i + 1)));
  check("current user is flagged", board.rows.some((r) => r.isCurrentUser && r.handle === "user2"));
  check("no row claims a gap", board.rows.every((r) => !r.gap));
}

{
  // THE INVARIANT, unchanged by the pivot: staleness schedules work, it never
  // subtracts knowledge. A roster nobody has refreshed still renders in full.
  const board = R.buildAllTimeBoardRows(fullRoster({ rankAt: 1, profileAt: 1 }), "");
  eq("an entirely stale roster still yields 25 rows", board.rows.length, 25);
}

{
  // Ordering comes from XP alone now. A stored rank is provenance and must NOT
  // influence the order — that is the whole pivot, so it gets a direct test.
  const roster = fullRoster();
  roster.entries.user20.XP = 9999999;
  roster.entries.user20.rank = 20;
  eq("XP decides the order, not the stored rank",
    R.buildAllTimeBoardRows(roster, "").rows[0].handle, "user20");
}

{
  // Fewer than 25 known: show what there is rather than padding with gaps.
  const roster = R.emptyRoster();
  for (let i = 1; i <= 6; i++) {
    roster.entries["u" + i] = { ...R.blankEntry("u" + i), XP: 1000 - i, Role: "Archmage", Level: 150 };
  }
  const board = R.buildAllTimeBoardRows(roster, "");
  eq("a short roster renders only what it knows", board.rows.length, 6);
  eq("and says how many that is", board.observed, 6);
}

{
  // An XP tie must order deterministically or two rows swap between renders for
  // no reason. Catalyst cannot render a tie, so it picks a stable order.
  const a = { ...R.blankEntry("zeta"), XP: 500 };
  const b = { ...R.blankEntry("alpha"), XP: 500 };
  eq("ties break on handle, not insertion order", R.compareByObservedXp(a, b) > 0, true);
  eq("and the comparator is symmetric", R.compareByObservedXp(b, a) < 0, true);
}

// --- 4. the viewer's own row --------------------------------------------------

{
  const roster = fullRoster();
  roster.entries.me = { ...R.blankEntry("me"), XP: 1, Role: "Sage", Level: 40 };
  const board = R.buildAllTimeBoardRows(roster, "me");
  const own = board.rows.filter((r) => r.outsideBoard);
  eq("a viewer below the board is appended", own.length, 1);
  eq("with no position, because it cannot be known", own[0].position, null);
  eq("nothing on the board was displaced", board.rows.filter((r) => !r.outsideBoard).length, 25);
  eq("a viewer already on the board is not appended",
    R.buildAllTimeBoardRows(fullRoster(), "user4").rows.filter((r) => r.outsideBoard).length, 0);
  eq("an unknown viewer adds nothing",
    R.buildAllTimeBoardRows(fullRoster(), "stranger").rows.filter((r) => r.outsideBoard).length, 0);
}

// --- 5. admission, eviction and caps ------------------------------------------

{
  const roster = fullRoster();
  eq("the admission floor is the lowest retained XP",
    R.admissionThresholdXp(roster), roster.entries.user30.XP);
  check("a handle above the floor is admitted", R.applyRosterObservation(roster,
    { handle: "climber", XP: roster.entries.user30.XP + 1, profileAt: NOW, candidate: true }));

  const roster2 = fullRoster();
  check("an unknown handle with no admission decision is refused",
    !R.applyRosterObservation(roster2, { handle: "nobody", XP: 10, profileAt: NOW }));
  check("and is not stored", !roster2.entries.nobody);
  eq("an empty roster has no floor", R.admissionThresholdXp(R.emptyRoster()), null);
}

{
  // Pruning keeps the highest XP now that rank cannot order the store.
  const roster = fullRoster();
  for (let i = 0; i < 60; i++) {
    R.applyRosterObservation(roster, { handle: "cand" + i, XP: 1 + i, profileAt: NOW, candidate: true });
  }
  check("total entries are capped",
    Object.keys(roster.entries).length <= R.constants.ROSTER_MAX_ENTRIES,
    "got " + Object.keys(roster.entries).length);
  check("the seeded top survives a flood of low-XP candidates", Boolean(roster.entries.user1));
}

// --- 6. a falling XP is stored, never clamped ---------------------------------

{
  const roster = fullRoster();
  const before = roster.entries.user5.XP;
  R.applyRosterObservation(roster, { handle: "user5", XP: before - 50000, profileAt: NOW });
  eq("a reduced XP is written as observed", roster.entries.user5.XP, before - 50000);
  eq("and the board simply re-orders",
    R.buildAllTimeBoardRows(roster, "").rows.filter((r) => !r.outsideBoard).length, 25);
}

// --- 7. refresh queue ---------------------------------------------------------

{
  const roster = fullRoster();
  const seen = new Set();
  let cursor = 0;
  for (let load = 0; load < Math.ceil(30 / R.constants.ROSTER_XP_SLICE); load++) {
    roster.xpCursor = cursor;
    const result = R.pickXpRefreshTargets(roster, { now: NOW });
    for (const handle of result.targets) {
      check("no handle is refreshed twice before all are refreshed once", !seen.has(handle), handle);
      seen.add(handle);
    }
    cursor = result.cursor;
  }
  eq("the whole roster is covered within a handful of loads", seen.size, 30);
}

{
  const { targets } = R.pickXpRefreshTargets(fullRoster(), { skip: ["user1", "user2"], now: NOW });
  check("skipped handles are not requested", !targets.includes("user1") && !targets.includes("user2"));
  eq("skipping does not cost a slot", targets.length, R.constants.ROSTER_XP_SLICE);
}

{
  eq("a handle sighted moments ago is not re-requested",
    R.pickXpRefreshTargets(fullRoster({ profileAt: NOW }), { now: NOW }).targets.length, 0);
}

{
  // Priming must terminate, or the roster polls every 20 seconds forever.
  const roster = fullRoster();
  check("a new roster starts unprimed", !R.rosterIsPrimed(roster));
  let passes = 0;
  let wraps = 0;
  while (wraps === 0 && passes < 50) {
    const result = R.pickXpRefreshTargets(roster, { slice: R.constants.ROSTER_XP_PRIMING_SLICE, now: NOW });
    roster.xpCursor = result.cursor;
    if (result.wrapped) wraps += 1;
    passes += 1;
  }
  roster.xpWraps = wraps;
  check("the cursor wraps within ceil(entries / slice) passes",
    passes <= Math.ceil(30 / R.constants.ROSTER_XP_PRIMING_SLICE), "took " + passes + " passes");
  check("a wrap ends priming for good", R.rosterIsPrimed(roster));

  const result = R.pickXpRefreshTargets(fullRoster({ profileAt: NOW }),
    { slice: R.constants.ROSTER_XP_PRIMING_SLICE, now: NOW });
  eq("a pass that requests nothing still advances", result.targets.length, 0);
  check("and still reports the wrap", result.wrapped);
}

// --- 8. field reads -----------------------------------------------------------

{
  // The rank is gone from the API (0 of 26 handles, 2026-08-21). The reader is
  // kept only so a restored field would be noticed, so it must still work.
  eq("rank reads PascalCase if it ever returns", R.readAlltimeRank({ data: { LeaderboardXPRankAlltime: 2 } }), 2);
  eq("rank reads the measured camel spelling", R.readAlltimeRank({ data: { leaderboardXPRankAlltime: 4 } }), 4);
  eq("a missing rank is null, never 0", R.readAlltimeRank({ data: { karma: 5 } }), null);

  // What actually ships today.
  eq("percentile reads the live shape",
    R.readAlltimePercentile({ data: { karma: 5, leaderboardXPPercentileAlltime: 1 } }), 1);
  eq("percentile reads a bare body", R.readAlltimePercentile({ leaderboardXPPercentileAlltime: 17 }), 17);
  eq("percentile reads PascalCase too",
    R.readAlltimePercentile({ data: { LeaderboardXPPercentileAlltime: 8 } }), 8);
  eq("a missing percentile is null, never 0", R.readAlltimePercentile({ data: { karma: 5 } }), null);

  eq("student count reads the measured camelCase shape",
    R.readRegisteredUsers({ registeredUsersAlltime: 1397179 }), 1397179);
  eq("student count still reads the older PascalCase shape",
    R.readRegisteredUsers({ RegisteredUsersAlltime: 1390194 }), 1390194);
  eq("a missing student count is null", R.readRegisteredUsers({ lessonCompletions: 1 }), null);
}

// --- 9. the bundled seed still produces a full board --------------------------

{
  const roster = R.emptyRoster();
  R.applySeedToRoster(roster);
  check("the seed fills the board", R.rosterCoverage(roster) >= 25);
  const board = R.buildAllTimeBoardRows(roster, "");
  eq("a fresh install shows 25 rows", board.rows.length, 25);
  eq("every seeded row carries XP", board.rows.filter((r) => r.xp == null).length, 0);
  check("seeded rows are ordered by XP descending",
    board.rows.every((r, i, arr) => i === 0 || arr[i - 1].xp >= r.xp));
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("check_alltime_roster: all checks passed");
