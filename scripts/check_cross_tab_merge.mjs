#!/usr/bin/env node
// Unit checks for the cross-tab storage merges, exercised against the REAL
// shipped code: bootdev-extension/src/{utils,settings-schema,settings,
// alltime-seed,allTimeRoster,leaderboard,boss}.js are evaluated in a vm sandbox
// and the helpers are pulled off the __BOOTDEV_ENHANCER_TEST__ hook (inert in
// production because that global never exists on the real page).
//
// Run from anywhere:  node scripts/check_cross_tab_merge.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: chrome.storage.local is shared by every open Boot.dev tab
// while each tab holds its own in-memory copy and writes it back, so the last
// writer won with whatever it knew. Reported as boss event highs differing per
// tab, with only the focused one recognising a new high — and a tab left open
// for a day could lower what a newer tab had recorded.
//
// These merges are the fix, and they are the part that must not drift: they
// decide what survives a collision. They deliberately mirror the rules
// backup.js already applies to an imported file (mergeBossState there), because
// it is the same collision arriving from a different direction.
//
// The live-event path cannot be exercised here — events run 4-8 weeks apart —
// so the rules are pinned against constructed states instead, and the panel
// itself is verified by replaying a captured response through two tabs (see
// be_boss_debug_response in CLAUDE.md).

import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);

const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: {
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null, querySelectorAll: () => [], querySelector: () => null,
  },
  location: { origin: "https://www.boot.dev", pathname: "/leaderboard" },
  console,
  URL,
  chrome: { runtime: { getURL: (p) => `chrome-extension://catalyst-test/${p}` } },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
};
vm.createContext(sandbox);
for (const file of [
  "utils.js", "settings-schema.js", "settings.js",
  "alltime-seed.js", "allTimeRoster.js", "leaderboard.js", "boss.js",
]) {
  vm.runInContext(readFileSync(new URL(file, SRC), "utf8"), sandbox, { filename: file });
}

const { mergeBossStates } = testHook.boss;
const { mergeRosters } = testHook.allTimeRoster;
const { mergeObservedSeries, mergePersonalRecords } = testHook.leaderboard;

let failures = 0;
let checks = 0;
const eq = (name, actual, expected) => {
  checks += 1;
  if (actual !== expected) {
    failures += 1;
    console.error(`FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok    ${name}`);
  }
};

const EVENT = "event-uuid-1";
const OTHER_EVENT = "event-uuid-2";
const T = 1_700_000_000_000;

const state = (over = {}) => ({
  eventId: EVENT,
  bossName: "The Beast",
  current: 40,
  eventHigh: 40,
  eventHighAt: T,
  allTimeHigh: 50,
  aura: { observedMs: 10 * 60_000, weightedSum: 0, lastSampleAt: T, lastPct: 40, changes: [] },
  updatedAt: T,
  ...over,
});

// --- 1. the reported defect: an older tab must not lower a newer high --------
{
  const quiet = state({ eventHigh: 62, eventHighAt: T + 5, allTimeHigh: 67, updatedAt: T - 60_000 });
  const fresh = state({ eventHigh: 41, allTimeHigh: 50, updatedAt: T });
  const merged = mergeBossStates(fresh, quiet);
  eq("a stale tab's write keeps the other tab's event high", merged.eventHigh, 62);
  eq("and its all-time high", merged.allTimeHigh, 67);
  eq("the high's timestamp travels with the value that won", merged.eventHighAt, T + 5);
  eq("the newer copy still provides the live figure", merged.current, 40);
}

// --- 2. symmetry: the merge cannot depend on which tab happens to write ------
{
  const a = state({ eventHigh: 62, allTimeHigh: 67, updatedAt: T });
  const b = state({ eventHigh: 41, allTimeHigh: 50, updatedAt: T + 1 });
  eq("merge is symmetric for the highs (a,b)", mergeBossStates(a, b).eventHigh, 62);
  eq("merge is symmetric for the highs (b,a)", mergeBossStates(b, a).eventHigh, 62);
  eq("all-time high, either order", mergeBossStates(b, a).allTimeHigh, 67);
}

// --- 3. a high from a DIFFERENT event is not comparable ----------------------
{
  const mine = state({ eventId: EVENT, eventHigh: 30, allTimeHigh: 50, updatedAt: T + 10 });
  const theirs = state({ eventId: OTHER_EVENT, eventHigh: 90, allTimeHigh: 90, updatedAt: T });
  const merged = mergeBossStates(mine, theirs);
  eq("another event's high does not become this event's high", merged.eventHigh, 30);
  eq("but the all-time high still crosses events", merged.allTimeHigh, 90);
  eq("and the current event id is kept", merged.eventId, EVENT);
}

// --- 4. aura: whichever side observed more wins WHOLE, never summed ----------
{
  const watched = state({ aura: { observedMs: 300 * 60_000, weightedSum: 900, lastSampleAt: T, lastPct: 30, changes: [1, 2] } });
  const glanced = state({ aura: { observedMs: 5 * 60_000, weightedSum: 10, lastSampleAt: T + 1, lastPct: 40, changes: [] } });
  const merged = mergeBossStates(glanced, watched);
  eq("the copy that observed more of the event wins", merged.aura.observedMs, 300 * 60_000);
  eq("and it is taken whole, not added", merged.aura.weightedSum, 900);
  eq("its change log comes with it", merged.aura.changes.length, 2);
}

// --- 5. a field missing from the newer copy survives from the older ----------
{
  const partial = state({ updatedAt: T + 100 });
  delete partial.bossName;
  eq("a partial response does not blank a known value",
    mergeBossStates(partial, state({ bossName: "The Beast" })).bossName, "The Beast");
}

// --- 6. nothing on the other side is not a merge -----------------------------
{
  eq("no stored copy returns this tab's state unchanged", mergeBossStates(state(), null).eventHigh, 40);
}

// --- 7. roster: per handle, the newer sighting wins --------------------------
{
  const mine = { entries: { alice: { handle: "alice", XP: 100, profileAt: T + 10 } }, xpWraps: 3 };
  const theirs = {
    entries: {
      alice: { handle: "alice", XP: 90, profileAt: T },
      bob: { handle: "bob", XP: 50, profileAt: T },
    },
    xpWraps: 7,
  };
  const merged = mergeRosters(mine, theirs);
  eq("the newer XP reading wins", merged.entries.alice.XP, 100);
  eq("a handle only the other tab knows is kept", merged.entries.bob.XP, 50);
  eq("wrap count takes the larger, so priming cannot restart", merged.xpWraps, 7);
}

{
  const mine = { entries: { alice: { XP: 100, profileAt: T } }, self: { percentile: 1, percentileAt: T } };
  const theirs = { entries: { alice: { XP: 120, profileAt: T + 5 } }, self: { percentile: 0.1, percentileAt: T + 5 } };
  const merged = mergeRosters(mine, theirs);
  eq("a newer sighting from the other tab wins", merged.entries.alice.XP, 120);
  eq("the viewer's percentile follows its own timestamp", merged.self.percentile, 0.1);
}

// --- 8. observation series are combined, never replaced ---------------------
{
  const now = T;
  const mine = [[now - 3 * 60_000, 100], [now - 60_000, 140]];
  const theirs = [[now - 2 * 60_000, 120]];
  const merged = mergeObservedSeries(mine, theirs, now);
  eq("both tabs' points are kept", merged.length, 3);
  eq("in time order", merged[1][1], 120);
  eq("exact duplicates collapse", mergeObservedSeries(mine, mine, now).length, 2);
}

{
  const now = T;
  const mine = { updatedAt: now, profile: { XP: 10 }, xpSnapshots: [[now - 60_000, 10]], karmaSnapshots: [] };
  const theirs = { updatedAt: now - 60_000, profile: { XP: 9 }, xpSnapshots: [[now - 120_000, 9]], karmaSnapshots: [] };
  const merged = mergePersonalRecords(mine, theirs, now);
  eq("the newer profile block wins whole", merged.profile.XP, 10);
  eq("while the measured window keeps both tabs' points", merged.xpSnapshots.length, 2);
}

if (failures) {
  console.error(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`\nok — ${checks} cross-tab merge checks passed`);
