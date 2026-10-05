#!/usr/bin/env node
// Checks for the signed-in user's own place on Personal Leaderboards and Top
// Observed Learners (bootdev-extension/src/leaderboard.js and allTimeRoster.js),
// evaluated in a vm sandbox with the files they need.
//
// Run from anywhere:  node scripts/check_personal_self.mjs
//
// What must hold:
//   1. The viewer is added automatically once their handle is known, and only
//      while Personal Leaderboards is on.
//   2. Removing yourself sticks: auto-add never puts you back, and adding
//      yourself by hand clears that choice.
//   3. Being a tracked handle must not give the viewer a stored lifetime XP.
//      The viewer's own XP comes only from values observed this session — a
//      stored copy of "me" silently wrong-footed every comparison in v0.13.1.
//   4. Top Observed Learners gives the viewer no exemption: they are admitted
//      and pruned by XP like anyone, and appear on the board only if they are
//      among its top 25.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);

const storage = {};
const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: {
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  },
  // Not the leaderboard: keeps the render and the network refresh out of it.
  location: { origin: "https://www.boot.dev", pathname: "/dashboard" },
  console,
  URL,
  chrome: {
    runtime: { getURL: (p) => `chrome-extension://catalyst-test/${p}`, lastError: undefined },
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: storage[key] }),
        set: (obj, cb) => { Object.assign(storage, JSON.parse(JSON.stringify(obj))); cb && cb(); },
      },
    },
  },
  isFeatureEnabled: () => true,
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  queueMicrotask: () => {},
};
vm.createContext(sandbox);
for (const file of ["utils.js", "observed-learners.js", "alltime-seed.js", "allTimeRoster.js", "leaderboard.js"]) {
  const url = new URL(file, SRC);
  vm.runInContext(readFileSync(url, "utf8"), sandbox, { filename: fileURLToPath(url) });
}
const run = (code) => vm.runInContext(code, sandbox);
const { shouldAutoAddSelf } = testHook.leaderboard;

let failures = 0;
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  failures += 1;
  console.error(`FAIL: ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- 1. the rule ----------------------------------------------------------------

const base = { enabled: true, handle: "me", handles: ["friend"], optOut: [] };
eq("added when known, on, absent and not opted out", shouldAutoAddSelf(base), true);
eq("not while Personal Leaderboards is off", shouldAutoAddSelf({ ...base, enabled: false }), false);
eq("not before the handle is known", shouldAutoAddSelf({ ...base, handle: "" }), false);
eq("not twice", shouldAutoAddSelf({ ...base, handles: ["me"] }), false);
eq("not after removing yourself", shouldAutoAddSelf({ ...base, optOut: ["me"] }), false);
eq("an opt-out is per handle", shouldAutoAddSelf({ ...base, handle: "other-me", optOut: ["me"] }), true);

// --- 2. end to end through the real functions ---------------------------------------

await run(`(async () => {
  currentUserHandle = "me";
  personalHandles = ["friend"];
  personalSelfOptOut = [];
  personalAutoAddAttempted = "";
  await maybeAutoAddCurrentUser();
})()`);
eq("the viewer is added, first", run("personalHandles"), ["me", "friend"]);
eq("and the list is saved", storage.be_personal_leaderboard_handles?.handles, ["me", "friend"]);

await run(`removePersonalHandle("me", { byUser: true })`);
eq("removing yourself is remembered", storage.be_personal_self_opt_out?.handles, ["me"]);
await run(`(async () => { personalAutoAddAttempted = ""; await maybeAutoAddCurrentUser(); })()`);
eq("and auto-add leaves you out", run("personalHandles"), ["friend"]);

await run(`removePersonalHandle("friend")`);
eq("a removal that was not the user's choice remembers nothing",
  storage.be_personal_self_opt_out?.handles, ["me"]);

await run(`(async () => {
  personalSelfOptOut = [];
  await loadPersonalLeaderboard();
})()`);
eq("the opt-out survives a reload", run("personalSelfOptOut"), ["me"]);

// --- 3. no stored copy of "me" -------------------------------------------------------

run(`
  currentUserHandle = "me";
  currentUserLiveXp = null;
  cachedLeagueEntries = [];
  cachedLeagueDailyEntries = [];
  personalRecords = { me: { handle: "me", profile: { XP: 123456 }, updatedAt: 1 } };
`);
eq("a stored personal record is not the viewer's XP", run(`getMyValue("xp")`), null);
run("recordCurrentUserLiveXp(200000)");
eq("a value observed this session is", run(`getMyValue("xp")`), 200000);

// --- 4. the viewer on Top Observed Learners -----------------------------------------

run(`
  currentUserHandle = "me";
  allTimeRoster = emptyRoster();
  for (let i = 0; i < ROSTER_MAX_ENTRIES; i++) {
    allTimeRoster.entries["top" + i] = { ...blankEntry("top" + i), XP: 2000000 + i, profileAt: 1 };
  }
  noteAllTimeProfile("me", { handle: "me", xp: 5000, level: 40, role: "Sage" }, 2);
`);
eq("at capacity, the viewer is refused below the bar like anyone", run(`Boolean(allTimeRoster.entries.me)`), false);

run(`
  allTimeRoster = emptyRoster();
  for (let i = 0; i < 50; i++) {
    allTimeRoster.entries["top" + i] = { ...blankEntry("top" + i), XP: 2000000 + i, profileAt: 1 };
  }
  noteAllTimeProfile("me", { handle: "me", xp: 5000, level: 40, role: "Sage" }, 2);
`);
eq("below capacity, the viewer is admitted like anyone", run(`allTimeRoster.entries.me?.XP`), 5000);
eq("but is not on the board unless among its top 25",
  run(`buildAllTimeBoardRows(allTimeRoster, "me").rows.some((r) => r.isCurrentUser)`), false);
run(`for (let i = 0; i < ROSTER_PRUNE_AT - 50; i++) {
  noteAllTimeProfile("climber" + i, { handle: "climber" + i, xp: 3000000 + i, level: 200, role: "Archmage" }, 3);
}`);
eq("and is pruned like anyone once 100 higher learners are known", run(`Boolean(allTimeRoster.entries.me)`), false);
eq("leaving exactly the 100 highest", run(`Object.keys(allTimeRoster.entries).length`), run("ROSTER_MAX_ENTRIES"));

run(`noteAllTimeProfile("me", { handle: "me", xp: 9000000, level: 250, role: "Archmage" }, 4)`);
eq("a viewer who earns a place is highlighted in it",
  run(`buildAllTimeBoardRows(allTimeRoster, "me").rows.filter((r) => r.isCurrentUser).map((r) => r.position)`), [1]);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("check_personal_self: all checks passed");
