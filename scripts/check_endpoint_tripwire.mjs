#!/usr/bin/env node
// Unit checks for the endpoint-failure tripwire in utils.js, exercised against
// the REAL shipped file evaluated in a vm sandbox with console.warn captured.
//
// Run from anywhere:  node scripts/check_endpoint_tripwire.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: reportUsableFields catches a renamed FIELD, but an endpoint
// that stops answering produced no signal at all — content.js drops every
// non-2xx before routing. /v1/leaderboard_xp/alltime went from 200 to 400 on
// 2026-08-14 and the All-Time panel kept redrawing a days-old cache, with the
// wrong totals and the wrong order, for days without one console line.
//
// The tripwire has to stay quiet for the failures that are NORMAL: the 401s
// AUTH_REQUIRED_PATHS legitimately queues and retries, and the 404 that simply
// means "no such user" when someone mistypes a handle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const UTILS = new URL("../bootdev-extension/src/utils.js", import.meta.url);

// --- evaluate utils.js with console.warn captured ----------------------------

const warnings = [];
const sandbox = {
  window: {},
  document: {},
  chrome: {},
  console: { ...console, warn: (msg) => warnings.push(String(msg)) },
  setTimeout: () => 0,
  clearTimeout() {},
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(UTILS, "utf8"), sandbox, { filename: fileURLToPath(UTILS) });

const { reportEndpointFailure, noteEndpointSuccess, normalizeEndpointKey } = sandbox;
if (!reportEndpointFailure || !noteEndpointSuccess || !normalizeEndpointKey) {
  console.error("FAIL: utils.js did not define the endpoint tripwire helpers");
  process.exit(1);
}

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
// warnOnce dedupes per key for the life of the module, so each scenario uses a
// distinct path — exactly how it behaves in a real page session.
function warningsFor(path) {
  return warnings.filter((w) => w.includes(path));
}

// --- path normalization ------------------------------------------------------

check("static path is unchanged", normalizeEndpointKey("/v1/leaderboard_xp/alltime"), "/v1/leaderboard_xp/alltime");
check("handle is collapsed", normalizeEndpointKey("/v1/users/public/katcodes"), "/v1/users/public/{handle}");
check("handle is collapsed with a suffix", normalizeEndpointKey("/v1/users/public/katcodes/stats"), "/v1/users/public/{handle}/stats");
check("heatmap suffix is kept", normalizeEndpointKey("/v1/users/public/kat/activity_heatmap"), "/v1/users/public/{handle}/activity_heatmap");
check("lesson uuid is collapsed", normalizeEndpointKey("/v1/users/lessons/abc-123"), "/v1/users/lessons/{uuid}");
check("course progress uuid is collapsed", normalizeEndpointKey("/v1/course_progress_by_lesson/abc-123"), "/v1/course_progress_by_lesson/{uuid}");

// --- the threshold -----------------------------------------------------------

const ALLTIME = "/v1/leaderboard_xp/alltime";
reportEndpointFailure(ALLTIME, 400);
check("one failure is not enough to warn", warningsFor(ALLTIME).length, 0);
reportEndpointFailure(ALLTIME, 400);
check("the second consecutive failure warns", warningsFor(ALLTIME).length, 1);
reportEndpointFailure(ALLTIME, 400);
reportEndpointFailure(ALLTIME, 400);
check("further failures stay silent", warningsFor(ALLTIME).length, 1);
check("the warning names the path", warningsFor(ALLTIME)[0].includes(ALLTIME), true);
check("the warning carries the status", warningsFor(ALLTIME)[0].includes("400"), true);

// --- a success clears the history --------------------------------------------

const FLAKY = "/v1/leaderboard_karma/alltime";
reportEndpointFailure(FLAKY, 500);
noteEndpointSuccess(FLAKY);
reportEndpointFailure(FLAKY, 500);
check("a 2xx between failures resets the counter", warningsFor(FLAKY).length, 0);
reportEndpointFailure(FLAKY, 500);
check("two consecutive failures after the reset warn", warningsFor(FLAKY).length, 1);

// --- statuses that must never count ------------------------------------------

const DASH = "/v1/dashboard_content";
for (const status of [401, 401, 401, 403, 403, 403]) reportEndpointFailure(DASH, status);
check("401/403 never count (queued and retried elsewhere)", warningsFor(DASH).length, 0);
for (const status of [0, 0, 302, 302]) reportEndpointFailure(DASH, status);
check("status 0 and 3xx never count", warningsFor(DASH).length, 0);
reportEndpointFailure(DASH, 404);
reportEndpointFailure(DASH, 404);
check("a 404 on a real endpoint does warn", warningsFor(DASH).length, 1);

// --- "no such user" is a normal answer ---------------------------------------

reportEndpointFailure("/v1/users/public/typo1", 404);
reportEndpointFailure("/v1/users/public/typo2", 404);
reportEndpointFailure("/v1/users/public/typo3", 404);
reportEndpointFailure("/v1/users/public/typo4/stats", 404);
check("a mistyped handle never warns", warningsFor("/v1/users/public/{handle}").length, 0);

// --- tracked handles aggregate into one signal -------------------------------

reportEndpointFailure("/v1/users/public/kat/stats", 500);
reportEndpointFailure("/v1/users/public/dave/stats", 500);
check(
  "different handles hitting one broken endpoint aggregate",
  warningsFor("/v1/users/public/{handle}/stats").length,
  1
);

// --- report ------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed`);
