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
//   2. Positions are derived from XP only when a counting check PROVES no
//      unknown sits inside the window.
//   3. XP comparisons across different observation times are valid in one
//      direction only. The other direction would invent swaps.
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
    ["handle", "rank", "xp", "firstName", "lastName", "role", "level", "profileImageURL"].includes(k))));

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

{
  const roster = R.emptyRoster();
  R.bootstrapRosterFromPersonalRecords(roster, { someone: { stats: { LeaderboardXPRankAlltime: 7 } } });
  eq("bootstrap admits an in-window rank", roster.entries.someone.rank, 7);
  eq("bootstrap claims no freshness", roster.entries.someone.rankAt, 0);
  R.applySeedToRoster(roster, { generatedAt: new Date(NOW).toISOString(), entries: [{ handle: "someone", rank: 4 }] });
  eq("bootstrap loses to the seed", roster.entries.someone.rank, 4);
}

// --- 3. rows, gaps and the no-decay invariant --------------------------------

{
  const board = R.buildAllTimeBoardRows(fullRoster(), "user2");
  eq("verified mode on a complete board", board.mode, "verified");
  eq("25 slots rendered", board.rows.filter((r) => !r.outsideBoard).length, 25);
  eq("no gaps on a complete board", board.rows.filter((r) => r.gap).length, 0);
  eq("coverage counts every position", board.coverage, 25);
  const positions = board.rows.map((r) => r.position);
  eq("positions are 1..25 exactly once", new Set(positions).size, 25);
  check("current user is flagged", board.rows.some((r) => r.isCurrentUser && r.handle === "user2"));
}

{
  // THE INVARIANT: staleness schedules work, it never subtracts knowledge.
  const ancient = fullRoster({ rankAt: 1, profileAt: 1 });
  const board = R.buildAllTimeBoardRows(ancient, "");
  eq("an entirely stale roster still yields 25 real rows", board.rows.filter((r) => !r.gap).length, 25);
  eq("an entirely stale roster yields no gaps", board.rows.filter((r) => r.gap).length, 0);
}

{
  const roster = fullRoster();
  delete roster.entries.user17;
  const board = R.buildAllTimeBoardRows(roster, "");
  eq("a missing occupant falls back", board.mode, "fallback");
  const gaps = board.rows.filter((r) => r.gap);
  eq("exactly one gap row", gaps.length, 1);
  eq("the gap is at the vacated position", gaps[0].position, 17);
  eq("the gap is keyed by position", gaps[0].key, "gap:17");
  eq("coverage reports 24 of 25", board.coverage, 24);
  check("a gap has no handle, XP or link", !gaps[0].handle && !gaps[0].xp && !gaps[0].href);
}

{
  const roster = fullRoster();
  roster.self = { handle: "me", rank: 402, rankAt: NOW };
  const board = R.buildAllTimeBoardRows(roster, "me");
  const own = board.rows.filter((r) => r.outsideBoard);
  eq("a viewer outside the board is appended", own.length, 1);
  eq("appended at their true rank", own[0].position, 402);
  eq("nothing known was displaced", board.rows.filter((r) => !r.outsideBoard).length, 25);

  const inside = fullRoster();
  inside.self = { handle: "user4", rank: 4, rankAt: NOW };
  eq("a viewer inside the board is not appended",
    R.buildAllTimeBoardRows(inside, "user4").rows.filter((r) => r.outsideBoard).length, 0);
}

// --- 4. gap role frame is derived, not hardcoded ------------------------------

{
  const roster = fullRoster();
  delete roster.entries.user17;
  const { positions } = R.deriveBoardPositions(roster, NOW);
  eq("gap frame follows the learner below it", R.gapRoleForPosition(positions, 17), "Archmage");

  const lower = fullRoster();
  delete lower.entries.user17;
  for (const entry of Object.values(lower.entries)) entry.Role = "Sage";
  const derived = R.deriveBoardPositions(lower, NOW);
  eq("gap frame is derived from the board, not fixed to Archmage",
    R.gapRoleForPosition(derived.positions, 17), "Sage");
}

// --- 5. position derivation and the counting check ----------------------------

{
  // An unknown inside the window leaves the count one short of rank-1, which is
  // exactly what must abandon verified mode.
  const roster = fullRoster();
  delete roster.entries.user20;
  const { mode } = R.deriveBoardPositions(roster, NOW);
  eq("an unknown inside the window forces fallback", mode, "fallback");
}

{
  const stale = fullRoster({ rankAt: NOW - 10 * DAY });
  eq("an anchor too old to trust forces fallback", R.deriveBoardPositions(stale, NOW).mode, "fallback");
}

{
  // Verified mode renumbers by XP, so a swap shows with no rank request at all.
  const roster = fullRoster();
  roster.entries.user7.XP = roster.entries.user6.XP + 1;
  const board = R.buildAllTimeBoardRows(roster, "");
  eq("still verified after a swap", board.mode, "verified");
  const sixth = board.rows.find((r) => r.position === 6);
  eq("the overtaking learner takes the position", sixth.handle, "user7");
  eq("positions stay unique after a swap", new Set(board.rows.map((r) => r.position)).size, 25);
}

{
  // Fallback mode is where duplicates can appear at all; both must render.
  const roster = fullRoster();
  delete roster.entries.user20;
  roster.entries.user12.rank = 11;
  roster.entries.user12.rankAt = NOW;
  const board = R.buildAllTimeBoardRows(roster, "");
  eq("fallback keeps both claimants", board.rows.filter((r) => r.position === 11).length, 2);
  eq("fresher observation renders first", board.rows.find((r) => r.position === 11).handle, "user12");
}

// --- 6. admission, eviction and caps ------------------------------------------

{
  const roster = fullRoster();
  eq("admission floor is the deepest retained position, not rank 25",
    R.admissionThresholdXp(roster), roster.entries.user30.XP);

  const above = { handle: "climber", XP: roster.entries.user30.XP + 1, profileAt: NOW, candidate: true };
  check("a handle above the floor is admitted", R.applyRosterObservation(roster, above));
  eq("admitted with no rank yet", roster.entries.climber.rank, null);

  const roster2 = fullRoster();
  const below = { handle: "nobody", XP: 10, profileAt: NOW };
  check("a handle with no rank and no candidacy is refused", !R.applyRosterObservation(roster2, below));
  check("and is not stored", !roster2.entries.nobody);

  const roster3 = fullRoster();
  R.applyRosterObservation(roster3, { handle: "user30", rank: 41, rankAt: NOW });
  check("a rank past the window evicts", !roster3.entries.user30);
}

{
  const roster = R.emptyRoster();
  eq("no ranked entry means no admission floor", R.admissionThresholdXp(roster), null);
}

{
  const roster = fullRoster();
  for (let i = 0; i < 30; i++) {
    R.applyRosterObservation(roster, { handle: `cand${i}`, XP: 5_000_000 - i, profileAt: NOW, candidate: true });
  }
  const candidates = Object.values(roster.entries).filter((e) => e.rank == null);
  check("candidate count is capped", candidates.length <= R.constants.ROSTER_CANDIDATE_MAX,
    `got ${candidates.length}`);
  check("total entries are capped", Object.keys(roster.entries).length <= R.constants.ROSTER_MAX_ENTRIES);
}

// --- 7. a falling XP is stored, never clamped ---------------------------------

{
  // Boot.dev staff can reduce XP for suspected cheating. Rare, never observed,
  // and must not corrupt anything — a Math.max guard here would freeze the row.
  const roster = fullRoster();
  const before = roster.entries.user5.XP;
  R.applyRosterObservation(roster, { handle: "user5", XP: before - 50_000, profileAt: NOW });
  eq("a reduced XP is written as observed", roster.entries.user5.XP, before - 50_000);
  const board = R.buildAllTimeBoardRows(roster, "");
  eq("the board still renders 25 slots after a reduction", board.rows.filter((r) => !r.outsideBoard).length, 25);
}

// --- 8. one-directional XP comparison -----------------------------------------

{
  // TRUE positive: a value read NOW exceeds a stored one from a higher-ranked
  // learner. Stored XP is a lower bound, so the true order is proven.
  const roster = fullRoster();
  const fresh = roster.entries.user6.XP + 1;
  const suspects = R.detectOvertakes(roster, "user7", fresh);
  check("a proven overtake raises both parties", suspects.includes("user7") && suspects.includes("user6"),
    JSON.stringify(suspects));

  // FALSE positive guard: the same numbers read the other way round prove
  // nothing, because the stale side may have grown past it since.
  const quiet = R.detectOvertakes(roster, "user6", roster.entries.user6.XP);
  eq("a lower-ranked learner merely being behind raises nothing", quiet.length, 0);

  const alsoQuiet = R.detectOvertakes(roster, "user7", roster.entries.user7.XP);
  eq("an unchanged XP raises nothing", alsoQuiet.length, 0);
}

// --- 9. refresh queues --------------------------------------------------------

{
  const roster = fullRoster();
  const seen = new Set();
  let cursor = 0;
  const loads = Math.ceil(30 / R.constants.ROSTER_XP_SLICE);
  for (let load = 0; load < loads; load++) {
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
  const roster = fullRoster();
  const { targets } = R.pickXpRefreshTargets(roster, { skip: ["user1", "user2"], now: NOW });
  check("skipped handles are not requested", !targets.includes("user1") && !targets.includes("user2"));
  eq("skipping does not cost a slot", targets.length, R.constants.ROSTER_XP_SLICE);
}

{
  const roster = fullRoster({ profileAt: NOW });
  const { targets } = R.pickXpRefreshTargets(roster, { now: NOW });
  eq("a handle sighted moments ago is not re-requested", targets.length, 0);
}

{
  const roster = fullRoster({ rankAt: NOW });
  roster.entries.candidate = { ...R.blankEntry("candidate"), XP: 1_000_000, profileAt: NOW };
  roster.entries.user30.rankAt = NOW - 5 * HOUR;
  const targets = R.pickRankRefreshTargets(roster, { suspects: ["user4"], now: NOW });
  eq("a candidate is the first rank target", targets[0].handle, "candidate");
  eq("and is tier 0", targets[0].tier, 0);
  eq("a proven suspect comes next", targets[1].handle, "user4");
  eq("the boundary TTL comes after that", targets[2].handle, "user30");
  check("the rank slice is capped", targets.length <= R.constants.ROSTER_RANK_SLICE);
}

{
  const roster = fullRoster({ rankAt: NOW - 3 * HOUR });
  eq("nothing is due inside its band", R.pickRankRefreshTargets(roster, { now: NOW }).length, 0);

  const midDue = fullRoster({ rankAt: NOW - 3 * DAY });
  const targets = R.pickRankRefreshTargets(midDue, { now: NOW });
  check("the boundary band comes due before the top band",
    targets.every((t) => midDue.entries[t.handle].rank >= 11),
    JSON.stringify(targets));
}

// --- 10. field reads ----------------------------------------------------------

{
  eq("rank reads PascalCase", R.readAlltimeRank({ data: { LeaderboardXPRankAlltime: 2 } }), 2);
  eq("rank reads a bare body", R.readAlltimeRank({ LeaderboardXPRankAlltime: 9 }), 9);
  eq("rank tolerates a casing flip", R.readAlltimeRank({ data: { leaderboardXpRankAlltime: 4 } }), 4);
  eq("a missing rank is null, never 0", R.readAlltimeRank({ data: { Karma: 5 } }), null);

  // The real capture is a BARE object with no data wrapper.
  eq("student count reads the captured shape",
    R.readRegisteredUsers({ LessonCompletions: 68262, RegisteredUsersAlltime: 1390194 }), 1390194);
  eq("student count reads a wrapped body", R.readRegisteredUsers({ data: { RegisteredUsersAlltime: 5 } }), 5);
  eq("a missing student count is null", R.readRegisteredUsers({ LessonCompletions: 1 }), null);
}

// --- 11. the bundled seed produces a complete board ---------------------------

{
  const roster = R.emptyRoster();
  R.applySeedToRoster(roster);
  eq("the seed fills the whole board", R.rosterCoverage(roster), 25);
  const board = R.buildAllTimeBoardRows(roster, "");
  eq("a fresh install has no gaps", board.rows.filter((r) => r.gap).length, 0);
  eq("every seeded row carries XP", board.rows.filter((r) => !r.gap && r.xp == null).length, 0);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("check_alltime_roster: all checks passed");
