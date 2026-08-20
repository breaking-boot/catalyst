#!/usr/bin/env node
// Unit checks for the observed-total snapshot series in leaderboard.js,
// exercised against the REAL shipped code in a vm sandbox.
//
// Run from anywhere:  node scripts/check_snapshot_series.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: the series stores running totals ([timestamp, total] pairs)
// and every "daily" figure Catalyst reports for a tracked user — and for the
// viewer — is the delta between its oldest and newest point inside a 24-hour
// window. That makes a single bad point catastrophic rather than cosmetic.
//
// The bug this pins (measured 2026-08-20, present since v0.14.1): `num(null)`
// returns 0, so a caller that legitimately found nothing wrote a real zero.
// `myValueFromEntries` returns null when the viewer is not on a board, and
// being absent from the top-25 karma board means "below 25th", not "zero
// karma". That fabricated 0 anchored the window, and the next genuine reading
// was reported as a same-day gain of the viewer's ENTIRE lifetime karma — the
// Daily Karma column compared everyone against an all-time total.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);

const sandbox = {
  window: {},
  document: {
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  },
  location: { origin: "https://www.boot.dev", pathname: "/leaderboard" },
  console,
  URL,
  chrome: {
    runtime: { getURL: (p) => `chrome-extension://catalyst-test/${p}` },
    storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() } },
  },
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

const { updateSnapshotSeries, measuredDailyKarma, dropFabricatedZeros, num } = sandbox;
for (const [name, fn] of Object.entries({ updateSnapshotSeries, measuredDailyKarma, dropFabricatedZeros })) {
  if (typeof fn !== "function") {
    console.error(`FAIL: leaderboard.js did not define ${name}`);
    process.exit(1);
  }
}

// --- tiny assert -------------------------------------------------------------

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures += 1;
  console.error(`FAIL: ${label}\n  expected ${e}\n  got      ${a}`);
}

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

// --- 1. the trap itself ------------------------------------------------------

check("num(null) is still 0 — the trap this guard exists for", num(null), 0);
check("num(undefined) is null", num(undefined), null);

// --- 2. a nullish observation must write nothing ------------------------------

check("null observation writes nothing", updateSnapshotSeries([], null, NOW), null);
check("undefined observation writes nothing", updateSnapshotSeries([], undefined, NOW), null);
check("non-numeric observation writes nothing", updateSnapshotSeries([], "nope", NOW), null);
check("negative total writes nothing", updateSnapshotSeries([], -5, NOW), null);

// A REAL zero is still a legitimate observation — a brand-new account genuinely
// has 0 karma, and that must stay measurable.
check("an explicit numeric 0 is still recorded", updateSnapshotSeries([], 0, NOW), [[NOW, 0]]);
check("an explicit '0' string is still recorded", updateSnapshotSeries([], "0", NOW), [[NOW, 0]]);

// --- 3. the end-to-end failure, as it actually presented ----------------------

{
  // Karma board arrives, viewer is not in the top 25 -> myValueFromEntries
  // returns null -> this is what used to be recorded.
  const poisoned = updateSnapshotSeries([], null, NOW - 6 * HOUR);
  check("the poisoning write no longer happens at all", poisoned, null);

  // Simulate a series that WAS poisoned by an older build, then receives a
  // genuine reading. Without the repair, the delta is the whole lifetime total.
  const legacy = [[NOW - 6 * HOUR, 0], [NOW, 125540]];
  const beforeRepair = measuredDailyKarma({ karmaSnapshots: legacy });
  check("a legacy fabricated zero would report the lifetime total", beforeRepair.delta, 125540);

  const repaired = dropFabricatedZeros(legacy);
  check("repair drops the fabricated zero", repaired, [[NOW, 125540]]);
  check(
    "repaired series reports no measurement rather than a wrong one",
    measuredDailyKarma({ karmaSnapshots: repaired }),
    null
  );
}

// --- 4. the repair must not eat legitimate data -------------------------------

{
  // A genuinely zero-karma user: every point is 0, nothing is dropped, and the
  // honest "0 karma today" measurement survives.
  const allZero = [[NOW - 2 * HOUR, 0], [NOW, 0]];
  check("an all-zero series is left intact", dropFabricatedZeros(allZero), allZero);
  check("and still measures as a confident zero", measuredDailyKarma({ karmaSnapshots: allZero }).delta, 0);

  const normal = [[NOW - 2 * HOUR, 100], [NOW, 140]];
  check("a series with no zeros is untouched", dropFabricatedZeros(normal), normal);
  check("and measures the real gain", measuredDailyKarma({ karmaSnapshots: normal }).delta, 40);

  check("repair tolerates junk", dropFabricatedZeros(null), []);
  check("repair tolerates malformed points", dropFabricatedZeros([null, [NOW, 5]]), [[NOW, 5]]);
}

// --- 5. existing series behaviour still holds ---------------------------------

{
  const grown = updateSnapshotSeries([[NOW - 2 * HOUR, 100]], 140, NOW);
  check("a growing total appends", grown, [[NOW - 2 * HOUR, 100], [NOW, 140]]);

  // Totals never decrease: a contradicting earlier point is dropped rather than
  // kept to produce a negative delta.
  const contradicted = updateSnapshotSeries([[NOW - 2 * HOUR, 500]], 100, NOW);
  check("a contradicting earlier point is dropped", contradicted, [[NOW, 100]]);

  // Run-length dedupe: a flat stretch keeps only its first and latest point.
  const flat = updateSnapshotSeries([[NOW - 3 * HOUR, 7], [NOW - 2 * HOUR, 7]], 7, NOW);
  check("a flat run is deduped, not appended", flat, [[NOW - 3 * HOUR, 7], [NOW, 7]]);

  // Points older than the retention window are pruned on write.
  const stale = updateSnapshotSeries([[NOW - 40 * HOUR, 1]], 9, NOW);
  check("a point past the window is pruned", stale, [[NOW, 9]]);
}

// --- report ------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed`);
