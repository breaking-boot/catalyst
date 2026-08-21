#!/usr/bin/env node
// Unit checks for dual-casing reads of the leaderboard, profile, stats and
// activity-heatmap responses, exercised against the REAL shipped code:
// bootdev-extension/src/utils.js and src/leaderboard.js are evaluated in a vm
// sandbox and the helpers are pulled off the __BOOTDEV_ENHANCER_TEST__ hook
// (inert in production because that global never exists on the real page).
//
// Run from anywhere:  node scripts/check_leaderboard_casing.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: Boot.dev migrated these DTOs from PascalCase to camelCase
// between 2026-08-15 and 2026-08-19 and every Catalyst read stopped resolving.
// The native board comparisons vanished, and the Personal Leaderboards panel
// lost its avatars, rank frames, names and both All-Time columns while still
// rendering rows — a half-healthy UI is exactly how a rename hides.
//
// The league boards mattered most: their ENVELOPE key flipped too
// (LeagueMembers -> leagueMembers), so getLeaderboardEntries returned [] and
// both League boards failed with nothing in the console. Casing the entry
// fields alone would not have repaired them, which is why the envelope gets its
// own cases below.
//
// PascalCase can no longer be exercised against the live API, so these fixtures
// are the only thing keeping that half honest.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);
const PASCAL_CAPTURE = new URL(
  "../reference_data/catalyst_versions/v0.12.2_api_casing_audit/api/responses/api_bodies_v3_2026-07-31.json",
  import.meta.url
);

// --- evaluate utils.js + leaderboard.js in a sandbox -------------------------

const warnings = [];
const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: {
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  },
  location: { origin: "https://www.boot.dev", pathname: "/leaderboard" },
  console: { ...console, warn: (msg) => warnings.push(String(msg)) },
  URL,
  chrome: {
    runtime: { getURL: (p) => `chrome-extension://catalyst-test/${p}` },
    storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() } },
  },
  // allTimeRoster.js gates its intake on this; settings.js is not loaded here.
  isFeatureEnabled: () => true,
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  queueMicrotask: () => {},
};
vm.createContext(sandbox);
for (const file of ["utils.js", "alltime-seed.js", "allTimeRoster.js", "leaderboard.js"]) {
  const url = new URL(file, SRC);
  vm.runInContext(readFileSync(url, "utf8"), sandbox, { filename: fileURLToPath(url) });
}

const hooks = testHook.leaderboard;
if (!hooks) {
  console.error("FAIL: leaderboard.js did not expose test hooks");
  process.exit(1);
}
const {
  getLeaderboardEntries, getHandle, getDisplayName, getAvatarUrl,
  getRoleFrameIndex, mapByHandle, leagueMyValueOrZero, distillHeatmap,
  leaderAvatarSignature,
} = hooks;
const { readField, readNum, reportUsableFields } = sandbox;

const rosterHooks = testHook.allTimeRoster;
if (!rosterHooks) {
  console.error("FAIL: allTimeRoster.js did not expose test hooks");
  process.exit(1);
}
const { readAlltimeRank, readRegisteredUsers, emptyRoster, applyRosterObservation } = rosterHooks;
const runInSandbox = (code) => vm.runInContext(code, sandbox);

// --- tiny assert -------------------------------------------------------------

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

// The camelCase spelling of every field, written out here INDEPENDENTLY of the
// production table so the two have to agree. These are the spellings probes 12
// and 12b measured on 2026-08-19 — note the ones a lowercasing rule would get
// wrong (profileImageURL, xpForLevel, githubCommits).
const MEASURED_CAMEL = {
  XP: "xp", XPEarned: "xpEarned", Karma: "karma", Position: "position",
  Level: "level", Role: "role", Handle: "handle", FirstName: "firstName",
  LastName: "lastName", ProfileImageURL: "profileImageURL",
  XPForLevel: "xpForLevel", XPTotalForLevel: "xpTotalForLevel",
  Calendar: "calendar", GithubCommits: "githubCommits", Date: "date", Count: "count",
  // envelope
  LeagueName: "leagueName", LeagueMembers: "leagueMembers", ExpiresAt: "expiresAt",
  Leaderboard: "leaderboard", Entries: "entries", Members: "members", Users: "users",
};

// Rewrite a PascalCase payload into the measured camelCase shape. Unlisted keys
// are left alone rather than guessed at, which is the same discipline as the
// production alias table.
function toCamel(value) {
  if (Array.isArray(value)) return value.map(toCamel);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[MEASURED_CAMEL[k] || k] = toCamel(v);
  return out;
}

// --- 1. the reader itself ----------------------------------------------------

check("readField finds PascalCase", readField({ XPEarned: 5 }, "XPEarned"), 5);
check("readField finds camelCase", readField({ xpEarned: 5 }, "XPEarned"), 5);
check("readField prefers PascalCase when both exist", readField({ XPEarned: 5, xpEarned: 9 }, "XPEarned"), 5);
check("readField on a missing field is undefined", readField({ other: 1 }, "XPEarned"), undefined);
check("readField on a non-object is undefined", readField(null, "XPEarned"), undefined);
check("readField reads an unlisted name as-is", readField({ Whatever: 3 }, "Whatever"), 3);
// A field Catalyst cannot read must never become a number.
check("readNum on a missing field is null", readNum({ other: 1 }, "XP"), null);
check("readNum reads camelCase", readNum({ xp: 12 }, "XP"), 12);
check("readNum on a non-numeric value is null", readNum({ xp: "nope" }, "XP"), null);
// The spellings a generic lowercasing rule would get wrong.
check("readField reads profileImageURL", readField({ profileImageURL: "u" }, "ProfileImageURL"), "u");
check("readField reads xpForLevel", readField({ xpForLevel: 7 }, "XPForLevel"), 7);
check("readField reads githubCommits", readField({ githubCommits: [] }, "GithubCommits"), []);

// --- 2. the envelope, in both casings ---------------------------------------

const leaguePascal = {
  LeagueName: "Thorned Dwarf League",
  LeagueMembers: [{ Handle: "a-fleming", XPEarned: 9919, XP: 37233 }],
  ExpiresAt: "2026-08-25T00:00:00Z",
};
// The 2026-08-19 shape, memberLimit and all.
const leagueCamel = { ...toCamel(leaguePascal), memberLimit: 30 };

check("envelope: PascalCase LeagueMembers", getLeaderboardEntries(leaguePascal).length, 1);
check("envelope: camelCase leagueMembers", getLeaderboardEntries(leagueCamel).length, 1);
check("envelope: leagueMembers under data", getLeaderboardEntries({ data: leagueCamel }).length, 1);
check("envelope: LeagueMembers under data", getLeaderboardEntries({ data: leaguePascal }).length, 1);
check("envelope: bare array", getLeaderboardEntries([{ handle: "a" }]).length, 1);
check("envelope: array under data", getLeaderboardEntries({ data: [{ handle: "a" }] }).length, 1);
check("envelope: unrecognized shape yields no entries", getLeaderboardEntries({ nope: 1 }).length, 0);
check("envelope: null yields no entries", getLeaderboardEntries(null).length, 0);
// The regression itself: this returned 0 before the fix.
check(
  "envelope: the 2026-08-19 league response resolves",
  getLeaderboardEntries(leagueCamel)[0]?.xpEarned ?? null,
  9919
);

// --- 3. entry readers agree across casings ----------------------------------

const entryPascal = {
  XP: 211110, XPEarned: 51340, Position: 1, Level: 69, Role: "Sorcerer",
  Handle: "quarrelsomeintention45", FirstName: "Anthony", LastName: "Nelson",
  ProfileImageURL: "https://storage.googleapis.com/avatar.png",
};
const entryCamel = toCamel(entryPascal);

for (const [label, read] of [
  ["getHandle", getHandle],
  ["getDisplayName", (e) => getDisplayName(e, "fallback")],
  ["getAvatarUrl", getAvatarUrl],
  ["getRoleFrameIndex", getRoleFrameIndex],
]) {
  check(`${label} agrees across casings`, read(entryCamel), read(entryPascal));
}
check("getDisplayName reads firstName, not the handle", getDisplayName(entryCamel, "quarrelsomeintention45"), "Anthony");
check("getAvatarUrl reads profileImageURL", getAvatarUrl(entryCamel), entryPascal.ProfileImageURL);
// The blank-avatar / missing-frame symptom, pinned directly.
check(
  "avatar signature agrees across casings",
  leaderAvatarSignature(entryCamel, "Anthony"),
  leaderAvatarSignature(entryPascal, "Anthony")
);

check("mapByHandle agrees across casings", mapByHandle([entryCamel], "XPEarned"), mapByHandle([entryPascal], "XPEarned"));
check("mapByHandle reads camelCase", mapByHandle([entryCamel], "XPEarned"), { quarrelsomeintention45: 51340 });
check("mapByHandle skips an unreadable field", mapByHandle([{ handle: "a", other: 1 }], "XPEarned"), {});

// A row as getPersonalRows builds it: lowercase handle/name/avatar are
// Catalyst's OWN shape, not API names, and must keep winning.
const personalRow = { handle: "kat", name: "Kat", avatar: "kat.png", Handle: "kat", Level: 100, Role: "archmage" };
check("personal row: internal name wins", getDisplayName(personalRow, "kat"), "Kat");
check("personal row: internal avatar wins", getAvatarUrl(personalRow), "kat.png");
check("personal row: role still resolves a frame", getRoleFrameIndex(personalRow) >= 0, true);

// --- 4. missing yields null, never 0 ----------------------------------------

const unreadableBoard = [{ handle: "a", mysteryXp: 5 }, { handle: "b", mysteryXp: 7 }];
const readableBoard = [{ handle: "a", xpEarned: 5 }, { handle: "b", xpEarned: 7 }];

// Nobody in these fixtures is the current user (no DOM identity in the
// sandbox), so myValueFromEntries returns null and only the readability
// branch differs — which is exactly the distinction being pinned.
check("league value: unreadable board yields null", leagueMyValueOrZero(unreadableBoard, "XPEarned"), null);
check("league value: readable board, viewer absent, yields 0", leagueMyValueOrZero(readableBoard, "XPEarned"), 0);
check("league value: empty board yields null", leagueMyValueOrZero([], "XPEarned"), null);
// The cross-semantic fallback must stay dead: XPEarned is trailing-24h, XP is
// a lifetime total, so one must never stand in for the other.
check("all-time XP does not fall back to XPEarned", readNum({ xpEarned: 51340 }, "XP"), null);

// --- 5. rename detection sees both casings ----------------------------------

function warnsFor(entries) {
  warnings.length = 0;
  // A distinct label per call so warnOnce's per-session dedupe cannot mask a case.
  reportUsableFields(`/test/${Math.random()}`, entries, "XPEarned", (e) => readField(e, "XPEarned"));
  return warnings.length > 0;
}
check("detection: silent on PascalCase", warnsFor([{ Handle: "a", XPEarned: 1 }]), false);
check("detection: silent on camelCase", warnsFor([{ handle: "a", xpEarned: 1 }]), false);
check("detection: warns on an unknown third spelling", warnsFor([{ handle: "a", xp_earned: 1 }]), true);
check("detection: silent on an empty response", warnsFor([]), false);

// --- 6. activity heatmap -----------------------------------------------------

// distillHeatmap buckets by the viewer's LOCAL date (localDateKey), because the
// heatmap is requested with the viewer's timezone. Building this fixture from
// the UTC date instead made the test fail for the hours each day where the two
// disagree — a real flake, not a code fault, first hit 2026-08-21T00:2xZ from a
// UTC-7 machine. Use the same helper the code uses.
const today = sandbox.localDateKey();
const heatmapPascal = {
  Calendar: [{ Date: `${today}T00:00:00Z`, Count: 4 }, { Date: "2026-01-01T00:00:00Z", Count: 2 }],
  GithubCommits: [{ Date: "2026-01-01T00:00:00Z", Count: 1 }],
};
const heatmapCamel = toCamel(heatmapPascal);

check("heatmap agrees across casings", distillHeatmap(heatmapCamel)?.lessonsToday, distillHeatmap(heatmapPascal)?.lessonsToday);
check("heatmap reads camelCase counts", distillHeatmap(heatmapCamel)?.lessonsToday, 4);
check("heatmap reads a data wrapper", distillHeatmap({ data: heatmapCamel })?.lessonsToday, 4);
// Fails closed rather than reporting a fabricated zero.
check("heatmap with an unreadable calendar yields null", distillHeatmap({ calendar: [{ when: "x", n: 1 }] }), null);
check("heatmap with no calendar yields null", distillHeatmap({}), null);

// --- 7. the real PascalCase capture, and a camel twin of it -----------------

if (existsSync(PASCAL_CAPTURE)) {
  const bodies = JSON.parse(readFileSync(PASCAL_CAPTURE, "utf8"))?.bodies || {};
  for (const key of ["league_day", "league_alltime"]) {
    const body = bodies[key]?.json ?? bodies[key];
    if (!body) continue;
    const pascalEntries = getLeaderboardEntries(body);
    const camelEntries = getLeaderboardEntries(toCamel(body));
    check(`capture ${key}: PascalCase capture still resolves`, pascalEntries.length > 0, true);
    check(`capture ${key}: camel twin resolves the same count`, camelEntries.length, pascalEntries.length);
    check(
      `capture ${key}: same handles either way`,
      camelEntries.map((e) => getHandle(e)),
      pascalEntries.map((e) => getHandle(e))
    );
    check(
      `capture ${key}: same XPEarned map either way`,
      mapByHandle(camelEntries, "XPEarned"),
      mapByHandle(pascalEntries, "XPEarned")
    );
    check(
      `capture ${key}: same avatar signatures either way`,
      camelEntries.map((e) => leaderAvatarSignature(e, "")),
      pascalEntries.map((e) => leaderAvatarSignature(e, ""))
    );
  }
} else {
  console.log("note: reference_data fixtures not present; skipped capture checks");
}

// --- all-time roster (v0.15.0) ----------------------------------------------
// The roster is the one place in Catalyst where two shapes meet: API responses
// (either casing) flow IN, and Catalyst's own persisted entries (PascalCase by
// design) stay put. Both halves are pinned here, because converting the wrong
// one is a real and already-made mistake — v0.14.2 broke the avatar tests by
// treating getPersonalRows' own lowercase row keys as casing aliases.

{
  const pascalStats = { data: { Karma: 5, LeaderboardXPRankAlltime: 2 } };
  const camelStats = { data: { karma: 5, leaderboardXPRankAlltime: 2 } };
  check("rank: PascalCase /stats resolves", readAlltimeRank(pascalStats), 2);
  check("rank: camelCase /stats resolves", readAlltimeRank(camelStats), 2);
  check("rank: bare (unwrapped) body resolves", readAlltimeRank({ leaderboardXPRankAlltime: 7 }), 7);
  // The camel form keeps interior capitals; a lowercasing guess would miss it.
  check("rank: lowercased guess is NOT what ships", readAlltimeRank({ leaderboardXpRankAlltime: 9 }), null);
  check("rank: absent yields null, never 0", readAlltimeRank({ data: { Karma: 5 } }), null);
  check("rank: junk yields null", readAlltimeRank(null), null);
}

{
  // /v1/leaderboard_stats was NOT re-read in the 2026-08-19 audit, so this
  // reader resolves any spelling rather than asserting one.
  check("students: PascalCase bare body", readRegisteredUsers({ RegisteredUsersAlltime: 1390194 }), 1390194);
  check("students: camelCase bare body", readRegisteredUsers({ registeredUsersAlltime: 1396977 }), 1396977);
  check("students: wrapped in data", readRegisteredUsers({ data: { registeredUsersAlltime: 42 } }), 42);
  check("students: absent yields null, never 0", readRegisteredUsers({ LessonCompletions: 1 }), null);
}

{
  // Ingesting the same person in either casing must produce an identical entry.
  // Values deliberately DIFFER from the bundled seed's katcodes row, and the
  // observation is newer than the seed — otherwise "newest observation wins"
  // correctly keeps the seed and the test would pass on seed data instead of on
  // the read under test. That is exactly how the first draft of this check
  // fooled itself.
  const AFTER_SEED = Date.parse("2026-09-01T12:00:00Z");
  const profilePascal = {
    Handle: "katcodes", XP: 1999999, FirstName: "Kat", LastName: "C",
    Role: "Archmage", Level: 205, ProfileImageURL: "https://example.test/a.png",
  };
  const profileCamel = {
    handle: "katcodes", xp: 1999999, firstName: "Kat", lastName: "C",
    role: "Archmage", level: 205, profileImageURL: "https://example.test/a.png",
  };

  const ingest = (profile) => {
    runInSandbox("allTimeRoster = emptyRoster(); applySeedToRoster(allTimeRoster);");
    sandbox.__probeProfile = profile;
    runInSandbox(`noteAllTimeProfile("katcodes", __probeProfile, ${AFTER_SEED});`);
    return runInSandbox('JSON.parse(JSON.stringify(allTimeRoster.entries.katcodes))');
  };

  const fromPascal = ingest(profilePascal);
  const fromCamel = ingest(profileCamel);
  check("roster: camelCase profile ingests identically to PascalCase", fromCamel, fromPascal);
  check("roster: the ingest actually overwrote the seed row", fromPascal.XP, 1999999);
  check("roster: XP read from a camelCase profile", fromCamel.XP, 1999999);
  check("roster: name read from a camelCase profile", fromCamel.FirstName, "Kat");
  check("roster: role read from a camelCase profile", fromCamel.Role, "Archmage");
  check("roster: level read from a camelCase profile", fromCamel.Level, 205);
  check("roster: avatar read from a camelCase profile", fromCamel.ProfileImageURL, "https://example.test/a.png");

  // The STORED shape is Catalyst's own and must stay PascalCase whichever way
  // the API is pointing — this is the over-conversion guard.
  check(
    "roster: stored entry keeps Catalyst's PascalCase shape",
    ["Handle", "XP", "FirstName", "Role", "Level", "ProfileImageURL"].every((k) => k in fromCamel),
    true
  );
  check("roster: stored entry does not gain camel keys", "xp" in fromCamel || "firstName" in fromCamel, false);
}

{
  // Discovery off a live board: a camelCase entry above the admission floor
  // must be admitted just as a PascalCase one is.
  const admit = (entry) => {
    runInSandbox("allTimeRoster = emptyRoster(); applySeedToRoster(allTimeRoster);");
    sandbox.__probeEntry = entry;
    runInSandbox("noteAllTimeBoardEntries([__probeEntry]);");
    return runInSandbox('Boolean(allTimeRoster.entries.climber)');
  };
  check("roster: discovery admits a PascalCase board entry",
    admit({ Handle: "climber", XP: 5000000, FirstName: "C", Role: "Archmage", Level: 200 }), true);
  check("roster: discovery admits a camelCase board entry",
    admit({ handle: "climber", xp: 5000000, firstName: "C", role: "Archmage", level: 200 }), true);
  check("roster: discovery still refuses someone below the floor",
    admit({ handle: "nobody", xp: 10, firstName: "N", role: "Sage", level: 60 }), false);
}

// --- report ------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed`);
