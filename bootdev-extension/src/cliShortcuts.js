// cliShortcuts.js
// Keyboard copy for the bootdev CLI commands a lesson displays:
//   Alt+C        -> bootdev run <lesson-uuid>
//   Alt+Shift+C  -> bootdev run <lesson-uuid> -s
// Shift means submit, mirroring Boot.dev's own ctrl+enter / ctrl+shift+enter.
//
// Everything is read at keypress time — the route UUID and the displayed
// commands — so nothing is cached, observed, or stored, and a rerender or SPA
// navigation can never serve a stale command.
//
// Capability comes from what the page actually renders: a lesson that shows only
// the -s command (Boot.dev's newer "safe submission" lessons) has no run command
// to copy, and Catalyst never derives one by editing the submit command.
//
// Evidence and design decisions: reference_data/catalyst_versions/
// v0.11.0_submit_confirmation_and_cli_shortcuts/implementation_plan.md

const CLI_SHORTCUT_FEATURE = "cliShortcuts";
// A displayed command is ~55 chars; anything longer is a container element that
// happens to contain one, not the command's own leaf.
const CLI_COMMAND_MAX_LEN = 120;

let cliShortcutKeydownHandler = null;

// ---------------------------------------------------------------------------
// Pure helpers (exercised by scripts/check_lesson_features.mjs)
// ---------------------------------------------------------------------------

// Which command a keydown asks for, or null. Matching is on event.code so
// layout and Alt-modified characters don't matter (macOS Alt+C types "ç"),
// with event.key as the fallback for layouts where the "c" key is elsewhere.
//
// Auto-repeat asks for nothing new: one press is one copy and one toast, no
// matter how long the key is held. Releasing C and pressing it again is a fresh
// keydown, so it copies again — including when Shift was added mid-hold, which
// is why pressing Shift alone does nothing until C is re-pressed.
function matchCliShortcut(event) {
  if (!event || event.repeat) return null;
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  const code = typeof event.code === "string" ? event.code : "";
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  if (code !== "KeyC" && key !== "c") return null;
  return event.shiftKey ? "submit" : "run";
}

// "run" / "submit" / null for a displayed line, validated against the route
// UUID so a command shown for some other lesson can never be copied. Unknown
// flag combinations classify as null: better to copy nothing than the wrong
// thing.
function classifyBootdevCommand(text, uuid) {
  if (!uuid) return null;
  const match = /^bootdev\s+run\s+([0-9a-f-]{36})\s*(.*)$/i.exec(normalizeText(text));
  if (!match || match[1].toLowerCase() !== String(uuid).toLowerCase()) return null;

  const flags = match[2] ? match[2].split(/\s+/).filter(Boolean) : [];
  if (!flags.length) return "run";
  return flags.includes("-s") ? "submit" : null;
}

// ---------------------------------------------------------------------------
// Page reading
// ---------------------------------------------------------------------------

// The commands this lesson currently displays. Text landmarks only — the copy
// button's aria-label and the Run/Submit headings are context that may change,
// while the command text plus the route UUID is self-verifying.
function findCliCommands(uuid) {
  const found = { run: null, submit: null };
  const root = document.querySelector("main") || document.body;
  if (!uuid || !root) return found;

  for (const el of root.querySelectorAll("p, code, pre, span, div")) {
    const text = normalizeText(el.textContent);
    if (!text || text.length > CLI_COMMAND_MAX_LEN) continue;
    const kind = classifyBootdevCommand(text, uuid);
    if (kind && !found[kind]) found[kind] = text;
    if (found.run && found.submit) break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Shortcut handling
// ---------------------------------------------------------------------------

function handleCliShortcutKeydown(event) {
  if (enhancerStopped || !isFeatureEnabled(CLI_SHORTCUT_FEATURE)) return;

  const kind = matchCliShortcut(event);
  if (!kind) return;
  // Focus is deliberately not consulted: copying the lesson's command is just
  // as useful mid-edit, and Boot.dev's own shortcuts work while typing too.
  // Ordinary Ctrl+C is untouched either way — this needs Alt.
  // The confirmation dialog owns the keyboard while it is open.
  if (document.getElementById(SUBMIT_CONFIRM_DIALOG_ID)) return;

  const uuid = lessonUuidFromPath();
  if (!uuid) return;

  const commands = findCliCommands(uuid);
  // No CLI commands on this lesson at all: stay silent and leave the clipboard
  // alone — the keypress was meant for something else.
  if (!commands.run && !commands.submit) return;

  event.preventDefault();

  const command = commands[kind];
  if (!command) {
    // Submit-only lesson + run shortcut: say why nothing happened rather than
    // inventing a command the lesson doesn't support.
    toast(
      kind === "run" ? "This lesson has no run command." : "This lesson has no submit command.",
      { durationMs: 3000 }
    );
    return;
  }

  copyCliCommand(command, kind);
}

function copyCliCommand(command, kind) {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    toast("Copy failed — this browser blocked clipboard access.", { durationMs: 4000 });
    return;
  }

  clipboard.writeText(command).then(
    () => toast(kind === "run" ? "Run command copied." : "Submit command copied.", { durationMs: 2500 }),
    (err) => {
      console.debug("[catalyst] clipboard write failed", safeErrorMessage(err));
      toast("Copy failed — click the page and try again.", { durationMs: 4000 });
    }
  );
}

function bindCliShortcuts() {
  if (cliShortcutKeydownHandler) return;
  cliShortcutKeydownHandler = (event) => {
    try {
      handleCliShortcutKeydown(event);
    } catch (err) {
      handleAsyncError(err, "cliShortcuts");
    }
  };
  document.addEventListener("keydown", cliShortcutKeydownHandler);
}

// Called from stopEnhancer so the listener doesn't outlive an invalidated context.
function unbindCliShortcuts() {
  if (!cliShortcutKeydownHandler) return;
  document.removeEventListener("keydown", cliShortcutKeydownHandler);
  cliShortcutKeydownHandler = null;
}

// Test hook: scripts/check_lesson_features.mjs predefines this global before
// evaluating the file. Never defined on the real page.
if (typeof window !== "undefined" && window.__BOOTDEV_ENHANCER_TEST__) {
  window.__BOOTDEV_ENHANCER_TEST__.cliShortcuts = { matchCliShortcut, classifyBootdevCommand };
}
