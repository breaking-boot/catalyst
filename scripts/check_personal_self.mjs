#!/usr/bin/env node
// Checks for the signed-in user's own place on Personal Leaderboards
// (bootdev-extension/src/leaderboard.js), evaluated in a vm sandbox with the
// files it needs.
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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("check_personal_self: all checks passed");
