// assignmentShortcuts.js
// Keyboard shortcuts for a lesson's checklist steps (setting
// `assignmentShortcuts`, default OFF):
//   Alt+1 .. Alt+9  -> toggle the checkbox on the matching top-level step
//   Alt+0           -> check the first unfinished box anywhere in the checklist
//   Alt+`           -> focus back to the answer side (code editor / answer box)
//
// The keys form one contiguous row, and Alt+` is matched by position
// (`Backquote` is the key left of 1 on every layout) rather than by the
// character printed on it. Alt+0 out, Alt+` back: the round trip needs no
// stored state, and CodeMirror restores its own caret position on refocus
// (verified — see ui/dom/focus_target_probe.json).
//
// Nested steps are never interpreted. Once a shortcut focuses a checkbox the
// learner continues with native Tab / Shift+Tab / Space, which is why nothing
// here tries to model sub-step hierarchy, grouping headings, or list style.
//
// Everything is read at keypress time — route, sections, checkbox state — so
// nothing is cached, observed, or stored, and a rerender or SPA navigation can
// never serve a stale target. Boot.dev's own <input> is clicked, so its
// handlers stay authoritative.
//
// Scope is the lesson-text pane (#markdown-side), NOT "the Assignment
// section". Two rounds of evidence pushed it there: guided-project lessons put
// identical checklists under their own headings with no Assignment section at
// all, and challenges list their steps as a bare <ul>/<ol> with no <details>
// wrapper. The pane is a plain id shared by both page types, so one rule
// covers every layout, and only checkboxes inside a list item count. A
// collapsed <details> needs no special case: its contents have a zero-size box,
// which the visibility test already rejects.
//
// Capture phase, because bubble is too late: the Linux-course terminal writes
// the digit from its own keydown handler, and preventDefault after the fact
// can't unwrite it. Propagation is stopped only once a target is resolved.
//
// Two deliberate rejections, both about not breaking something else:
//   - Numpad digits are NOT matched. On Windows, Alt+numpad is the OS
//     character-code input method (Alt+0233 -> é); claiming those keystrokes in
//     the code editor would break it. Only the top-row Digit* codes match.
//   - No editable-target exclusion. Ticking a step off is exactly what a
//     learner wants while typing in the editor, a terminal, or an answer box,
//     and Boot.dev's own Ctrl+. works there too. The cost is documented: on Mac
//     layouts where Alt+digit types a character, this claims it.
//
// Evidence and design decisions: reference_data/catalyst_versions/
// v0.12.0_assignment_checkbox_shortcuts/implementation_plan.md

const ASSIGNMENT_SHORTCUT_FEATURE = "assignmentShortcuts";
// The lesson-text pane — a plain id, not a hashed class, and present on both
// lessons and challenges. It holds the checklist; everything the learner
// answers with lives outside it. The Boots chat textarea lives inside it, which
// is what keeps Alt+` from landing there.
const LESSON_TEXT_PANE_ID = "markdown-side";
// The common ancestor of both panes. <main> is not used here: it is confirmed
// to contain the lesson-text side, but not that it wraps the editor side.
const LESSON_CONTAINER_ID = "lesson-container";
const ANSWER_EDITOR_SELECTOR =
  '[role="textbox"][contenteditable=""], [role="textbox"][contenteditable="true"]';
// Types a learner can actually answer in. Checkboxes and buttons are excluded,
// so Alt+` can never land back on the checklist it just came from.
const ANSWER_INPUT_TYPES = new Set(["", "text", "url", "email", "search", "tel", "number", "password"]);

let assignmentShortcutKeydownHandler = null;

// ---------------------------------------------------------------------------
// Pure helpers (exercised by scripts/check_lesson_features.mjs)
// ---------------------------------------------------------------------------

// What a keydown asks for, or null. Matching is on event.code so Alt-modified
// characters and keyboard layouts don't matter (macOS Alt+3 types "£", AZERTY
// labels Digit1 as "&"); event.key is the fallback only when there is no code,
// which is also what keeps numpad presses — they always carry a Numpad* code —
// from matching.
//
// Requiring Alt alone matters twice over: AltGr reports ctrlKey+altKey, so
// international character entry can never trigger a shortcut, and auto-repeat
// asks for nothing new, so holding a key can't race through the checklist.
function matchAssignmentShortcut(event) {
  if (!event || event.repeat) return null;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;

  const code = typeof event.code === "string" ? event.code : "";
  let digit;
  if (code) {
    if (code === "Backquote") return { kind: "answer" };
    const match = /^Digit([0-9])$/.exec(code);
    if (!match) return null;
    digit = Number(match[1]);
  } else {
    const key = typeof event.key === "string" ? event.key : "";
    if (key === "`") return { kind: "answer" };
    if (!/^[0-9]$/.test(key)) return null;
    digit = Number(key);
  }

  return digit === 0 ? { kind: "next" } : { kind: "number", digit };
}

// The first top-level step showing this number. First-in-document-order is what
// makes repeated numbering behave: when a later group — or a later section —
// restarts at 1, Alt+1 keeps toggling the first one rather than cycling between
// them. A top-level step whose own checkbox is missing or unusable yields
// nothing — never a nested descendant.
function selectNumberedTarget(records, digit) {
  if (!Array.isArray(records)) return null;
  return records.find((r) => r && r.topLevel && r.usable && r.number === digit) || null;
}

// The first unfinished box in reading order, recomputed on every press — which
// is why repeated Alt+0 advances, and why unchecking something earlier makes it
// the next target again. No cursor, nothing to go stale.
function selectNextUncheckedTarget(records) {
  if (!Array.isArray(records)) return null;
  return records.find((r) => r && r.usable && !r.checked) || null;
}

// ---------------------------------------------------------------------------
// Page reading
// ---------------------------------------------------------------------------

// Where the checklist lives. The text pane is the answer on both page types —
// lessons wrap their steps in <details> sections inside it, challenges list
// them directly — so scoping to the pane covers both without modelling either.
//
// The fallback is deliberate: checkbox placement inside the pane is confirmed
// directly on challenges and inferred on lessons, so if the pane ever holds no
// checkboxes the whole lesson container is searched rather than the feature
// silently going quiet.
function findChecklistRoot() {
  const pane = document.getElementById(LESSON_TEXT_PANE_ID);
  if (pane?.querySelector('input[type="checkbox"]')) return pane;
  return document.getElementById(LESSON_CONTAINER_ID) || document.body || null;
}

// Displayed numbers for one ordered list's own items, honouring start= and
// value= so the number Catalyst matches is the number the learner sees. A
// reversed list is left unnumbered rather than modelled.
function collectListItemNumbers(list, numbers) {
  if (!list || list.tagName !== "OL" || list.hasAttribute("reversed")) return;

  const start = list.getAttribute("start");
  let n = start === null ? 1 : Number(start);
  if (!Number.isFinite(n)) n = 1;

  for (const child of list.children) {
    if (child.tagName !== "LI") continue;
    const explicit = child.getAttribute("value");
    if (explicit !== null && Number.isFinite(Number(explicit))) n = Number(explicit);
    numbers.set(child, n);
    n += 1;
  }
}

// Every checklist checkbox under the given root, in document order (which is
// visual order — verified against the captures through six levels of nesting).
//
// `topLevel` is the whole hierarchy model: the checkbox's *nearest* <li> has no
// <li> ancestor. That accepts a top-level step's own control wherever it sits
// inside the item — a direct child in most lessons, wrapped in a <p> in the
// guided projects — and rejects every descendant control, without inspecting
// nesting depth, list style, or the labelled groups between lists.
//
// A checkbox outside any list item is not a checklist step and is ignored.
function collectChecklistCheckboxes(root) {
  const records = [];
  if (!root) return records;

  const numbers = new Map(); // top-level <li> -> displayed number
  const numberedLists = new Set();

  for (const input of root.querySelectorAll('input[type="checkbox"]')) {
    const item = input.closest("li");
    if (!item || !root.contains(item)) continue;

    const topLevel = !item.parentElement?.closest("li");
    let number = null;
    if (topLevel) {
      const list = item.parentElement;
      if (list && !numberedLists.has(list)) {
        numberedLists.add(list);
        collectListItemNumbers(list, numbers);
      }
      number = numbers.has(item) ? numbers.get(item) : null;
    }

    records.push({
      input,
      topLevel,
      number,
      checked: Boolean(input.checked),
      // Hidden covers a collapsed <details>, display:none, and [hidden] in one
      // cheap read; the worst observed lesson has 33 boxes.
      usable: !input.disabled && isVisible(input),
    });
  }

  return records;
}

// Is this something the learner can be sent back to? Anything inside the
// lesson-text pane is not: that side is where the checklist and the Boots chat
// box live.
function isAnswerSideTarget(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.closest(`#${LESSON_TEXT_PANE_ID}`)) return false;
  return isVisible(el);
}

// Where Alt+` sends focus: the code editor on a code lesson, otherwise the
// lesson's own answer field (the repo-URL box on later guided-project steps).
// Null on lessons with no answer-side input at all, e.g. quizzes.
//
// The editor is looked for first rather than taking the first candidate in
// document order, so a console or terminal field can't win on a code lesson.
// A code lesson renders two role=textbox divs and only one has a box, so the
// visibility test is what picks the real editor.
function findAnswerTarget() {
  const scope = document.getElementById(LESSON_CONTAINER_ID) || document.body;
  if (!scope) return null;

  for (const el of scope.querySelectorAll(ANSWER_EDITOR_SELECTOR)) {
    if (isAnswerSideTarget(el)) return el;
  }
  for (const el of scope.querySelectorAll("textarea, input")) {
    if (el.tagName === "INPUT" &&
        !ANSWER_INPUT_TYPES.has(String(el.getAttribute("type") || "").toLowerCase())) continue;
    if (isAnswerSideTarget(el)) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shortcut handling
// ---------------------------------------------------------------------------

function handleAssignmentShortcutKeydown(event) {
  if (enhancerStopped || !isFeatureEnabled(ASSIGNMENT_SHORTCUT_FEATURE)) return;

  const shortcut = matchAssignmentShortcut(event);
  if (!shortcut) return;
  // The confirmation dialog owns the keyboard while it is open.
  if (document.getElementById(SUBMIT_CONFIRM_DIALOG_ID)) return;
  // Lessons and challenges both render a checklist and an answer side.
  if (!lessonOrChallengeUuidFromPath()) return;

  if (shortcut.kind === "answer") {
    const answer = findAnswerTarget();
    if (!answer) return;
    event.preventDefault();
    event.stopPropagation();
    // No click: focusing is the whole job, and CodeMirror restores its own
    // caret position from where the learner left it.
    answer.focus();
    return;
  }

  const root = findChecklistRoot();
  if (!root) return;

  const records = collectChecklistCheckboxes(root);
  const target = shortcut.kind === "next"
    ? selectNextUncheckedTarget(records)
    : selectNumberedTarget(records, shortcut.digit);
  // No step with that number, or nothing left unchecked: leave the key alone,
  // so an unmatched Alt+7 behaves exactly as it would without Catalyst.
  if (!target) return;

  event.preventDefault();
  // Only now, and only for a key we're acting on: keep the editor and the
  // course terminal from also treating this keystroke as input.
  event.stopPropagation();
  // Focus first, then click: the order a pointer produces (mousedown, focus,
  // click), and it leaves the learner on the control for Tab / Space even if
  // the page ignores the click.
  target.input.focus();
  target.input.click();
}

function bindAssignmentShortcuts() {
  if (assignmentShortcutKeydownHandler) return;
  assignmentShortcutKeydownHandler = (event) => {
    try {
      handleAssignmentShortcutKeydown(event);
    } catch (err) {
      handleAsyncError(err, "assignmentShortcuts");
    }
  };
  document.addEventListener("keydown", assignmentShortcutKeydownHandler, true);
}

// Called from stopEnhancer so the listener doesn't outlive an invalidated context.
function unbindAssignmentShortcuts() {
  if (!assignmentShortcutKeydownHandler) return;
  document.removeEventListener("keydown", assignmentShortcutKeydownHandler, true);
  assignmentShortcutKeydownHandler = null;
}

// Test hook: scripts/check_lesson_features.mjs predefines this global before
// evaluating the file. Never defined on the real page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.assignmentShortcuts = {
    matchAssignmentShortcut,
    selectNumberedTarget,
    selectNextUncheckedTarget,
  };
}
