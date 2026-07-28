// assignmentShortcuts.js
// Keyboard shortcuts for a lesson's checklist steps (setting
// `assignmentShortcuts`, default OFF):
//   Alt+1 .. Alt+9  -> toggle the checkbox on the matching top-level step
//   Alt+0           -> check the first unfinished box anywhere in the checklist
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
// Scope is "checkbox steps in the lesson's content sections", NOT "the
// Assignment section": guided-project lessons put identical checklists under
// their own headings (`_solve_r Method`, `How Does PostgreSQL Work?`) with no
// Assignment section at all. A section is an open, visible, outermost <details>
// whose own <summary> holds a heading — the shape every lesson-content section
// uses — and only checkboxes inside a list item count. That keeps the search
// well away from page furniture without depending on any one heading's text.
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
const CHECKLIST_HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

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
    const match = /^Digit([0-9])$/.exec(code);
    if (!match) return null;
    digit = Number(match[1]);
  } else {
    const key = typeof event.key === "string" ? event.key : "";
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

// The lesson's content sections, in document order. Boot.dev gives them no id,
// data-*, or aria-* hook, so the shape is the landmark: <details> + own
// <summary> + a heading inside it. Collapsed sections are skipped rather than
// opened — running a shortcut shouldn't change the page's layout — and nested
// <details> are left to their outermost ancestor so nothing is counted twice.
function findChecklistSections() {
  const scope = document.querySelector("main") || document.body;
  if (!scope) return [];

  const sections = [];
  for (const details of scope.querySelectorAll("details")) {
    if (!details.open) continue;
    if (details.parentElement?.closest("details")) continue;
    const summary = details.querySelector(":scope > summary");
    if (!summary?.querySelector(CHECKLIST_HEADING_SELECTOR)) continue;
    if (!isVisible(details)) continue;
    sections.push(details);
  }
  return sections;
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

// Every checklist checkbox in the given sections, in document order (which is
// visual order — verified against the captures through six levels of nesting).
//
// `topLevel` is the whole hierarchy model: the checkbox's *nearest* <li> has no
// <li> ancestor. That accepts a top-level step's own control wherever it sits
// inside the item — a direct child in most lessons, wrapped in a <p> in the
// guided projects — and rejects every descendant control, without inspecting
// nesting depth, list style, or the labelled groups between lists.
//
// A checkbox outside any list item is not a checklist step and is ignored.
function collectChecklistCheckboxes(sections) {
  const records = [];
  if (!Array.isArray(sections)) return records;

  const numbers = new Map(); // top-level <li> -> displayed number
  const numberedLists = new Set();

  for (const section of sections) {
    for (const input of section.querySelectorAll('input[type="checkbox"]')) {
      const item = input.closest("li");
      if (!item || !section.contains(item)) continue;

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
        // Hidden covers a collapsed nested <details>, display:none, and
        // [hidden] in one cheap read; the worst observed lesson has 33 boxes.
        usable: !input.disabled && isVisible(input),
      });
    }
  }

  return records;
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
  if (!lessonUuidFromPath()) return;

  const sections = findChecklistSections();
  // Nothing checklist-shaped on this lesson: the keypress was meant for
  // something else. Never widen the search to the rest of the page.
  if (!sections.length) return;

  const records = collectChecklistCheckboxes(sections);
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
