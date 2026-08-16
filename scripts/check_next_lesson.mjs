#!/usr/bin/env node
// Unit checks for the Next Lesson resolver's dual-cased reads of
// /v1/dashboard_content, exercised against the REAL shipped code:
// bootdev-extension/src/utils.js and src/nextLesson.js are evaluated in a vm
// sandbox and the helpers are pulled off the __BOOTDEV_ENHANCER_TEST__ hook
// (inert in production because that global never exists on the real page).
//
// Run from anywhere:  node scripts/check_next_lesson.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Why this exists: /v1/dashboard_content was PascalCase when nextLesson.js was
// written and is entirely camelCase in the 2026-08-15 capture, so all three
// resolver tiers returned undefined. The failure was invisible — a stored href
// has no expiry and captureNextLessonFromDom() kept writing a fresh one from
// the page's own Next link, which is why the link merely lagged a navigation
// behind instead of disappearing. Boot.dev migrates per DTO and has been seen
// flipping in both directions, so both casings are pinned here, mixed included.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);
const CAPTURE = new URL(
  "../reference_data/http_responses_from_api_endpoints/dashboard_content_2026-08-15.json",
  import.meta.url
);

// --- evaluate utils.js + nextLesson.js in a sandbox --------------------------

const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: { addEventListener() {}, removeEventListener() {}, getElementById: () => null },
  location: { origin: "https://www.boot.dev", pathname: "/dashboard" },
  console,
  // vm contexts get the ECMAScript built-ins only; normalizeLessonHref needs URL.
  URL,
  chrome: { runtime: { getURL: (p) => `chrome-extension://catalyst-test/${p}` } },
  setTimeout: () => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
};
vm.createContext(sandbox);
// The real utils.js supplies pickField (and warnOnce, isPlainObject, …); it
// touches chrome.* only inside function bodies, so it loads cleanly here.
for (const file of ["utils.js", "nextLesson.js"]) {
  const url = new URL(file, SRC);
  vm.runInContext(readFileSync(url, "utf8"), sandbox, { filename: fileURLToPath(url) });
}

const hooks = testHook.nextLesson;
if (!hooks) {
  console.error("FAIL: nextLesson.js did not expose test hooks");
  process.exit(1);
}
const { getDashboardLessonHref, findFirstIncompleteLesson } = hooks;

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

const UUID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const UUID_C = "cccccccc-3333-4333-8333-cccccccccccc";

// --- explicit current-lesson field, both casings -----------------------------

check("camelCase currentLessonUUID", getDashboardLessonHref({ currentLessonUUID: UUID_A }), `/lessons/${UUID_A}`);
check("PascalCase CurrentLessonUUID", getDashboardLessonHref({ CurrentLessonUUID: UUID_A }), `/lessons/${UUID_A}`);
check("wrapped in data", getDashboardLessonHref({ data: { currentLessonUUID: UUID_A } }), `/lessons/${UUID_A}`);
check(
  "PascalCase wins when both are present",
  getDashboardLessonHref({ CurrentLessonUUID: UUID_A, currentLessonUUID: UUID_B }),
  `/lessons/${UUID_A}`
);

// --- course-progress fallback, both casings and mixed ------------------------

const camelProgress = {
  currentCourseProgress: {
    chapters: [
      { lessons: [{ uuid: UUID_A, isRequired: true, isComplete: true, isReset: false }] },
      {
        lessons: [
          { uuid: UUID_B, isRequired: true, isComplete: false, isReset: true },
          { uuid: UUID_C, isRequired: true, isComplete: false, isReset: false },
        ],
      },
    ],
  },
};
const pascalProgress = {
  CurrentCourseProgress: {
    Chapters: [
      { Lessons: [{ UUID: UUID_A, IsRequired: true, IsComplete: true, IsReset: false }] },
      {
        Lessons: [
          { UUID: UUID_B, IsRequired: true, IsComplete: false, IsReset: true },
          { UUID: UUID_C, IsRequired: true, IsComplete: false, IsReset: false },
        ],
      },
    ],
  },
};
// The shape that slips past a whole-object casing gate: camel container, Pascal
// contents. No such response has been captured; the read is per field so that
// one cannot freeze the feature the way the v0.12.2 boss gate could have.
const mixedProgress = {
  currentCourseProgress: {
    Chapters: [
      { lessons: [{ UUID: UUID_A, isRequired: true, IsComplete: true }] },
      { lessons: [{ UUID: UUID_C, IsRequired: true, isComplete: false }] },
    ],
  },
};

check("camelCase progress fallback", getDashboardLessonHref(camelProgress), `/lessons/${UUID_C}`);
check("PascalCase progress fallback", getDashboardLessonHref(pascalProgress), `/lessons/${UUID_C}`);
check("mixed-casing progress fallback", getDashboardLessonHref(mixedProgress), `/lessons/${UUID_C}`);
check("currentCourse fallback", getDashboardLessonHref({
  currentCourse: { chapters: [{ lessons: [{ uuid: UUID_C, isComplete: false }] }] },
}), `/lessons/${UUID_C}`);

// --- lesson selection rules --------------------------------------------------

const pick = (lesson) => findFirstIncompleteLesson({ chapters: [{ lessons: [lesson] }] });
check("complete lesson is skipped", pick({ uuid: UUID_A, isComplete: true }), null);
check("reset lesson is skipped", pick({ uuid: UUID_A, isComplete: false, isReset: true }), null);
check("optional lesson is skipped", pick({ uuid: UUID_A, isComplete: false, isRequired: false }), null);
// Strictness matters: an absent isComplete must read as "unknown", never as
// "incomplete", or a future rename sends the user back to lesson 1.
check("absent isComplete is not treated as incomplete", pick({ uuid: UUID_A }), null);
check("incomplete required lesson is taken", pick({ uuid: UUID_A, isComplete: false })?.uuid, UUID_A);

// --- fail open ---------------------------------------------------------------

check("empty object", getDashboardLessonHref({}), null);
check("null", getDashboardLessonHref(null), null);
check("error body", getDashboardLessonHref({ error: "Invalid timeframe" }), null);
check("chapters not an array", getDashboardLessonHref({ currentCourseProgress: { chapters: "nope" } }), null);
check("non-lesson uuid", getDashboardLessonHref({ currentLessonUUID: "not-a-uuid" }), null);
check("off-site href is rejected", getDashboardLessonHref({ currentLessonUUID: "https://evil.example/lessons/x" }), null);

// --- real capture ------------------------------------------------------------

let fixturesRun = 0;
if (existsSync(CAPTURE)) {
  const body = JSON.parse(readFileSync(CAPTURE, "utf8"));
  fixturesRun += 1;

  check(
    "2026-08-15 capture resolves its currentLessonUUID",
    getDashboardLessonHref(body),
    `/lessons/${body.currentLessonUUID}`
  );

  // Independent scan of the same capture, so the fallback tier is measured
  // against the file rather than against the implementation under test.
  const expected = (() => {
    for (const chapter of body.currentCourseProgress.chapters) {
      for (const lesson of chapter.lessons) {
        if (lesson.isRequired !== false && lesson.isComplete === false && lesson.isReset !== true) {
          return lesson.uuid;
        }
      }
    }
    return null;
  })();
  const withoutExplicit = { ...body };
  delete withoutExplicit.currentLessonUUID;
  check(
    "capture without currentLessonUUID falls back to its first incomplete lesson",
    getDashboardLessonHref(withoutExplicit),
    expected ? `/lessons/${expected}` : null
  );
  fixturesRun += 1;
} else {
  console.log("note: dashboard_content capture not present; skipped fixture checks");
}

// --- report ------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed${fixturesRun ? ` (incl. ${fixturesRun} capture fixtures)` : ""}`);
