#!/usr/bin/env node
// Unit checks for the v0.11.0 lesson features' pure helpers, exercised against
// the REAL shipped code: bootdev-extension/src/cliShortcuts.js and
// src/submitConfirm.js are evaluated in a vm sandbox with a stubbed window, and
// the helpers are pulled off the __BOOTDEV_ENHANCER_TEST__ hook (which is inert
// in production because that global never exists on the real page).
//
// Run from anywhere:  node scripts/check_lesson_features.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// The command-classification checks run against the real DOM captures in
// reference_data/catalyst_versions/v0.11.0_*/ui/html/, so the safe
// submit-only guarantee (no run command to copy) is verified against evidence
// rather than a hand-written string.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);
const CAPTURES = new URL(
  "../reference_data/catalyst_versions/v0.11.0_submit_confirmation_and_cli_shortcuts/ui/html/",
  import.meta.url
);

// --- evaluate the feature files in a sandbox --------------------------------

const testHook = {};
const sandbox = {
  window: { __BOOTDEV_ENHANCER_TEST__: testHook },
  document: { addEventListener() {}, removeEventListener() {} },
  navigator: {},
  location: { pathname: "/" },
  console,
};
// normalizeText lives in utils.js; both feature files use it. Loading utils.js
// whole would drag in chrome.* globals, so provide just that helper.
vm.createContext(sandbox);
vm.runInContext(
  'function normalizeText(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }',
  sandbox
);

for (const file of ["submitConfirm.js", "cliShortcuts.js"]) {
  const url = new URL(file, SRC);
  vm.runInContext(readFileSync(url, "utf8"), sandbox, { filename: fileURLToPath(url) });
}

const cli = testHook.cliShortcuts;
const confirmHooks = testHook.submitConfirm;
if (!cli || !confirmHooks) {
  console.error("FAIL: feature files did not expose test hooks");
  process.exit(1);
}
const { matchCliShortcut, classifyBootdevCommand } = cli;
const { isPointerActivation, isSubmitButtonLabel } = confirmHooks;

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

// --- classifyBootdevCommand: shape, UUID binding, unknown flags -------------

const UUID = "766d7ba0-39ed-44e1-993d-c0239b4534db";
const OTHER = "7a92d1c1-d202-481a-ae5f-14fc9f97b640";

check("flagless command -> run", classifyBootdevCommand(`bootdev run ${UUID}`, UUID), "run");
check("-s command -> submit", classifyBootdevCommand(`bootdev run ${UUID} -s`, UUID), "submit");
check(
  "surrounding whitespace and newlines are tolerated",
  classifyBootdevCommand(`\n  bootdev  run   ${UUID}   -s \n`, UUID),
  "submit"
);
check("uppercase UUID in the text still matches", classifyBootdevCommand(`bootdev run ${UUID.toUpperCase()}`, UUID), "run");
check("a different lesson's command is never claimed", classifyBootdevCommand(`bootdev run ${OTHER} -s`, UUID), null);
check("unknown flags classify as nothing", classifyBootdevCommand(`bootdev run ${UUID} --verbose`, UUID), null);
check("-s among other flags still submits", classifyBootdevCommand(`bootdev run ${UUID} -s --verbose`, UUID), "submit");
check("a different verb is not a run command", classifyBootdevCommand(`bootdev test ${UUID}`, UUID), null);
check("prose mentioning the command is not a command", classifyBootdevCommand(`Now run bootdev run ${UUID}`, UUID), null);
check("empty text -> null", classifyBootdevCommand("", UUID), null);
check("null text -> null", classifyBootdevCommand(null, UUID), null);
check("missing uuid -> null (never copy an unvalidated command)", classifyBootdevCommand(`bootdev run ${UUID}`, null), null);

// --- matchCliShortcut: Alt+C runs, Alt+Shift+C submits ----------------------

const keyEvent = (over = {}) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code: "KeyC",
  key: "c",
  ...over,
});

check("Alt+C -> run", matchCliShortcut(keyEvent()), "run");
check("Alt+Shift+C -> submit", matchCliShortcut(keyEvent({ shiftKey: true, key: "C" })), "submit");
// Holding the keys must copy once, not once per auto-repeat.
check("held Alt+C (auto-repeat) -> null", matchCliShortcut(keyEvent({ repeat: true })), null);
check(
  "held Alt+Shift+C (auto-repeat) -> null",
  matchCliShortcut(keyEvent({ shiftKey: true, key: "C", repeat: true })),
  null
);
check("a fresh press after a repeat run still copies", matchCliShortcut(keyEvent({ repeat: false })), "run");
check("macOS Alt+C (key is ç) still matches via event.code", matchCliShortcut(keyEvent({ key: "ç" })), "run");
check(
  "macOS Alt+Shift+C (key is Ç) still matches via event.code",
  matchCliShortcut(keyEvent({ shiftKey: true, key: "Ç" })),
  "submit"
);
check("event.key fallback when code is absent", matchCliShortcut(keyEvent({ code: "" })), "run");
check("Ctrl+Alt+C -> null", matchCliShortcut(keyEvent({ ctrlKey: true })), null);
check("Cmd+Alt+C -> null", matchCliShortcut(keyEvent({ metaKey: true })), null);
check("plain C -> null", matchCliShortcut(keyEvent({ altKey: false })), null);
check("Ctrl+C (ordinary copy) -> null", matchCliShortcut(keyEvent({ altKey: false, ctrlKey: true })), null);
check("Alt+N (Next Lesson) is never swallowed", matchCliShortcut(keyEvent({ code: "KeyN", key: "n" })), null);
check("Alt+Enter (format code) -> null", matchCliShortcut(keyEvent({ code: "Enter", key: "Enter" })), null);
check("missing event -> null", matchCliShortcut(null), null);

// --- isPointerActivation: the whole submit-guard boundary -------------------

check("mouse click -> guarded", isPointerActivation({ isTrusted: true, detail: 1 }), true);
check("double-click second event -> guarded", isPointerActivation({ isTrusted: true, detail: 2 }), true);
check("keyboard activation (detail 0) -> not guarded", isPointerActivation({ isTrusted: true, detail: 0 }), false);
check(
  "programmatic .click() -> not guarded (this is what prevents recursion)",
  isPointerActivation({ isTrusted: false, detail: 1 }),
  false
);
check("untrusted keyboard-shaped event -> not guarded", isPointerActivation({ isTrusted: false, detail: 0 }), false);
check("missing fields -> not guarded", isPointerActivation({}), false);
check("missing event -> not guarded", isPointerActivation(null), false);

// --- isSubmitButtonLabel: Submit only, never Run/Solution -------------------

check('"Submit" -> true', isSubmitButtonLabel("Submit"), true);
check('" submit " (whitespace, case) -> true', isSubmitButtonLabel(" submit "), true);
check('"Run" -> false', isSubmitButtonLabel("Run"), false);
check('"Solution" -> false', isSubmitButtonLabel("Solution"), false);
check('"Submit Code" (the tooltip text) -> false', isSubmitButtonLabel("Submit Code"), false);
check('"Resubmit" -> false', isSubmitButtonLabel("Resubmit"), false);
check("empty -> false", isSubmitButtonLabel(""), false);

// --- real capture fixtures --------------------------------------------------
// Pull the displayed <p> text out of the captured containers and classify it,
// so the run/submit/neither distinction is proven against real markup.

function commandKindsFromCapture(name, uuid) {
  const html = readFileSync(new URL(name, CAPTURES), "utf8");
  const kinds = { run: 0, submit: 0 };
  for (const [, inner] of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = inner.replace(/<[^>]*>/g, " ");
    const kind = classifyBootdevCommand(text, uuid);
    if (kind) kinds[kind] += 1;
  }
  return kinds;
}

const FIXTURES = [
  ["course_cli_command_container.html", "766d7ba0-39ed-44e1-993d-c0239b4534db", { run: 1, submit: 1 }],
  ["project_cli_command_container.html", "d6350dd3-7ec9-425b-b10c-892b8f2a9b7a", { run: 1, submit: 1 }],
  // The safe-submission guarantee: submit is displayed, run is not, so the run
  // shortcut has nothing to copy and must not fabricate one.
  ["safe_submit_only_cli_command_container.html", "7a92d1c1-d202-481a-ae5f-14fc9f97b640", { run: 0, submit: 1 }],
  ["quiz_lesson_answer_panel.html", UUID, { run: 0, submit: 0 }],
  ["interview_lesson_answer_panel.html", UUID, { run: 0, submit: 0 }],
  ["code_lesson_run_submit_container.html", UUID, { run: 0, submit: 0 }],
];

let fixturesRun = 0;
for (const [name, uuid, expected] of FIXTURES) {
  if (!existsSync(new URL(name, CAPTURES))) continue;
  fixturesRun += 1;
  check(`${name} command kinds`, commandKindsFromCapture(name, uuid), expected);
  check(
    `${name} yields nothing for a different lesson's UUID`,
    commandKindsFromCapture(name, "00000000-0000-0000-0000-000000000000"),
    { run: 0, submit: 0 }
  );
}
if (!fixturesRun) {
  console.log("note: v0.11.0 UI captures not present; skipped fixture checks");
}

// -----------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures}/${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed${fixturesRun ? ` (incl. ${fixturesRun} capture fixtures)` : ""}`);
