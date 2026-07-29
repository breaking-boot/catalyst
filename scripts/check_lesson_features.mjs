#!/usr/bin/env node
// Unit checks for the lesson features' pure helpers (v0.11.0 submit
// confirmation + CLI shortcuts, v0.12.0 assignment shortcuts), exercised
// against the REAL shipped code: the feature files are evaluated in a vm
// sandbox with a stubbed window, and the helpers are pulled off the
// __BOOTDEV_ENHANCER_TEST__ hook (which is inert in production because that
// global never exists on the real page).
//
// Run from anywhere:  node scripts/check_lesson_features.mjs
// Exits non-zero on any failure (same spirit as the node --check gate).
//
// Both fixture blocks run against the real DOM captures in
// reference_data/catalyst_versions/, so the safe submit-only guarantee (no run
// command to copy) and the checklist targeting rules are verified against
// evidence rather than hand-written strings.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = new URL("../bootdev-extension/src/", import.meta.url);
const CAPTURES = new URL(
  "../reference_data/catalyst_versions/v0.11.0_submit_confirmation_and_cli_shortcuts/ui/html/",
  import.meta.url
);
const CAPTURES_V12 = new URL(
  "../reference_data/catalyst_versions/v0.12.0_assignment_checkbox_shortcuts/ui/html/",
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

for (const file of ["submitConfirm.js", "cliShortcuts.js", "assignmentShortcuts.js"]) {
  const url = new URL(file, SRC);
  vm.runInContext(readFileSync(url, "utf8"), sandbox, { filename: fileURLToPath(url) });
}

const cli = testHook.cliShortcuts;
const confirmHooks = testHook.submitConfirm;
const assignment = testHook.assignmentShortcuts;
if (!cli || !confirmHooks || !assignment) {
  console.error("FAIL: feature files did not expose test hooks");
  process.exit(1);
}
const { matchCliShortcut, classifyBootdevCommand } = cli;
const { isPointerActivation, isSubmitButtonLabel } = confirmHooks;
const { matchAssignmentShortcut, selectNumberedTarget, selectNextUncheckedTarget } = assignment;

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

// --- matchAssignmentShortcut: Alt+digit, and everything it must not claim ----

const digitEvent = (over = {}) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code: "Digit1",
  key: "1",
  ...over,
});

check("Alt+1 -> step 1", matchAssignmentShortcut(digitEvent()), { kind: "number", digit: 1 });
check(
  "Alt+9 -> step 9",
  matchAssignmentShortcut(digitEvent({ code: "Digit9", key: "9" })),
  { kind: "number", digit: 9 }
);
check("Alt+0 -> next unchecked", matchAssignmentShortcut(digitEvent({ code: "Digit0", key: "0" })), { kind: "next" });
// Matched by position: Backquote is the key left of 1 whatever is printed on it.
check("Alt+` -> answer side", matchAssignmentShortcut(digitEvent({ code: "Backquote", key: "`" })), { kind: "answer" });
check(
  "Alt+` on a layout where that key prints something else",
  matchAssignmentShortcut(digitEvent({ code: "Backquote", key: "²" })),
  { kind: "answer" }
);
check(
  "` key fallback when code is absent",
  matchAssignmentShortcut(digitEvent({ code: "", key: "`" })),
  { kind: "answer" }
);
check("Alt+Shift+` (tilde) -> null", matchAssignmentShortcut(digitEvent({ code: "Backquote", key: "~", shiftKey: true })), null);
check("held Alt+` (auto-repeat) -> null", matchAssignmentShortcut(digitEvent({ code: "Backquote", key: "`", repeat: true })), null);
check(
  "macOS Alt+3 (key is £) still matches via event.code",
  matchAssignmentShortcut(digitEvent({ code: "Digit3", key: "£" })),
  { kind: "number", digit: 3 }
);
check(
  "event.key fallback when code is absent",
  matchAssignmentShortcut(digitEvent({ code: "", key: "4" })),
  { kind: "number", digit: 4 }
);
// Windows Alt+numpad is the OS character-code input method (Alt+0233 -> é).
// Numpad presses always carry a Numpad* code, so the key fallback can't let
// them through either.
check("Alt+Numpad1 -> null", matchAssignmentShortcut(digitEvent({ code: "Numpad1" })), null);
check("held Alt+1 (auto-repeat) -> null", matchAssignmentShortcut(digitEvent({ repeat: true })), null);
// AltGr reports ctrl+alt, so international character entry is never a shortcut.
check("AltGr+1 (ctrl+alt) -> null", matchAssignmentShortcut(digitEvent({ ctrlKey: true })), null);
check("Alt+Shift+1 -> null", matchAssignmentShortcut(digitEvent({ shiftKey: true, key: "!" })), null);
check("Cmd+Alt+1 -> null", matchAssignmentShortcut(digitEvent({ metaKey: true })), null);
check("plain 1 -> null", matchAssignmentShortcut(digitEvent({ altKey: false })), null);
check("Alt+C is never swallowed", matchAssignmentShortcut(digitEvent({ code: "KeyC", key: "c" })), null);
check("Alt+N is never swallowed", matchAssignmentShortcut(digitEvent({ code: "KeyN", key: "n" })), null);
check("missing event -> null", matchAssignmentShortcut(null), null);

// --- target selection over hand-built records -------------------------------

const rec = (over = {}) => ({ input: "x", topLevel: true, number: null, checked: false, usable: true, ...over });

check(
  "duplicate top-level numbers -> the first in document order",
  selectNumberedTarget(
    [rec({ input: "first", number: 1 }), rec({ input: "second", number: 1 })],
    1
  )?.input,
  "first"
);
check(
  "a nested item is never selected by number",
  selectNumberedTarget([rec({ input: "nested", number: 1, topLevel: false })], 1),
  null
);
check(
  "an unusable top-level checkbox yields nothing (never a nested fallback)",
  selectNumberedTarget(
    [rec({ input: "hidden", number: 1, usable: false }), rec({ input: "child", number: 1, topLevel: false })],
    1
  ),
  null
);
check("no step with that number -> null", selectNumberedTarget([rec({ number: 1 })], 7), null);
check("empty records -> null", selectNumberedTarget([], 1), null);
check("non-array -> null", selectNumberedTarget(null, 1), null);

check(
  "Alt+0 skips checked boxes",
  selectNextUncheckedTarget([rec({ input: "done", checked: true }), rec({ input: "todo" })])?.input,
  "todo"
);
check(
  "Alt+0 skips unusable boxes",
  selectNextUncheckedTarget([rec({ input: "hidden", usable: false }), rec({ input: "todo" })])?.input,
  "todo"
);
check(
  "Alt+0 reaches nested boxes too",
  selectNextUncheckedTarget([rec({ input: "nested", topLevel: false })])?.input,
  "nested"
);
check("Alt+0 with everything checked -> null", selectNextUncheckedTarget([rec({ checked: true })]), null);
check("Alt+0 on an empty checklist -> null", selectNextUncheckedTarget([]), null);

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

// --- v0.12.0 checklist fixtures ---------------------------------------------
// Rebuild the checklist records from a capture: one entry per checkbox in
// document order, applying the same rules as the DOM adapter — a checkbox
// counts only inside an <li>, it is top-level when its nearest <li> has no <li>
// ancestor, and its displayed number comes from that item's own <ol>.
//
// This re-derives structure from HTML instead of exercising
// collectChecklistCheckboxes directly (the repo has no DOM implementation and
// no dependencies), so what it proves is that the selection rules land on the
// right controls in real markup. The ids are exact oracles: in every capture
// they run checkbox-0..N in document order.
function checklistRecordsFromCapture(name) {
  const html = readFileSync(new URL(name, CAPTURES_V12), "utf8");
  const records = [];
  const lists = []; // open <ol>/<ul>, innermost last
  const items = []; // open <li>, innermost last

  for (const [, closing, rawTag, attrs] of html.matchAll(/<(\/?)(ol|ul|li|input)\b([^>]*)>/gi)) {
    const tag = rawTag.toLowerCase();

    if (tag === "input") {
      if (!/type\s*=\s*"checkbox"/i.test(attrs)) continue;
      // A checkbox outside any list item is not a checklist step.
      if (!items.length) continue;
      const topLevel = items.length === 1;
      records.push({
        input: /id\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ?? null,
        topLevel,
        number: topLevel ? items[0].number : null,
        checked: false,
        usable: true,
      });
      continue;
    }

    if (tag === "li") {
      if (closing) items.pop();
      else {
        const list = lists[lists.length - 1];
        items.push({ number: list?.ordered ? ++list.n : null });
      }
      continue;
    }

    if (closing) lists.pop();
    else lists.push({ ordered: tag === "ol", n: 0 });
  }
  return records;
}

// Repeated Alt+0 from an all-unchecked start, in visit order.
function altZeroWalk(records) {
  const state = records.map((r) => ({ ...r }));
  const visited = [];
  for (let target; (target = selectNextUncheckedTarget(state)); ) {
    target.checked = true;
    visited.push(target.input);
  }
  return visited;
}

const N = null;
const CHECKLIST_FIXTURES = [
  // Two labelled groups, the second restarting at 1: Alt+1 must stay on the
  // first group's step 1 (checkbox-0), never the second's (checkbox-5).
  {
    file: "assignment_multiple_numbered_sections.html",
    total: 7,
    topLevel: 6,
    digits: ["checkbox-0", "checkbox-1", "checkbox-2", "checkbox-4", N, N, N, N, N],
  },
  // Nested bullets, two of which carry no checkbox at all.
  {
    file: "assignment_mixed_nested_section.html",
    total: 10,
    topLevel: 5,
    digits: ["checkbox-0", "checkbox-1", "checkbox-4", "checkbox-8", "checkbox-9", N, N, N, N],
  },
  // Six list items, three checkboxes: the plain <li> entries contribute none.
  {
    file: "assignment_non_checkbox_nested_section.html",
    total: 3,
    topLevel: 3,
    digits: ["checkbox-0", "checkbox-1", "checkbox-2", N, N, N, N, N, N],
  },
  // Six nesting levels but only two top-level steps, so Alt+3..Alt+9 have no
  // target even though the lesson shows plenty of numbered sub-steps.
  {
    file: "assignment_deep_nested_section.html",
    total: 33,
    topLevel: 2,
    digits: ["checkbox-0", "checkbox-1", N, N, N, N, N, N, N],
  },
  // The same Assignment surrounded by its sibling sections: the other three
  // sections hold no checkboxes, so the records must match the standalone
  // capture exactly.
  {
    file: "assignment_surrounding_details_context.html",
    total: 7,
    topLevel: 6,
    digits: ["checkbox-0", "checkbox-1", "checkbox-2", "checkbox-4", N, N, N, N, N],
  },
  // Guided project with no Assignment section — the checklist lives under
  // "_solve_r Method". Targeting must not depend on the heading text.
  {
    file: "project_non_assignment_section.html",
    total: 9,
    topLevel: 5,
    digits: ["checkbox-0", "checkbox-1", "checkbox-2", "checkbox-3", "checkbox-8", N, N, N, N],
  },
  // Every top-level <li> wraps its content in <p>, so each checkbox is a
  // grandchild of its item: the regression guard for the "nearest <li>" rule.
  {
    file: "project_non_assignment_paragraph_items.html",
    total: 9,
    topLevel: 9,
    digits: [
      "checkbox-0", "checkbox-1", "checkbox-2", "checkbox-3", "checkbox-4",
      "checkbox-5", "checkbox-6", "checkbox-7", "checkbox-8",
    ],
  },
  // Bulleted top level: clickable steps with no displayed number, so Alt+0 is
  // the only way to reach them.
  {
    file: "assignment_unordered_top_level_section.html",
    total: 3,
    topLevel: 3,
    digits: [N, N, N, N, N, N, N, N, N],
  },
  // Challenges list their steps with no <details> wrapper at all, which is why
  // the checklist is scoped to the lesson-text pane rather than to sections.
  {
    file: "challenge_unordered_checkbox_list.html",
    total: 4,
    topLevel: 4,
    digits: [N, N, N, N, N, N, N, N, N],
  },
  {
    file: "challenge_numbered_checkbox_list.html",
    total: 4,
    topLevel: 4,
    digits: ["checkbox-0", "checkbox-1", "checkbox-2", "checkbox-3", N, N, N, N, N],
  },
];

let checklistFixturesRun = 0;
for (const { file, total, topLevel, digits } of CHECKLIST_FIXTURES) {
  if (!existsSync(new URL(file, CAPTURES_V12))) continue;
  checklistFixturesRun += 1;
  const records = checklistRecordsFromCapture(file);

  check(`${file}: checkbox count`, records.length, total);
  check(`${file}: top-level count`, records.filter((r) => r.topLevel).length, topLevel);
  check(
    `${file}: Alt+1..Alt+9 targets`,
    digits.map((_, i) => selectNumberedTarget(records, i + 1)?.input ?? null),
    digits
  );
  // Every checkbox is reachable by repeated Alt+0, in document order, and the
  // walk stops instead of wrapping.
  check(
    `${file}: Alt+0 walks every box in order`,
    altZeroWalk(records),
    records.map((r) => r.input)
  );
}
if (!checklistFixturesRun) {
  console.log("note: v0.12.0 UI captures not present; skipped checklist fixture checks");
}
fixturesRun += checklistFixturesRun;

// -----------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures}/${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ok — ${checks} checks passed${fixturesRun ? ` (incl. ${fixturesRun} capture fixtures)` : ""}`);
